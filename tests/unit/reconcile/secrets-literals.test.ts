import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { scan_text } from '../../../src/core/reconcile/secrets';
import { load_plugin_config } from '../../../src/utils/config';
import { triage_docs } from '../../../src/core/reconcile/triage';

// Secret-shaped strings are built at runtime so the repo never holds a scannable literal.
const rnd = (n: number, seed = 7) => { let x = seed; let s = ''; const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += a[x % a.length]; } return s; };
const cfg = { allow: [], disabled_rules: [] } as Parameters<typeof scan_text>[2];
const rules = (text: string) => scan_text(text, 'doc.md', cfg).map((f) => f.rule);

describe('generic-secret reports literals only (#74)', () => {
  it.each([
    'const t = req.headers.authorization?.split(" ")[1];', 'password = hash(password)', 'token = this.token', 'API_KEY = settings.API_KEY',
    'code = [code-from-the-authenticator-app]', 'token = <your-token-here>', 'token = ${{ secrets.NAME }}', 'password = $(cat /run/pw)', 'password = %(db_pass)s',
    'pattern = .*/AKIA[0-9A-Z]{16}/.*', 'key = ^[A-Za-z0-9]{20,}$', 'password = abc123def456ghi7', 'token = 1234567890_example_key', 'secret = Qwerty_your_api_key',
    'password = abcdef123456789',
  ])('ignores %s', (text) => expect(rules(text)).not.toContain('generic-secret'));

  it.each(['j.smith2@corp-01.io', 'ops-team@acme2go.com', 'JaneDoe1987@gmail.com'])('%s under a secret key is an email', (mail) => {
    expect(scan_text(`API_KEY = ${mail}`, 'doc.md', cfg)).toMatchObject([{ rule: 'email', kind: 'personal' }]);
  });

  it('a random-looking email part stays a secret', () => {
    expect(rules(`API_KEY = ${rnd(20)}@x.com`)).toContain('generic-secret');
    expect(rules(`API_KEY = admin@${rnd(20)}.com`)).toContain('generic-secret');
  });

  it('real literals are still found', () => {
    expect(rules(`API_KEY = ${rnd(24, 11)}`)).toContain('generic-secret');
    expect(rules(`API_KEY = abc.${rnd(24, 12)}`)).toContain('generic-secret');
    expect(rules(`API_KEY = ${rnd(12, 13)}.${rnd(24, 14)}`)).toContain('generic-secret');
    expect(rules('t hv' + 's.' + rnd(24))).toContain('vault-token');
    expect(rules('k ' + 'sk' + '_live_' + rnd(24, 3))).toContain('stripe-key');
    expect(rules('k ' + 'AK' + 'IA' + rnd(16, 4).toUpperCase())).toContain('aws-access-key-id');
    expect(rules('vault login role id ' + ['3f2a9c1e', '7b4d', '4e8a', '9c1d', '5a6b7c8d9e0f'].join('-'))).toContain('approle-id');
  });
});

describe('triage with email-only findings (#74)', () => {
  it('a doc whose only findings are emails under secret-named keys is not in the secret lane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-'));
    try {
      const docs = join(dir, '.documentation');
      mkdirSync(join(docs, 'ops'), { recursive: true });
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
      writeFileSync(join(docs, 'ops/mail.md'), '---\ntitle: T\npurpose: Lists the people to contact when the nightly job fails twice\nsources: [src/a.ts]\nlast_verified: 2026-01-01\n---\nSee `src/a.ts`. API_KEY = j.smith2@corp-01.io, ADMIN_PASSWORD = JaneDoe1987@gmail.com\n');
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: dir });
      const r = await triage_docs({ root: dir, docs_root: docs, rels: ['ops/mail.md'], config: await load_plugin_config(dir) });
      expect(r.docs[0]!.lane).not.toBe('secret');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
