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
