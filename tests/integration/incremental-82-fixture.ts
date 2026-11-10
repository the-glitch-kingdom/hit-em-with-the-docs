import { beforeAll, beforeEach, afterEach, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Shared fixture for the #82 incremental-code tests (split over three files so CI shards balance): a code commit (or dirty
// code edit) re-resolves only the docs that depend on the changed paths, and the graph after every incremental path equals
// a cold build. A git shim logs every call. Call use_incremental_fixture() once at the top of a test file.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');

export function use_incremental_fixture() {
  const state = { root: '', shim_dir: '', log_file: '' };
  const real_git = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: state.root, encoding: 'utf-8' }).trim();
  const hewtd = (args: string[] = ['index']) => spawnSync('node', [CLI, ...args], { cwd: state.root, encoding: 'utf8', env: { ...process.env, PATH: `${state.shim_dir}:${process.env.PATH}`, HEWTD_GIT_LOG: state.log_file } });
  const put = (rel: string, text: string) => { mkdirSync(join(state.root, rel, '..'), { recursive: true }); writeFileSync(join(state.root, rel), text); };
  const read = (rel: string) => readFileSync(join(state.root, rel), 'utf-8');
  const fm = (t: string, body: string, sources = '') => `---\ntitle: ${t}\ndomains:\n  - backend\n${sources ? `sources: [${sources}]\nlast_verified: 2026-01-01\n` : ''}---\n\n# ${t}\n\n${body}\n`;
  const calls = (): string[] => (existsSync(state.log_file) ? readFileSync(state.log_file, 'utf-8').split('\n').filter(Boolean) : []);
  const reset_calls = () => writeFileSync(state.log_file, '');
  const commit_all = (message: string) => { g('add', '-A'); g('commit', '-qm', message); };
  const index_ok = () => { const result = hewtd(); expect(result.status).toBe(0); return read('.hewtd/graph.json'); };
  const cold = () => { rmSync(join(state.root, '.hewtd'), { recursive: true, force: true }); return index_ok(); };
  /** one staleness `rev-list` per doc that was resolved again */
  const resolved_docs = () => calls().filter((line) => line.startsWith('rev-list --count')).length;

  beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
  beforeEach(() => {
    state.root = mkdtempSync(join(tmpdir(), 'ft82-'));
    state.shim_dir = mkdtempSync(join(tmpdir(), 'ft82-shim-'));
    state.log_file = join(state.shim_dir, 'calls.log');
    const shim = join(state.shim_dir, 'git');
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
  afterEach(() => { rmSync(state.root, { recursive: true, force: true }); rmSync(state.shim_dir, { recursive: true, force: true }); });

  return { state, g, hewtd, put, read, fm, calls, reset_calls, commit_all, index_ok, cold, resolved_docs };
}
