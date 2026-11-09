import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Issue #77 acceptance checks through the built CLI: after a commit, `hewtd index` equals a cold build and
// spawns no `git grep` and at most one body-history walk per touched doc. A git shim on PATH logs every call.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
let shim_dir: string;
let log_file: string;
const real_git = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[] = ['index']) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${shim_dir}:${process.env.PATH}`, HEWTD_GIT_LOG: log_file } });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const read = (rel: string) => readFileSync(join(root, rel), 'utf-8');
const fm = (t: string, body: string) => `---\ntitle: ${t}\ndomains:\n  - backend\n---\n\n# ${t}\n\n${body}\n`;
const calls = (): string[] => (existsSync(log_file) ? readFileSync(log_file, 'utf-8').split('\n').filter(Boolean) : []);
const reset_calls = () => writeFileSync(log_file, '');
const commit_all = (message: string) => { g('add', '-A'); g('commit', '-qm', message); };
const index_ok = () => { const result = hewtd(); expect(result.status).toBe(0); return read('.hewtd/graph.json'); };
const cold = () => { rmSync(join(root, '.hewtd'), { recursive: true, force: true }); return index_ok(); };

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ft77-'));
  shim_dir = mkdtempSync(join(tmpdir(), 'ft77-shim-'));
  log_file = join(shim_dir, 'calls.log');
  const shim = join(shim_dir, 'git');
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HEWTD_GIT_LOG"\nexec ${real_git} "$@"\n`);
  chmodSync(shim, 0o755);
  g('init', '-q', '-b', 'main');
  put('.gitignore', '.hewtd/\n.documentation/INDEX.md\n.documentation/REGISTRY.md\n');
  put('src/a.ts', 'export function alphaUnit() { return 1; }\n');
  for (let i = 0; i < 5; i++) put(`.documentation/backend/d${i}.md`, fm(`d${i}`, `See \`src/a.ts\`, \`alphaUnit()\`, \`GhostName${i}\` and [next](./d${(i + 1) % 5}.md).`));
  commit_all('init');
  for (let i = 0; i < 3; i++) { put('.documentation/backend/d0.md', fm('d0', `Revision ${i} of \`alphaUnit()\`.`)); commit_all(`rev${i}`); }
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(shim_dir, { recursive: true, force: true }); });

const grep_calls = () => calls().filter((line) => line.split(' ').includes('grep'));
const walks = () => calls().filter((line) => line.includes('--follow'));

describe('index after a commit (#77)', () => {
  it('a docs-only commit: no git grep, one body walk per touched doc, graph equals cold', () => {
    index_ok();
    put('.documentation/backend/d2.md', fm('d2', 'Changed; see `alphaUnit()` and `GhostName2`.'));
    commit_all('docs only');
    reset_calls();
    const incremental = index_ok();
    expect(grep_calls()).toEqual([]);
    expect(walks().length).toBeLessThanOrEqual(1);
    expect(incremental).toBe(cold());
  });

  it('a one-doc edit (uncommitted): no git grep, at most one walk, graph equals cold', () => {
    index_ok();
    put('.documentation/backend/d1.md', fm('d1', 'Edited; see `alphaUnit()`.'));
    reset_calls();
    const incremental = index_ok();
    expect(grep_calls()).toEqual([]);
    expect(walks().length).toBeLessThanOrEqual(1);
    expect(incremental).toBe(cold());
  });

  it('an unchanged tree walks no history and runs no git grep', () => {
    index_ok();
    reset_calls();
    index_ok();
    expect(grep_calls()).toEqual([]);
    expect(walks()).toEqual([]);
  });

  it('a cold build walks each doc at most once', () => {
    reset_calls();
    index_ok();
    expect(walks().length).toBeGreaterThan(0); // the shim sees the calls
    expect(walks().length).toBeLessThanOrEqual(5);
  });

  it('a new symbol name after a doc edit greps code for it and still equals cold', () => {
    index_ok();
    put('src/b.ts', 'export function betaUnit() { return 2; }\n');
    commit_all('code');
    put('.documentation/backend/d3.md', fm('d3', 'Now `betaUnit()` and `alphaUnit()`.'));
    commit_all('docs');
    expect(index_ok()).toBe(cold());
  });

  it('a code-only commit equals a cold build', () => {
    index_ok();
    put('src/a.ts', 'export function alphaUnit() { return 9; }\nexport function GhostName1() { return 1; }\n');
    commit_all('code only');
    expect(index_ok()).toBe(cold());
  });

  it('a rebase that rewrites history equals a cold build', () => {
    index_ok();
    g('checkout', '-q', '-b', 'topic');
    put('.documentation/backend/d4.md', fm('d4', 'Topic change `alphaUnit()`.'));
    commit_all('topic');
    g('checkout', '-q', 'main');
    put('.documentation/backend/d0.md', fm('d0', 'Main change `alphaUnit()`.'));
    commit_all('main moves');
    index_ok();
    g('checkout', '-q', 'topic');
    g('rebase', 'main');
    expect(index_ok()).toBe(cold());
  });

  it('a doc renamed in a commit keeps its body date and equals cold', () => {
    index_ok();
    g('mv', '.documentation/backend/d0.md', '.documentation/backend/renamed.md');
    commit_all('rename');
    expect(index_ok()).toBe(cold());
  });

  it('a missing or corrupt symbol cache is rebuilt, not fatal', () => {
    index_ok();
    const cache = JSON.parse(read('.hewtd/graph-cache.json'));
    cache.symbol_cache = { state: cache.symbol_cache?.state, symbols: 'garbage' };
    writeFileSync(join(root, '.hewtd/graph-cache.json'), JSON.stringify(cache));
    put('.documentation/backend/d2.md', fm('d2', 'Edited `alphaUnit()`.'));
    expect(index_ok()).toBe(cold());
  });
});
