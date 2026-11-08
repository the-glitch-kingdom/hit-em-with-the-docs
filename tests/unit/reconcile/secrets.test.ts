import { describe, it, expect } from 'vitest';
import { scanText, findSecrets, fingerprint, mask } from '../../../src/core/reconcile/secrets';
import { loadPluginConfig } from '../../../src/utils/config';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Secret-shaped strings are assembled at runtime so the repo never holds a scannable literal.
const rnd = (n: number, seed = 7) => { let x = seed; let s = ''; const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += a[x % a.length]; } return s; };
const hvs = 'hv' + 's.' + rnd(24);
const stripe = 'sk' + '_live_' + rnd(24, 3);
const uuid = ['3f2a9c1e', '7b4d', '4e8a', '9c1d', '5a6b7c8d9e0f'].join('-');
const pem = ['-----BEGIN RSA PRIV', 'ATE KEY-----'].join('') + '\n' + rnd(64, 5) + '\n' + ['-----END RSA PRIV', 'ATE KEY-----'].join('');
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = [b64({ alg: 'HS256', typ: 'JWT' }), b64({ sub: 'u1' }), rnd(20, 9)].join('.');
const cfg = { allow: [], disabled_rules: [] } as Parameters<typeof scanText>[2];
const scan = (t: string, c = cfg) => scanText(t, 'doc.md', c);

describe('scanText', () => {
  it.each([
    ['vault token', `token ${hvs}`, 'vault-token'],
    ['approle secret id', `VAULT_SECRET_ID=${uuid}`, 'generic-secret'],
    ['stripe live key', `key: ${stripe}`, 'stripe-key'],
    ['private key block', pem, 'private-key'],
    ['jwt', `Authorization: Bearer ${jwt}`, 'jwt'],
    ['url password', 'postgres://app:S3cr3t' + 'P4ss@db/x', 'url-password'],
  ])('flags %s', (_n, text, rule) => {
    const f = scan(text);
    expect(f.map((x) => x.rule)).toContain(rule);
  });

  it.each([
    'API_KEY=YOUR_API_KEY_HERE', 'password=changeme', 'DB_PASSWORD=${DB_PASSWORD}', 'TOKEN=$TOKEN',
    'postgres://user:password@localhost/db', 'postgres://postgres:postgres@localhost/db',
    'pk' + '_live_' + rnd(24), 'SECRET_KEY=/etc/secrets/key.pem', 'API_TOKEN=https://api.internal.dev/v1/things',
    'TOKEN=xxxxxxxxxxxxxxxxxxxx', '-----BEGIN PRIVATE KEY-----', 'contact me@example.com',
    'x@noreply.github.com', 'hvs.XXXXXXXXXXXXXXXXXXXXXXXX',
  ])('ignores %s', (text) => expect(scan(text)).toEqual([]));

  it('flags personal emails as kind personal', () => {
    expect(scan('mail ann@corp.io')).toMatchObject([{ rule: 'email', kind: 'personal' }]);
  });

  it('allowlist by fingerprint and by pattern; entries need a reason', () => {
    expect(scan(`t ${hvs}`, { allow: [{ fingerprint: fingerprint(hvs), reason: 'fixture' }], disabled_rules: [] })).toEqual([]);
    expect(scan(`t ${hvs}`, { allow: [{ pattern: '^hvs\\.', file: 'doc.md', reason: 'fixture' }], disabled_rules: [] })).toEqual([]);
    expect(scan(`t ${hvs}`, { allow: [{ fingerprint: fingerprint(hvs), file: 'other/**', reason: 'x' }], disabled_rules: [] })).toHaveLength(1);
  });

  it('disabled_rules turns a rule off', () => {
    expect(scan(`t ${hvs}`, { allow: [], disabled_rules: ['vault-token'] })).toEqual([]);
  });

  it('reports line and col, and a finding never holds the value', () => {
    const [f] = scan(`a\nb token ${hvs} z`);
    expect(f).toMatchObject({ line: 2, col: 9, length: hvs.length, masked: mask(hvs), fingerprint: fingerprint(hvs) });
    expect(f.masked.replace('…', '').startsWith(hvs.slice(0, 4))).toBe(true);
    expect(JSON.stringify(f)).not.toContain(hvs.slice(5));
    expect(findSecrets(`t ${hvs}`, 'd', cfg)[0].value).toBe(hvs);
  });

  it('a token inside NAME=value is reported once', () => {
    expect(scan(`VAULT_TOKEN=${hvs}`)).toHaveLength(1);
  });
});

describe('config', () => {
  it('parses reconcile.secrets leniently and drops allow entries without a reason', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hewtd-sec-'));
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude/hit-em-with-the-docs.json'), JSON.stringify({
      reconcile: { secrets: { allow: [{ fingerprint: 'a', reason: 'ok' }, { fingerprint: 'b' }, 5], disabled_rules: ['email'] } },
    }));
    const c = await loadPluginConfig(root);
    expect(c.reconcile.secrets).toEqual({ allow: [{ fingerprint: 'a', pattern: undefined, file: undefined, reason: 'ok' }], disabled_rules: ['email'] });
  });
});

