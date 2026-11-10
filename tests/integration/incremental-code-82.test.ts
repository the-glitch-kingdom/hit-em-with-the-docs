import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Issue #82 acceptance checks through the built CLI: a code commit (or dirty code edit) re-resolves only the docs that
// depend on the changed paths, and the graph after every incremental path equals a cold build. A git shim logs every call.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
let shim_dir: string;
let log_file: string;
const real_git = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[] = ['index']) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${shim_dir}:${process.env.PATH}`, HEWTD_GIT_LOG: log_file } });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const read = (rel: string) => readFileSync(join(root, rel), 'utf-8');
const fm = (t: string, body: string, sources = '') => `---\ntitle: ${t}\ndomains:\n  - backend\n${sources ? `sources: [${sources}]\nlast_verified: 2026-01-01\n` : ''}---\n\n# ${t}\n\n${body}\n`;
const calls = (): string[] => (existsSync(log_file) ? readFileSync(log_file, 'utf-8').split('\n').filter(Boolean) : []);
const reset_calls = () => writeFileSync(log_file, '');
const commit_all = (message: string) => { g('add', '-A'); g('commit', '-qm', message); };
const index_ok = () => { const result = hewtd(); expect(result.status).toBe(0); return read('.hewtd/graph.json'); };
const cold = () => { rmSync(join(root, '.hewtd'), { recursive: true, force: true }); return index_ok(); };
/** one staleness `rev-list` per doc that was resolved again */
const resolved_docs = () => calls().filter((line) => line.startsWith('rev-list --count')).length;

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ft82-'));
  shim_dir = mkdtempSync(join(tmpdir(), 'ft82-shim-'));
  log_file = join(shim_dir, 'calls.log');
  const shim = join(shim_dir, 'git');
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HEWTD_GIT_LOG"\nexec ${real_git} "$@"\n`);
  chmodSync(shim, 0o755);
  g('init', '-q', '-b', 'main');
  put('.gitignore', '.hewtd/\n.documentation/INDEX.md\n.documentation/REGISTRY.md\n');
  put('package.json', JSON.stringify({ name: 'fixture', scripts: {} }));
  put('scripts/run.sh', '#!/bin/sh\necho hi\n');
  for (let i = 0; i < 5; i++) put(`src/c${i}.ts`, `export function unitFn${i}() { return ${i}; }\n`);
  put('src/z0.ts', 'export function sharedFn() { return 1; }\n');
  put('src/c0.ts', 'export function unitFn0() { return 0; }\nexport function sharedFn() { return 0; }\n');
  for (let i = 0; i < 5; i++) {
    const extra = [i === 1 ? '`sharedFn()`' : '', i === 3 ? '`lib/extra.ts`' : '', i === 2 ? '`extra2.ts` and `newdir/`' : '', i === 4 ? '`GhostFn()` and `npm run build`' : ''].join(' ');
    put(`.documentation/backend/d${i}.md`, fm(`d${i}`, `See \`src/c${i}.ts\`, \`unitFn${i}()\` and [next](./d${(i + 1) % 5}.md). ${extra}`, `src/c${i}.ts`));
  }
  commit_all('init');
  for (let i = 0; i < 2; i++) { put('.documentation/backend/d0.md', fm('d0', `Revision ${i} of \`unitFn0()\`.`, 'src/c0.ts')); commit_all(`rev${i}`); }
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(shim_dir, { recursive: true, force: true }); });

