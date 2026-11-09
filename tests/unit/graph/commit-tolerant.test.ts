import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { load_plugin_config, type PluginConfig } from '../../../src/utils/config';
import { build_graph, render_graph, write_graph } from '../../../src/core/graph/export';

let dir: string;
let docs: string;
let config: PluginConfig;
const cache_file = () => join(dir, '.hewtd', 'graph-cache.json');
const graph_file = () => join(dir, '.hewtd', 'graph.json');
const put = (rel: string, text: string) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const doc = (extra: string, cites = 'src/a.ts') => `---\ntitle: T\npurpose: Explains how the widget pipeline retries failed jobs after a timeout\nsources: [${cites}]\nlast_verified: 2026-01-01\n---\n${extra}\n`;

async function cold(): Promise<string> {
  const saved = existsSync(cache_file()) ? readFileSync(cache_file(), 'utf-8') : null;
  rmSync(cache_file(), { force: true });
  const text = render_graph(await build_graph({ root: dir, docs_root: docs, config, dry_run: true }));
  if (saved !== null) writeFileSync(cache_file(), saved);
  return text;
}
/** Writes the graph incrementally and asserts it equals a cold build (planted markers aside); returns the parsed graph. */
async function check_equal(next_config = config): Promise<{ docs: Record<string, { refs: Array<{ target: string; resolved: boolean | null }> }> }> {
  await write_graph({ root: dir, docs_root: docs, config: next_config });
  const graph = JSON.parse(readFileSync(graph_file(), 'utf-8'));
  const unplanted = structuredClone(graph);
  for (const entry of Object.values(unplanted.docs) as Array<{ refs: Array<{ target: string }> }>) entry.refs = entry.refs.filter((reference) => reference.target !== 'PLANTED-MARKER');
  expect(render_graph(unplanted)).toBe(await cold());
  return graph;
}
/** Plants a marker ref in a doc's cached entry: it shows in the next graph only if that entry was reused. */
function plant(...doc_paths: string[]): void {
  const cache = JSON.parse(readFileSync(cache_file(), 'utf-8'));
  for (const doc_path of doc_paths) cache.doc_cache.entries[doc_path].triage.missing = ['PLANTED-MARKER'];
  writeFileSync(cache_file(), JSON.stringify(cache));
}
const is_reused = (graph: Awaited<ReturnType<typeof check_equal>>, doc_path: string): boolean => graph.docs[doc_path]!.refs.some((reference) => reference.target === 'PLANTED-MARKER');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'graph-commit-'));
  docs = join(dir, '.documentation');
  git('init', '-q', '-b', 'main');
  put('.gitignore', '.hewtd/\n');
  put('src/a.ts', 'export function widgetRetry() {}\n');
  put('src/b.ts', 'export const B = 1;\n');
  put('.documentation/guides/one.md', doc('See `src/a.ts` and `widgetRetry()`.'));
  put('.documentation/guides/two.md', doc('See [one](./one.md).', 'src/b.ts'));
  put('.documentation/guides/three.md', doc('Only `src/b.ts` here.', 'src/b.ts'));
  put('.documentation/guides/four.md', doc('Standalone prose about `src/a.ts`.'));
  git('add', '-A'); git('commit', '-qm', 'one');
  config = await load_plugin_config(dir);
  await check_equal();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const commit = (message: string): void => { git('add', '-A'); git('commit', '-qm', message); };
const UNTOUCHED = ['guides/three.md', 'guides/four.md'];

describe('a commit leaves per-doc entries reusable unless code changed', () => {
  it('a docs-only commit re-resolves only the docs it touched (and docs linking to them)', async () => {
    plant('guides/one.md', 'guides/two.md', ...UNTOUCHED);
    put('.documentation/guides/one.md', doc('See `src/a.ts`, committed edit.'));
    commit('docs only');
    const graph = await check_equal();
    expect(is_reused(graph, 'guides/one.md')).toBe(false);
    expect(is_reused(graph, 'guides/two.md')).toBe(false);
    for (const other of UNTOUCHED) expect(is_reused(graph, other)).toBe(true);
  });

  it('two docs-only commits between runs', async () => {
    plant(...UNTOUCHED);
    put('.documentation/guides/one.md', doc('First again.'));
    commit('docs a');
    put('.documentation/guides/two.md', doc('Second change.', 'src/b.ts'));
    commit('docs b');
    const graph = await check_equal();
    for (const other of UNTOUCHED) expect(is_reused(graph, other)).toBe(true);
  });

  it('a docs commit that renames a doc', async () => {
    plant(...UNTOUCHED);
    git('mv', '.documentation/guides/one.md', '.documentation/guides/uno.md');
    commit('rename doc');
    const graph = await check_equal();
    expect(graph.docs['guides/uno.md']).toBeDefined();
    for (const other of UNTOUCHED) expect(is_reused(graph, other)).toBe(true);
  });

  it('a commit of a non-kept doc (archive/) is not missed', async () => {
    plant(...UNTOUCHED);
    put('.documentation/archive/old.md', doc('Archived.'));
    commit('archive doc');
    await check_equal();
  });

  it('a commit plus an uncommitted edit', async () => {
    plant(...UNTOUCHED);
    put('.documentation/guides/three.md', doc('Committed.', 'src/b.ts'));
    commit('docs three');
    put('.documentation/guides/four.md', doc('Uncommitted edit about `src/a.ts`.'));
    const graph = await check_equal();
    expect(is_reused(graph, 'guides/three.md')).toBe(false);
    expect(is_reused(graph, 'guides/four.md')).toBe(false);
    commit('docs four');
    await check_equal();
  });

  it('a code commit reuses the docs that do not read the changed file (#82)', async () => {
    plant(...UNTOUCHED);
    put('src/b.ts', 'export const B = 2;\n');
    commit('code');
    const graph = await check_equal();
    expect(is_reused(graph, 'guides/three.md')).toBe(false); // cites src/b.ts
    expect(is_reused(graph, 'guides/four.md')).toBe(true);
  });

  it('amend and rebase (cached head no longer an ancestor) take the full path', async () => {
    plant(...UNTOUCHED);
    put('.documentation/guides/four.md', doc('Amended.'));
    git('add', '-A'); git('commit', '-q', '--amend', '-m', 'amended');
    const graph = await check_equal();
    for (const other of UNTOUCHED) expect(is_reused(graph, other)).toBe(false);
  });

  it('a branch switch', async () => {
    git('checkout', '-q', '-b', 'side');
    put('.documentation/guides/three.md', doc('On the side branch.', 'src/b.ts'));
    commit('side');
    await check_equal();
    git('checkout', '-q', 'main');
    const graph = await check_equal();
    expect(graph.docs['guides/three.md']).toBeDefined();
  });
});
