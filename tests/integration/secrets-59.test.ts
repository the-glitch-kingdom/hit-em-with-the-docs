import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createHash } from 'crypto';

// #59 acceptance, end to end through the built CLI. Every secret-shaped value is built at runtime.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const rnd = (n: number, seed: number) => { let x = seed; let s = ''; const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += a[(x >> 8) % a.length]; } return s; };
const V = { main: 'hv' + 's.' + rnd(24, 3), cited: 'hv' + 's.' + rnd(24, 5), arch: 'hv' + 's.' + rnd(24, 7), out: 'hv' + 's.' + rnd(24, 9), allowed: 'hv' + 's.' + rnd(24, 13), key: 'AK' + 'IA' + rnd(16, 17).toUpperCase() };
const cfg = (allow: unknown[] = []) => JSON.stringify({ reconcile: { secrets: { allow }, team: { docs_per_agent: 3, min_bytes: 1 } } });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let root: string;
const g = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const fm = (t: string, body: string) => `---\ntitle: ${t}\ndomains:\n  - backend\n---\n\n# ${t}\n\n${body}\n`;
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name === '.git' ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
/** Every file in the tree except the one place values are meant to live. */
const leaks = (vals: string[], skip: string[] = []) => walk(root).filter((f) => !skip.includes(f.slice(root.length + 1))).flatMap((f) => { const t = readFileSync(f, 'utf-8'); return vals.filter((v) => t.includes(v)).map((v) => `${f.slice(root.length + 1)}`); });
const accept = (file: string) => writeFileSync(file, readFileSync(file, 'utf-8').replace(/- \[ \] accept/g, '- [x] accept'));
const review_files = () => readdirSync(join(root, '.hewtd/reconcile')).filter((f) => /^review-.*\.md$/.test(f)).map((f) => join(root, '.hewtd/reconcile', f));

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'secrets59-'));
  put('src/real.ts', 'export const a = 1;\n');
  put('src/creds.ts', `export const k = '${V.key}';\n`);
  put('.documentation/backend/main.md', fm('main', `See \`src/gone.ts\`.\n\nVAULT_TOKEN=${V.main}`));
  put('.documentation/backend/cites.md', fm('cites', 'See `src/creds.ts` and `src/gone.ts`.'));
  for (let i = 0; i < 6; i++) put(`.documentation/backend/d${i}.md`, fm(`d${i}`, 'See `src/real.ts` and `src/gone.ts`.'));
  put('.documentation/archive/old.md', fm('old', `token ${V.arch}`));
  put('notes/loose.md', `# loose\n\ntoken ${V.out}\n`);
  put('.gitignore', '.hewtd/\n');
  put('.claude/hit-em-with-the-docs.json', cfg());
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('#59 secrets through the built CLI', () => {
  it('secret lane, no shard, blocked cited file, no values in --json or the report', () => {
    const r = hewtd(['reconcile', 'backend', '--team', '--json']);
    const out = JSON.parse(r.stdout);
    const lane = (p: string) => out.docs.find((d: { path: string }) => d.path === p);
    expect(lane('backend/main.md').lane).toBe('secret');
    expect(lane('backend/cites.md').lane).toBe('secret');
    expect(lane('backend/cites.md').blocked_files).toEqual(['src/creds.ts']);
    expect(out.mode).toBe('team');
    expect(out.shards.length).toBeGreaterThanOrEqual(2);
    const shard_text = JSON.stringify(out.shards);
    expect(shard_text).not.toContain('main.md');
    expect(shard_text).not.toContain('cites.md');
    expect(shard_text).not.toContain('creds.ts');
    expect(r.stdout + r.stderr).not.toContain(V.main);
    expect(r.stdout + r.stderr).not.toContain(V.key);

    const w = hewtd(['reconcile', 'backend', '--team', '--write-review']);
    expect(w.status).toBe(0);
    expect(leaks(Object.values(V), ['src/creds.ts', '.documentation/backend/main.md', '.documentation/archive/old.md', 'notes/loose.md'])).toEqual([]);
  });

  it('--secrets covers archive/ and the outside lane, masked, and reports steps', () => {
    const r = hewtd(['reconcile', '--secrets']);
    expect(r.status).toBe(0);
    for (const f of ['archive/old.md', 'notes/loose.md', 'backend/main.md']) expect(r.stdout).toContain(f);
    expect(r.stdout).toContain('hvs.…28');
    expect(r.stdout + r.stderr).not.toMatch(new RegExp(Object.values(V).join('|')));
    const j = JSON.parse(hewtd(['reconcile', '--secrets', '--json']).stdout) as { rule: string; file: string }[];
    expect(j.map((f) => f.file)).toEqual(expect.arrayContaining(['.documentation/archive/old.md', 'notes/loose.md']));
    const rep = readdirSync(join(root, '.hewtd/reconcile')).find((f) => f.startsWith('secrets-report-'))!;
    const text = readFileSync(join(root, '.hewtd/reconcile', rep), 'utf-8');
    expect(text).toMatch(/rotate/i);
    expect(text).toMatch(/purge|filter-repo/i);
    for (const v of Object.values(V)) expect(text).not.toContain(v);
  });

  it('placeholders and allowlisted values produce no findings', () => {
    put('.documentation/backend/ph.md', fm('ph', 'API_KEY=YOUR_KEY\nPASSWORD=changeme\nTOKEN=${VAULT_TOKEN}\nSECRET=<your-secret>'));
    put('.documentation/backend/al.md', fm('al', `ALLOWED=${V.allowed}`));
    put('.claude/hit-em-with-the-docs.json', cfg([{ fingerprint: sha(V.allowed), reason: 'fixture' }]));
    g('add', '-A'); g('commit', '-qm', 'more');
    const j = JSON.parse(hewtd(['reconcile', '--secrets', '--json']).stdout) as { file: string }[];
    expect(j.filter((f) => /backend\/(ph|al)\.md/.test(f.file))).toEqual([]);
  });

  it('secret verdict: doc keeps only a pointer, .env.hewtd is 0600 and ignored, nothing leaks, history clean', () => {
    expect(hewtd(['reconcile', 'backend/main.md', '--write-review']).status).toBe(0);
    const [file] = review_files();
    expect(readFileSync(file!, 'utf-8')).not.toContain(V.main);
    accept(file!);
    const before = g('rev-parse', 'HEAD');
    const a = hewtd(['reconcile', '--apply', file!]);
    expect(a.status).toBe(0);
    expect(a.stdout + a.stderr).not.toContain(V.main);
    const doc = readFileSync(join(root, '.documentation/backend/main.md'), 'utf-8');
    expect(doc).not.toContain(V.main);
    expect(doc).toMatch(/<secret: HEWTD_SECRET_VAULT_TOKEN, see \.env\.hewtd>/);
    const env = join(root, '.env.hewtd');
    expect(readFileSync(env, 'utf-8')).toContain(V.main);
    expect(statSync(env).mode & 0o777).toBe(0o600);
    expect(g('check-ignore', '.env.hewtd')).toBe('.env.hewtd');
    expect(g('rev-parse', 'HEAD')).not.toBe(before);
    expect(g('ls-files')).not.toContain('.env.hewtd');
    // The seed commit holds the value (history); reconcile's own commits may remove it but never add it.
    expect(g('log', '-p', `${before}..HEAD`).split('\n').filter((l) => l.startsWith('+') && l.includes(V.main))).toEqual([]);
    expect(leaks([V.main], ['.env.hewtd', '.documentation/backend/main.md'])).toEqual([]);
    const rep = readdirSync(join(root, '.hewtd/reconcile')).filter((f) => f.startsWith('secrets-report-'));
    expect(rep.length).toBe(1);
    const text = readFileSync(join(root, '.hewtd/reconcile', rep[0]!), 'utf-8');
    expect(text).toMatch(/rotate/i);
    expect(text).toMatch(/moved/i);
    expect(text).toMatch(/purge|filter-repo/i);
    expect(text).not.toContain(V.main);
  });

  it('rollback: a failing commit restores the doc and leaves no .env.hewtd', () => {
    put('.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n');
    chmodSync(join(root, '.git/hooks/pre-commit'), 0o755);
    expect(hewtd(['reconcile', 'backend/main.md', '--write-review']).status).toBe(0);
    const [file] = review_files();
    accept(file!);
    const doc = readFileSync(join(root, '.documentation/backend/main.md'), 'utf-8');
    const head = g('rev-parse', 'HEAD');
    const a = hewtd(['reconcile', '--apply', file!]);
    expect(a.stdout + a.stderr).not.toContain(V.main);
    expect(readFileSync(join(root, '.documentation/backend/main.md'), 'utf-8')).toBe(doc);
    expect(existsSync(join(root, '.env.hewtd'))).toBe(false);
    expect(g('rev-parse', 'HEAD')).toBe(head);
    expect(g('status', '--porcelain')).toBe('');
  });
});