describe('code changes are incremental (#82)', () => {
  it('a code commit resolves again only the docs citing the changed file', () => {
    index_ok();
    put('src/c2.ts', 'export function unitFn2() { return 22; }\n');
    commit_all('code');
    reset_calls();
    const incremental = index_ok();
    expect(resolved_docs()).toBe(1);
    expect(incremental).toBe(cold());
  });

  it('a commit touching a script resolves nothing again', () => {
    index_ok();
    put('scripts/run.sh', '#!/bin/sh\n# a comment\necho hi\n');
    commit_all('sh');
    reset_calls();
    const incremental = index_ok();
    expect(resolved_docs()).toBe(0);
    expect(incremental).toBe(cold());
  });

  it('a change and its revert still resolve the citing doc again (its commit count moved)', () => {
    index_ok();
    put('src/c2.ts', 'export function unitFn2() { return 22; }\n');
    commit_all('change');
    put('src/c2.ts', 'export function unitFn2() { return 2; }\n');
    commit_all('revert');
    reset_calls();
    const incremental = index_ok();
    expect(resolved_docs()).toBe(1);
    expect(incremental).toBe(cold());
  });

  it('a docs-only commit equals cold', () => {
    index_ok();
    put('.documentation/backend/d2.md', fm('d2', 'Changed; see `unitFn2()`.', 'src/c2.ts'));
    commit_all('docs');
    expect(index_ok()).toBe(cold());
  });

  it('a commit deleting a cited file equals cold', () => {
    index_ok();
    g('rm', '-q', 'src/c1.ts');
    g('commit', '-qm', 'delete');
    expect(index_ok()).toBe(cold());
  });

  it('a commit adding the file a missing path ref names equals cold', () => {
    index_ok();
    put('lib/extra.ts', 'export const x = 1;\n');
    commit_all('add file');
    expect(index_ok()).toBe(cold());
  });

  it('a commit adding a file a bare name or a directory ref now resolves to equals cold', () => {
    index_ok();
    put('lib/extra2.ts', 'export const y = 1;\n');
    put('newdir/a.ts', 'export const z = 1;\n');
    commit_all('add files');
    expect(index_ok()).toBe(cold());
  });

  it('a commit defining a previously unresolved symbol equals cold', () => {
    index_ok();
    put('src/ghost.ts', 'export function GhostFn() { return 1; }\n');
    commit_all('define');
    expect(index_ok()).toBe(cold());
  });

  it('a commit moving the winning definition of a symbol equals cold', () => {
    index_ok();
    put('src/c0.ts', 'export function unitFn0() { return 0; }\n');
    commit_all('move');
    expect(index_ok()).toBe(cold());
  });

  it('a package.json script added in a commit equals cold', () => {
    index_ok();
    put('package.json', JSON.stringify({ name: 'fixture', scripts: { build: 'tsc' } }));
    commit_all('script');
    expect(index_ok()).toBe(cold());
  });

  it('an amended commit (history rewritten) equals cold', () => {
    index_ok();
    put('src/c3.ts', 'export function unitFn3() { return 33; }\n');
    commit_all('code');
    index_ok();
    put('src/c3.ts', 'export function unitFn3() { return 34; }\nexport function GhostFn() {}\n');
    g('add', '-A');
    g('commit', '-q', '--amend', '-m', 'code amended');
    expect(index_ok()).toBe(cold());
  });

  it('a dirty code edit, then its revert, equals cold each time', () => {
    index_ok();
    put('src/c3.ts', 'export function unitFn3() { return 33; }\nexport function GhostFn() {}\n');
    expect(index_ok()).toBe(cold());
    index_ok();
    g('checkout', '--', 'src/c3.ts');
    expect(index_ok()).toBe(cold());
  });

  // #84 made refs depend on .gitignore, a doc-relative location, the secret/ folder and settings files: each must invalidate like code.
  it('a .gitignore edit that turns a missing path ref into not-checkable equals cold (#84)', () => {
    put('.documentation/backend/d1.md', fm('d1', 'Built to `out/app.js`.', 'src/c1.ts'));
    commit_all('cite out/');
    index_ok();
    put('.gitignore', '.hewtd/\n.documentation/INDEX.md\n.documentation/REGISTRY.md\nout/\n');
    commit_all('ignore out/');
    expect(index_ok()).toBe(cold());
  });

  it('a file added where a doc-relative ref points equals cold (#84)', () => {
    put('.documentation/backend/d1.md', fm('d1', 'See `../ops/runbook.md`.', 'src/c1.ts'));
    commit_all('cite ../ops');
    index_ok();
    put('.documentation/ops/runbook.md', fm('runbook', 'Steps.'));
    commit_all('add runbook');
    expect(index_ok()).toBe(cold());
  });

  it('the first file under secret/ makes secret/ refs checkable, equal to cold (#84)', () => {
    put('.documentation/backend/d1.md', fm('d1', 'Stored at `secret/app/prod.yaml`.', 'src/c1.ts'));
    commit_all('cite secret/');
    index_ok();
    put('secret/other.yaml', 'a: 1\n');
    commit_all('real secret folder');
    expect(index_ok()).toBe(cold());
  });

  it('an env var backed by a settings field, and that file changing, equals cold (#84)', () => {
    put('src/settings.py', 'class Settings(BaseSettings):\n    hot_tier_size: int = 1\n');
    put('.documentation/backend/d1.md', fm('d1', 'Set `HOT_TIER_SIZE`.', 'src/c1.ts'));
    commit_all('settings');
    index_ok();
    put('src/settings.py', 'hot_tier_size = 1\n');
    commit_all('not settings any more');
    expect(index_ok()).toBe(cold());
  });
});