describe('review fixes (#59)', () => {
  it('stays linear on long single-line input (no catastrophic backtracking)', () => {
    for (const text of ['a-'.repeat(40000), 'a.token'.repeat(20000), 'x://' + 'a'.repeat(50000), 'a.'.repeat(40000)]) {
      const t0 = performance.now();
      scan(text);
      expect(performance.now() - t0).toBeLessThan(1500);
    }
  });

  it('flags every non-trivial AppRole uuid, whatever its entropy', () => {
    let x = 12345;
    const hex = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return ((x >> 16) % 16).toString(16); };
    const id = () => [8, 4, 4, 4, 12].map((n) => Array.from({ length: n }, hex).join('')).join('-');
    for (let i = 0; i < 2000; i++) {
      const u = id();
      expect(scan(`VAULT_SECRET_ID=${u}`).length, u).toBe(1);
      expect(scan(`secret_id: "${u}"`).length, u).toBe(1);
    }
    expect(scan('ROLE_ID=00000000-0000-0000-0000-000000000000')).toEqual([]);
  });

  it('allowlist accepts the 12-char fingerprint prefix shown in reports', () => {
    const fp = fingerprint(hvs);
    expect(scan(`t ${hvs}`, { allow: [{ fingerprint: fp.slice(0, 12), reason: 'fixture' }], disabled_rules: [] })).toEqual([]);
    expect(scan(`t ${hvs}`, { allow: [{ fingerprint: fp.slice(0, 8), reason: 'too short' }], disabled_rules: [] })).toHaveLength(1);
  });
});

describe('field test 69: false positives and recall', () => {
  const real = rnd(32, 11);
  it.each([
    'self.vault_token_cache = x', 'VAULT_TOKEN = settings.VAULT_TOKEN_PATH', 'password = f"{db_password}"',
    'secret = os.environ.get("X")', 'TOKEN = process.env.API_TOKEN', 'token = getToken(a)',
    'secret_id = <VAULT_APPROLE_SECRET_ID from Vault: kv/app>', '<secret: NAME, see .env.hewtd>',
    'ADMIN_PASSWORD = "admin@company-internal.io"',
  ])('ignores %s', (t) => expect(scan(t).filter((f) => f.kind === 'secret')).toEqual([]));

  it('still flags a real literal under the same key names; email stays personal', () => {
    expect(scan(`VAULT_TOKEN = "${real}"`).map((f) => f.rule)).toEqual(['generic-secret']);
    expect(scan(`ADMIN_PASSWORD = "admin@corp.io"`).map((f) => f.kind)).toEqual(['personal']);
  });

  it.each([
    ['short hvs', 'hv' + 's.' + 'q7Zr3LmP9xVb2NcK'],
    ['role-id flag', `vault write auth/approle/login --role-id ${uuid}`],
    ['Role ID label', `Role ID: ${uuid}`],
    ['secret id under plain key', `Secret ID = ${uuid}`],
    ['kv put value', `vault kv put secret/app value=${real}`],
  ])('flags %s', (_n, t) => expect(scan(t).length).toBe(1));

  it.each([
    'vault kv put secret/app value=<VALUE>', 'vault kv put secret/app value=$VALUE_FROM_ENV_VAR_X', '--role-id $ROLE_ID',
    'vault write auth/x path=/etc/some/long/file/path.pem', 'hv' + 's.' + 'a'.repeat(16),
  ])('ignores %s', (t) => expect(scan(t)).toEqual([]));

  it('new rules stay linear on long lines', () => {
    for (const text of ['vault kv put ' + 'a=b '.repeat(20000), 'vault write ' + 'k='.repeat(30000), '--role-id '.repeat(20000), 'hvs.' + 'a'.repeat(60000)]) {
      const t0 = performance.now();
      scan(text);
      expect(performance.now() - t0).toBeLessThan(1500);
    }
  });
});

describe('review fixes (#69): exemptions never hide a credential', () => {
  const r = rnd(20, 11), s = rnd(17, 13);
  const kinds = (t: string) => scan(t).map((f) => `${f.rule}/${f.kind}`);
  it('a random value is still a secret when it contains a dot, a call paren, a {slot} or starts with <', () => {
    for (const line of [
      `api_key = "${r}.${s}"`, `SECRET_KEY=${r.slice(0, 10)}.${s}`, `DB_PASSWORD=${r.slice(0, 8)}(${s}`,
      `client_secret: ${r.slice(0, 10)}{x}${s}`, `password = "<${r}"`, `token: "{${r}}"`,
    ]) expect(kinds(line), line).toContain('generic-secret/secret');
  });
  it('an email-shaped value with a random part is still a secret', () => {
    for (const line of [`password=${r}@${s.slice(0, 5)}.com`, `password=admin@${r}.com`]) expect(kinds(line), line).toContain('generic-secret/secret');
  });
  it('word-made code, pointer records and plain emails stay exempt', () => {
    for (const line of [
      'token = self.vault_token_for_service_accounts', 'VAULT_TOKEN = settings.VAULT_TOKEN_FROM_ENVIRONMENT',
      'secret = get_client_secret_value(', 'password_template: {db_password_value}{suffix_value}',
      'VAULT_SECRET_ID=<VAULT_APPROLE_SECRET_ID from Vault: secret/app/prod>', 'ADMIN_PASSWORD = "admin@company-internal.io"',
    ]) expect(kinds(line).filter((k) => k.endsWith('/secret')), line).toEqual([]);
  });
});
