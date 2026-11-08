import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Field test #58 end to end: one fixture repo (built here, never committed), every check through the built CLI.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const DOMAINS = ['alpha-ops', 'beta-ops', 'gamma-ops'];
const GOOD = 'Explains how the widget pipeline retries failed jobs after a timeout';

let base: string;
let root: string; // the project
let sib: string; // sibling repo
let docs: string;

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf-8' }).trim();
const commit = (cwd: string, msg: string, date?: string) => {
  git(cwd, 'add', '-A');
  const env = { ...process.env, ...(date && { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }) };
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg], { cwd, env });
};
const hewtd = (args: string[], cwd = root) => spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const put = (repo: string, rel: string, text: string) => { mkdirSync(join(repo, rel, '..'), { recursive: true }); writeFileSync(join(repo, rel), text); };
const doc = (domain: string, title: string, body: string, extra = '') =>
  `---\ntitle: ${title}\ntier: guide\ndomains:\n- ${domain}\nstatus: active\npurpose: ${GOOD}\n${extra}---\n\n# ${title}\n\n${body}\n`;
type D = { path: string; lane: string; owner?: string; staleCommits?: number; bytes: number; missing: string[] };
const triage = (...a: string[]) => JSON.parse(hewtd(['reconcile', ...DOMAINS, ...a, '--json']).stdout) as { docs: D[]; mode: string; totals: { bytes: number } };
const lanes = (t = triage()) => Object.fromEntries(t.docs.map((d) => [d.path, d]));
const review_files = () => readdirSync(join(root, '.hewtd/reconcile')).filter((f) => /^review-.*\.md$/.test(f)).sort().map((f) => join(root, '.hewtd/reconcile', f));
function fill(file: string, fn: (path: string) => Record<string, unknown> | null): void {
  const out = readFileSync(file, 'utf-8').split(/^(?=## )/m).map((sec) => {
    const m = /```json\n([\s\S]*?)\n```/.exec(sec);
    if (!m) return sec;
    const e = JSON.parse(m[1]!);
    const patch = fn(e.path);
    return patch ? sec.replace(m[1]!, JSON.stringify({ ...e, ...patch }, null, 2)).replace('- [ ] accept', '- [x] accept') : sec;
  });
  writeFileSync(file, out.join(''));
}
const review = (...a: string[]) => { rmSync(join(root, '.hewtd/reconcile'), { recursive: true, force: true }); hewtd(['reconcile', ...a, '--write-review']); return review_files(); };
const sib_tree_hash = () => git(sib, 'status', '--porcelain') + '|' + git(sib, 'rev-parse', 'HEAD') + '|' + git(sib, 'ls-files', '-s');

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests');
  base = mkdtempSync(join(tmpdir(), 'ft58-'));
  root = join(base, 'proj');
  sib = join(base, 'api');
  docs = join(root, '.documentation');
  for (const r of [root, sib]) { mkdirSync(r); git(r, 'init', '-q'); }

  // sibling repo: code, scripts and its own docs
  put(sib, 'lib/server.ts', 'export function handleSibling() {}\n');
  put(sib, 'lib/other.ts', 'export const otherThing = 1;\n');
  put(sib, 'package.json', JSON.stringify({ scripts: { 'sib-run': 'node lib/server.ts' } }));
  put(sib, '.documentation/ops/auth.md', '# auth\n');
  commit(sib, 'init');

  // project
  put(root, '.claude/hit-em-with-the-docs.json', JSON.stringify({
    domains: DOMAINS.map((id) => ({ id, name: id, description: id, keywords: [id], loadPriority: 5, category: 'development' })),
    reconcile: { related_repos: [{ name: 'api', path: '../api' }] },
  }));
  put(root, '.gitignore', '.hewtd/\narchive/\n');
  put(root, 'src/real.ts', 'export const realThing = 1;\n');
  put(root, 'data/big.json', '{"k":"' + 'x'.repeat(9 * 1024 * 1024) + ' zzOnlyInBigFile"}'); // 9 MB, one line
  put(root, 'db/dump.sql', 'CREATE TABLE old_table (id int);\n'); // stale dump: no schema_sources configured
  put(root, 'packages/web/package.json', JSON.stringify({ scripts: { 'web-build': 'tsc' } }));
  put(root, 'config/app.yaml', 'docs: notes/used.md\n');
  put(root, 'notes/used.md', '# Used by config\n\n' + 'word '.repeat(60) + '\n');
  put(root, '_archive/legacy.md', '# Legacy\n\n' + 'word '.repeat(60) + '\n');
  put(root, 'product/old/plan.md', '# Plan\n\n' + 'word '.repeat(60) + '\n'); // `old/` is not an archive folder
  put(root, 'notes/design.md', '# Design of the cache layer\n\n' + 'word '.repeat(60) + '\n');
  put(root, 'README.md', '# Readme\n');

  put(docs, 'alpha-ops/big.md', doc('alpha-ops', 'big', 'See `src/real.ts` and `zzOnlyInBigFile`.'));
  put(docs, 'alpha-ops/sub.md', doc('alpha-ops', 'sub', 'Run `npm run web-build` after `src/real.ts` changes. Table `tasks` is not in the dump.'));
  put(docs, 'alpha-ops/dup.md', doc('alpha-ops', 'dup', 'Details: `lib/server.ts`, `handleSibling()`, `lib/other.ts`, `npm run sib-run`.'));
  put(docs, 'beta-ops/stale.md', doc('beta-ops', 'stale', 'See `src/gone1.ts`, `src/gone2.ts`, `src/gone3.ts`.'));
  put(docs, 'beta-ops/ext.md', doc('beta-ops', 'ext', 'Call `/api/v1/things`, see `example.com/docs/page` and the `SOME_EXTERNAL_ENV` setting. Also `src/real.ts`.'));
  put(docs, 'alpha-ops/yaml.md', doc('alpha-ops', 'yaml', 'See `src/real.ts`.', 'tags:\n- one\n- two\n'));
  // an external name: no code defines it, but another doc names it too, so it is `unknown` (the citing doc alone proves nothing)
  put(docs, 'beta-ops/ext-ref.md', doc('beta-ops', 'ext-ref', 'Set `SOME_EXTERNAL_ENV` in the provider console. See `src/real.ts`.'));
  for (let i = 1; i <= 5; i++) put(docs, `gamma-ops/f${i}.md`, doc('gamma-ops', `f${i}`, [1, 2].map((k) => ((i + k - 1) % 5) + 1).map((j) => `[f${j}](f${j}.md)`).join(' ') + ' See `src/real.ts`.'));
  put(docs, 'README.md', '# Docs readme\n\n' + [1, 2].map((j) => `[f${j}](gamma-ops/f${j}.md)`).join(' ') + '\n');
  commit(root, 'init', '2001-01-01T00:00:00');

  // #58.4: doc committed in 2001, cited code changed in 2002, then a frontmatter-only commit in 2003
  put(docs, 'beta-ops/fm.md', doc('beta-ops', 'fm', 'See `src/real.ts`.'));
  commit(root, 'doc', '2001-06-01T00:00:00');
  put(root, 'src/real.ts', 'export const realThing = 2;\n');
  commit(root, 'code change', '2002-01-01T00:00:00');
  put(docs, 'beta-ops/fm.md', doc('beta-ops', 'fm', 'See `src/real.ts`.', 'owner: someone\n'));
  commit(root, 'frontmatter only', '2003-01-01T00:00:00');
}, 120_000);
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('field test #58 fixture (built CLI)', () => {
  it('#1 whole-fixture triage is fast and resolves a name found only in the 9 MB file', () => {
    const t0 = Date.now();
    const t = triage();
    expect(Date.now() - t0).toBeLessThan(20_000);
    const big = lanes(t)['alpha-ops/big.md']!;
    expect(big.missing).toEqual([]);
    expect(big.bytes).toBeLessThan(100_000); // symbol hit in the big file is not "read" cost
  });

  it('#2/3/5 only the truly stale doc is an archive candidate; --next 3 stays serial', () => {
    const t = triage();
    const l = lanes(t);
    expect(t.docs.filter((d) => d.lane === 'archive-candidate').map((d) => d.path)).toEqual(['beta-ops/stale.md']);
    expect(l['alpha-ops/sub.md']!.missing).toEqual([]); // sub-package script, table not checked against a stale dump
    expect(l['beta-ops/ext.md']!.missing).toEqual([]); // URL-ish paths and markdown-only names are unknown
    expect(JSON.parse(hewtd(['reconcile', '--next', '3', '--json']).stdout).mode).toBe('serial');
  });

  it('#4 a frontmatter-only commit does not reset staleness', () => {
    expect(lanes()['beta-ops/fm.md']!.staleCommits).toBeGreaterThanOrEqual(1);
  });

  it('#6 index from a subdirectory is byte-identical to the root run', () => {
    expect(hewtd(['index']).status).toBe(0);
    const at = () => ['INDEX.md', 'REGISTRY.md'].map((f) => readFileSync(join(docs, f), 'utf-8'));
    const from_root = at();
    expect(from_root[0]).toContain('gamma-ops');
    rmSync(join(docs, 'INDEX.md'));
    rmSync(join(docs, 'REGISTRY.md'));
    expect(hewtd(['index'], join(root, 'src')).status).toBe(0);
    expect(at()).toEqual(from_root);
    commit(root, 'indexes');
  });

  it('overview: root README is not a flow member and the ring is one flow of 5', () => {
    const issues: string[] = JSON.parse(execFileSync('node', ['-e',
      `import('${join(resolve(__dirname, '../..'), 'dist/core/audit/auditor.js')}').then(async m=>{const r=await m.audit_documentation({docsPath:process.argv[1],silent:true});console.log(JSON.stringify(r.issues.filter(i=>i.rule==='OVERVIEW_MISSING').map(i=>i.message)))})`, docs],
      { encoding: 'utf8', cwd: root }).trim().split('\n').pop()!);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^Flow — 5 docs /);
    expect(issues[0]).not.toContain('README');
  });

  it('#3 related repos: sibling refs ok, ownership hint fires, clears after summary + cross-link; sibling untouched', () => {
    const before = sib_tree_hash();
    const dup = lanes()['alpha-ops/dup.md']!;
    expect(dup.missing).toEqual([]);
    expect(dup.owner).toBe('api');
    expect(dup.lane).not.toBe('clean');

    const f = review('alpha-ops')[0]!;
    fill(f, (p) => p === 'alpha-ops/dup.md'
      ? { verdict: 'verify', sources: ['api:lib/server.ts'], patch: [{ old: 'Details: `lib/server.ts`, `handleSibling()`, `lib/other.ts`, `npm run sib-run`.', new: 'Summary only; details live in [auth](../../../api/.documentation/ops/auth.md).' }] }
      : null);
    const r = hewtd(['reconcile', '--apply', f]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[applied\] alpha-ops\/dup\.md/);
    const after = lanes()['alpha-ops/dup.md']!;
    expect(after.owner).toBeUndefined();
    expect(after.missing).toEqual([]);
    expect(sib_tree_hash()).toBe(before);
  });

  it('#8 outside lane: config-referenced and archived files are classed; integrated doc gets git dates', () => {
    const r = hewtd(['reconcile', '--outside', '--json']);
    const cls = Object.fromEntries(JSON.parse(r.stdout).map((d: { path: string; cls: string }) => [d.path, d.cls]));
    expect(cls['notes/used.md']).toBe('not-a-doc');
    expect(cls['_archive/legacy.md']).toBe('junk');
    expect(cls['product/old/plan.md']).toBe('misplaced');
    expect(cls['notes/design.md']).toBe('misplaced');
    expect(cls['README.md']).toBe('tool-read');

    hewtd(['reconcile', '--outside', '--write-review']);
    const f = review_files().find((x) => x.includes('outside'))!;
    fill(f, (p) => (p === 'notes/design.md' ? { verdict: 'integrate', domain: 'alpha-ops' } : null));
    expect(hewtd(['reconcile', '--apply', f]).status).toBe(0);
    const moved = readdirSync(join(docs, 'alpha-ops')).find((n) => /design/.test(n))!;
    const text = readFileSync(join(docs, 'alpha-ops', moved), 'utf-8');
    expect(text).toMatch(/last_updated: '?2001-01-01/); // the file's git date, not today
    expect(text).not.toContain('last_validated');
    expect(text).toMatch(/moved_from: notes\/design\.md/);
  });

  it('#8 apply: a rewrite stays queued, an error exits 1 with a summary, YAML diff is limited to the changed field', () => {
    const yaml_before = readFileSync(join(docs, 'alpha-ops/yaml.md'), 'utf-8');
    const f = review('alpha-ops', 'beta-ops', 'gamma-ops', '--serial')[0]!;
    fill(f, (p) => (p === 'beta-ops/ext.md' ? { verdict: 'rewrite', draft: 'x' } : p === 'alpha-ops/yaml.md' ? { verdict: 'fields', frontmatter: { purpose: 'Explains how the yaml fixture keeps its list indentation intact' } } : p === 'gamma-ops/f1.md' ? { verdict: 'integrate' } : null));
    const r = hewtd(['reconcile', '--apply', f]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/error 1/);
    expect(JSON.parse(hewtd(['reconcile', '--next', '10', '--json']).stdout).docs.map((d: D) => d.path)).toContain('beta-ops/ext.md');
    const yaml_after = readFileSync(join(docs, 'alpha-ops/yaml.md'), 'utf-8');
    expect(yaml_after).toContain('tags:\n- one\n- two\n'); // unindented list kept
    const changed = yaml_after.split('\n').filter((l) => !yaml_before.split('\n').includes(l));
    expect(changed.every((l) => /^(purpose|last_updated|last_verified):/.test(l))).toBe(true);
  });

  it('#7 a forced commit failure leaves the tree and ledger unchanged; an ignored archive path still commits', () => {
    const hook = join(root, '.git/hooks/pre-commit');
    const ledger = () => (existsSync(join(root, '.hewtd/reconcile.json')) ? readFileSync(join(root, '.hewtd/reconcile.json'), 'utf-8') : '');
    expect(git(root, 'status', '--porcelain')).toBe('');
    const f = review('beta-ops')[0]!;
    fill(f, (p) => (p === 'beta-ops/stale.md' ? { verdict: 'archive', reason: 'code removed' } : null));

    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    const head = git(root, 'rev-parse', 'HEAD');
    const led = ledger();
    const bad = hewtd(['reconcile', '--apply', f]);
    expect(bad.status).toBe(1);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(docs, 'beta-ops/stale.md'))).toBe(true);
    expect(existsSync(join(docs, 'archive'))).toBe(false);
    expect(ledger()).toBe(led);

    rmSync(hook);
    const ok = hewtd(['reconcile', '--apply', f]);
    expect(ok.status).toBe(0);
    expect(git(root, 'rev-parse', 'HEAD')).not.toBe(head);
    expect(existsSync(join(docs, 'beta-ops/stale.md'))).toBe(false);
    expect(git(root, 'ls-files', '.documentation/archive').length).toBeGreaterThan(0); // archive/ is gitignored; -f adds it
    expect(git(root, 'status', '--porcelain')).toBe('');
  });
});
