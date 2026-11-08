import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { build_secrets_report, write_secrets_report } from '../../../src/core/reconcile/secrets-report';
import { scan_secrets } from '../../../src/core/reconcile/triage';
import { load_plugin_config } from '../../../src/utils/config';

// Secret-shaped strings are built at runtime so the repo holds no scannable literal.
const rnd = (n: number, seed: number) => { let x = seed; let s = ''; const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += a[x % a.length]; } return s; };
const old = 'hv' + 's.' + rnd(24, 3);
const fresh = 'hv' + 's.' + rnd(24, 9);

let root: string, docs: string;
const g = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' }).trim();
const doc = (body: string) => `---\ntitle: a\ndomains:\n  - backend\n---\n\n# a\n\n${body}\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sreport-'));
  docs = join(root, '.documentation');
  mkdirSync(join(docs, 'backend'), { recursive: true });
  writeFileSync(join(docs, 'backend/a.md'), doc(`token ${old}`));
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
  // b.md is only on disk, never committed
  writeFileSync(join(docs, 'backend/b.md'), doc(`token ${fresh}\nmail jane.doe@acme-corp.io`));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('secrets report', () => {
  it('flags history per finding, lists personal data apart, and holds no value', async () => {
    const config = await load_plugin_config(root);
    const findings = await scan_secrets({ root, docs_path: docs, config });
    const r = await build_secrets_report({ root, docs_path: docs, findings, secrets_config: config.reconcile.secrets, date: '2026-11-07' });
    const a = r.entries.find((e) => e.file === 'backend/a.md')!;
    const b = r.entries.find((e) => e.file === 'backend/b.md' && e.kind === 'secret')!;
    expect(a.in_history).toBe(true);
    expect(b.in_history).toBe(false);
    expect(r.text).toContain('in git history: yes');
    expect(r.text).toContain('in git history: no');
    expect(r.text).toContain('Rotate or revoke');
    expect(r.text).toContain('## Personal data, review only (1)');
    expect(r.entries.some((e) => e.kind === 'personal' && e.env)).toBe(false);
    for (const v of [old, fresh, 'jane.doe@acme-corp.io']) expect(r.text).not.toContain(v);
    const f = await write_secrets_report(root, r.text, '2026-11-07');
    expect(f.endsWith('.hewtd/reconcile/secrets-report-2026-11-07.md')).toBe(true);
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, 'utf-8')).not.toContain(old);
  });

  it('reports moved values from the ledger by env name', async () => {
    const config = await load_plugin_config(root);
    writeFileSync(join(root, '.env.hewtd'), `HEWTD_SECRET_A=${old}\n`);
    const ledger = { version: 1 as const, entries: { 'backend/a.md': { path: 'backend/a.md', lane: 'clean', content_hash: 'x', env_names: ['HEWTD_SECRET_A'] } } };
    const r = await build_secrets_report({ root, docs_path: docs, findings: [], ledger, secrets_config: config.reconcile.secrets });
    expect(r.entries[0]).toMatchObject({ status: 'moved', env: 'HEWTD_SECRET_A', in_history: true });
    expect(r.text).toContain('status: moved (HEWTD_SECRET_A)');
    expect(r.text).not.toContain(old);
  });
});
