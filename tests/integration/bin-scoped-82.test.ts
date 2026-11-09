import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Issue #82: adding or removing a node_modules/.bin entry re-resolves only the docs whose `npx <bin>` refs name it,
// and the graph stays equal to a cold build. A marker planted in a cached entry shows in the next graph only if that entry was reused.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
let shim_dir: string;
let log_file: string;
const real_git = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = () => spawnSync('node', [CLI, 'index'], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${shim_dir}:${process.env.PATH}`, HEWTD_GIT_LOG: log_file } });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const read = (rel: string) => readFileSync(join(root, rel), 'utf-8');
const fm = (t: string, body: string, source: string) => `---\ntitle: ${t}\ndomains:\n  - backend\nsources: [${source}]\nlast_verified: 2026-01-01\n---\n\n# ${t}\n\n${body}\n`;
const DOCS = [0, 1, 2, 3, 4].map((i) => `backend/d${i}.md`);
const plant = () => {
  const cache = JSON.parse(read('.hewtd/graph-cache.json'));
  for (const doc of DOCS) cache.doc_cache.entries[doc].triage.missing = ['PLANTED-MARKER'];
  writeFileSync(join(root, '.hewtd/graph-cache.json'), JSON.stringify(cache));
};
const reused = (graph: string) => DOCS.filter((doc) => doc_refs(graph, doc).some((reference) => reference.target === 'PLANTED-MARKER'));
const index_ok = () => { expect(hewtd().status).toBe(0); return read('.hewtd/graph.json'); };
const cold = () => { rmSync(join(root, '.hewtd'), { recursive: true, force: true }); return index_ok(); };
const doc_refs = (graph: string, doc: string) => (JSON.parse(graph).docs[doc].refs as Array<{ target: string; resolved: boolean | null }>);

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bin82-'));
  shim_dir = mkdtempSync(join(tmpdir(), 'bin82-shim-'));
  log_file = join(shim_dir, 'calls.log');
  const shim = join(shim_dir, 'git');
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HEWTD_GIT_LOG"\nexec ${real_git} "$@"\n`);
  chmodSync(shim, 0o755);
  g('init', '-q', '-b', 'main');
  put('.gitignore', '.hewtd/\nnode_modules/\n.documentation/INDEX.md\n.documentation/REGISTRY.md\n');
  put('package.json', JSON.stringify({ name: 'fixture' }));
  for (let i = 0; i < 5; i++) put(`src/c${i}.ts`, `export const C${i} = ${i};\n`);
  for (let i = 0; i < 5; i++) put(`.documentation/backend/d${i}.md`, fm(`d${i}`, `See \`src/c${i}.ts\`. ${i === 0 ? 'Run `npx fake-a`.' : ''}`, `src/c${i}.ts`));
  g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(shim_dir, { recursive: true, force: true }); });

describe('.bin changes are scoped to the docs naming the binary (#82)', () => {
  it('an unrelated .bin entry added: the next one-doc edit reuses every other entry', () => {
    index_ok();
    put('node_modules/.bin/other-tool', '#!/bin/sh\n');
    put('.documentation/backend/d1.md', fm('d1', 'Edited; see `src/c1.ts`.', 'src/c1.ts'));
    plant();
    expect(reused(index_ok())).toEqual(['backend/d0.md', 'backend/d2.md', 'backend/d3.md', 'backend/d4.md']);
  });

  it('an unrelated .bin entry added, then a one-doc edit: the graph equals cold', () => {
    index_ok();
    put('node_modules/.bin/other-tool', '#!/bin/sh\n');
    put('.documentation/backend/d1.md', fm('d1', 'Edited; see `src/c1.ts`.', 'src/c1.ts'));
    expect(index_ok()).toBe(cold());
  });

  it('adding the named binary resolves that doc again and its ref turns ok; removing it turns it back', () => {
    const before = index_ok();
    expect(doc_refs(before, 'backend/d0.md').find((reference) => reference.target === 'npx fake-a')?.resolved).toBe(null);
    put('node_modules/.bin/fake-a', '#!/bin/sh\n');
    plant();
    const added = index_ok();
    expect(reused(added)).toEqual(['backend/d1.md', 'backend/d2.md', 'backend/d3.md', 'backend/d4.md']);
    expect(doc_refs(added, 'backend/d0.md').find((reference) => reference.target === 'npx fake-a')?.resolved).toBe(true);
    expect(cold().includes('PLANTED-MARKER')).toBe(false);
    put('node_modules/.bin/fake-a', '#!/bin/sh\n');
    index_ok();
    rmSync(join(root, 'node_modules/.bin/fake-a'));
    expect(index_ok()).toBe(before);
    expect(before).toBe(cold());
  });
});
