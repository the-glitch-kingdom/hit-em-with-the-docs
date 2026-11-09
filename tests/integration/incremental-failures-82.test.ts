import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Issue #82 failure paths and history rewrites through the built CLI: whatever the cache holds (corrupt, old version,
// a head git no longer knows, a shallow clone, related repos configured) the graph must equal a cold run at the same state.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
const run_git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf-8' }).trim();
const g = (...a: string[]) => run_git(root, ...a);
const hewtd = (cwd = root) => spawnSync('node', [CLI, 'index'], { cwd, encoding: 'utf8' });
const put = (rel: string, text: string, base = root) => { mkdirSync(join(base, rel, '..'), { recursive: true }); writeFileSync(join(base, rel), text); };
const read = (rel: string, base = root) => readFileSync(join(base, rel), 'utf-8');
const fm = (t: string, body: string, source: string) => `---\ntitle: ${t}\ndomains:\n  - backend\nsources: [${source}]\nlast_verified: 2026-01-01\n---\n\n# ${t}\n\n${body}\n`;
const commit_all = (message: string) => { g('add', '-A'); g('commit', '-qm', message); };
const index_ok = (cwd = root) => { const result = hewtd(cwd); expect(result.status).toBe(0); return read('.hewtd/graph.json', cwd); };
const cold = (cwd = root) => { rmSync(join(cwd, '.hewtd'), { recursive: true, force: true }); return index_ok(cwd); };
const edit_cache = (change: (cache: any) => void) => {
  const cache = JSON.parse(read('.hewtd/graph-cache.json'));
  change(cache);
  writeFileSync(join(root, '.hewtd/graph-cache.json'), JSON.stringify(cache));
};
const code_commit = () => { put('src/c2.ts', 'export function unitFn2() { return 22; }\nexport function GhostFn() {}\n'); commit_all('code'); };

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fail82-'));
  g('init', '-q', '-b', 'main');
  put('.gitignore', '.hewtd/\n.documentation/INDEX.md\n.documentation/REGISTRY.md\n');
  put('package.json', JSON.stringify({ name: 'fixture' }));
  for (let i = 0; i < 4; i++) put(`src/c${i}.ts`, `export function unitFn${i}() { return ${i}; }\n`);
  for (let i = 0; i < 4; i++) put(`.documentation/backend/d${i}.md`, fm(`d${i}`, `See \`src/c${i}.ts\`, \`unitFn${i}()\` and \`GhostFn()\`.`, `src/c${i}.ts`));
  commit_all('init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('incremental code changes survive a bad cache or rewritten history (#82)', () => {
  it('a rebased branch equals cold', () => {
    index_ok();
    g('checkout', '-q', '-b', 'feature');
    put('src/c1.ts', 'export function unitFn1() { return 11; }\n');
    commit_all('feature');
    index_ok();
    g('checkout', '-q', 'main');
    put('src/c2.ts', 'export function unitFn2() { return 22; }\nexport function GhostFn() {}\n');
    commit_all('main moves');
    g('checkout', '-q', 'feature');
    g('rebase', '-q', 'main');
    expect(index_ok()).toBe(cold());
  });

  it('a corrupt cache file equals cold', () => {
    index_ok();
    code_commit();
    writeFileSync(join(root, '.hewtd/graph-cache.json'), '{not json');
    expect(index_ok()).toBe(cold());
  });

  it('a cache of the previous version is ignored and rebuilt', () => {
    index_ok();
    code_commit();
    edit_cache((cache) => { cache.cache_version = 1; });
    expect(index_ok()).toBe(cold());
  });

  it('a cached head git does not know (collected) equals cold', () => {
    index_ok();
    code_commit();
    edit_cache((cache) => { cache.doc_cache.head = 'deadbeef'.repeat(5); });
    expect(index_ok()).toBe(cold());
  });

  it('a shallow clone, before and after a new commit upstream, equals cold', () => {
    const clone = mkdtempSync(join(tmpdir(), 'fail82-clone-'));
    try {
      run_git(clone, 'clone', '-q', '--depth', '1', `file://${root}`, '.');
      index_ok(clone);
      code_commit();
      run_git(clone, 'fetch', '-q', '--depth', '1', 'origin', 'main');
      run_git(clone, 'reset', '-q', '--hard', 'origin/main');
      expect(index_ok(clone)).toBe(cold(clone));
    } finally { rmSync(clone, { recursive: true, force: true }); }
  });

  it('related_repos configured: no cache is kept, and a code commit still equals cold', () => {
    put('.claude/hit-em-with-the-docs.json', JSON.stringify({ reconcile: { related_repos: [{ name: 'api', path: '../api-missing' }] } }));
    commit_all('config');
    index_ok();
    code_commit();
    expect(index_ok()).toBe(cold());
    expect(JSON.parse(read('.hewtd/graph-cache.json')).doc_cache).toBeUndefined();
  });
});
