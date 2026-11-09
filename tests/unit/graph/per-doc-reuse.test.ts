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
  dir = mkdtempSync(join(tmpdir(), 'graph-reuse-'));
  docs = join(dir, '.documentation');
  git('init', '-q');
  put('.gitignore', '.hewtd/\n');
  put('src/a.ts', 'export function widgetRetry() {}\n');
  put('src/b.ts', 'export const B = 1;\n');
  put('.documentation/guides/one.md', doc('See `src/a.ts` and `widgetRetry()`.'));
  put('.documentation/guides/two.md', doc('See [one](./one.md) and [later](./later.md).', 'src/b.ts'));
  put('.documentation/guides/three.md', doc('Only `src/b.ts` here.', 'src/b.ts'));
  put('.documentation/guides/four.md', doc('Standalone prose about `src/a.ts`.'));
  git('add', '-A'); git('commit', '-qm', 'one');
  config = await load_plugin_config(dir);
  await check_equal();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('per-doc reuse equals a cold build', () => {
  it('one doc body edit re-resolves only that doc', async () => {
    plant('guides/one.md', 'guides/two.md', 'guides/three.md', 'guides/four.md');
    put('.documentation/guides/four.md', doc('Standalone prose, edited, still about `src/a.ts`.'));
    const graph = await check_equal();
    expect(is_reused(graph, 'guides/four.md')).toBe(false);
    for (const other of ['guides/one.md', 'guides/two.md', 'guides/three.md']) expect(is_reused(graph, other)).toBe(true);
  });

  it('a doc added re-resolves docs whose link pointed at it', async () => {
    plant('guides/two.md', 'guides/three.md');
    put('.documentation/guides/later.md', doc('Now it exists.'));
    const graph = await check_equal();
    expect(is_reused(graph, 'guides/two.md')).toBe(false);
    expect(is_reused(graph, 'guides/three.md')).toBe(true);
  });

  it('a link target doc edited re-resolves the linking doc', async () => {
    plant('guides/two.md', 'guides/three.md');
    put('.documentation/guides/one.md', doc('See `src/a.ts`, edited.'));
    const graph = await check_equal();
    expect(is_reused(graph, 'guides/two.md')).toBe(false);
    expect(is_reused(graph, 'guides/three.md')).toBe(true);
  });

  it('a doc deleted re-resolves docs that linked to it', async () => {
    plant('guides/two.md', 'guides/three.md');
    rmSync(join(docs, 'guides/later.md'));
    const graph = await check_equal();
    expect(graph.docs['guides/later.md']).toBeUndefined();
    expect(is_reused(graph, 'guides/two.md')).toBe(false);
    expect(is_reused(graph, 'guides/three.md')).toBe(true);
  });

  it('a doc renamed', async () => {
    plant('guides/two.md', 'guides/three.md');
    renameSync(join(docs, 'guides/four.md'), join(docs, 'guides/five.md'));
    const graph = await check_equal();
    expect(graph.docs['guides/five.md']).toBeDefined();
    expect(is_reused(graph, 'guides/three.md')).toBe(true);
  });

  it('a ledger entry change re-resolves that doc only', async () => {
    plant('guides/three.md', 'guides/one.md');
    put('.hewtd/reconcile.json', JSON.stringify({ version: 1, entries: { 'guides/three.md': { path: 'guides/three.md', lane: 'check', verdict: 'verify', content_hash: 'x' } } }));
    const graph = await check_equal();
    expect(is_reused(graph, 'guides/three.md')).toBe(false);
    expect(is_reused(graph, 'guides/one.md')).toBe(true);
  });

  it('a pointer target doc edited re-resolves the pointing doc', async () => {
    put('.hewtd/reconcile.json', JSON.stringify({ version: 1, entries: { 'guides/three.md': { path: 'guides/three.md', lane: 'check', verdict: 'point', content_hash: 'x', pointer: { target: 'guides/one.md#top', section_hash: 'y' } } } }));
    await check_equal();
    plant('guides/three.md', 'guides/five.md');
    put('.documentation/guides/one.md', doc('See `src/a.ts`, edited again.'));
    const graph = await check_equal();
    expect(is_reused(graph, 'guides/three.md')).toBe(false);
    expect(is_reused(graph, 'guides/five.md')).toBe(true);
  });

  it('a config change rebuilds every doc', async () => {
    plant('guides/one.md', 'guides/five.md');
    const next = { ...config, reconcile: { ...config.reconcile, team: { ...config.reconcile.team, min_docs: 99 } } };
    put('.documentation/guides/five.md', doc('Config run, edited.'));
    const graph = await check_equal(next);
    expect(is_reused(graph, 'guides/one.md')).toBe(false);
  });

  it('a code file edit falls back to the full path', async () => {
    plant('guides/one.md', 'guides/three.md');
    put('src/a.ts', 'export function widgetRetry() { return 2; }\n');
    put('.documentation/guides/five.md', doc('Code edit run, edited.'));
    const graph = await check_equal();
    expect(is_reused(graph, 'guides/one.md')).toBe(false);
    expect(is_reused(graph, 'guides/three.md')).toBe(false);
  });

  it('a name only another doc mentions flips when that mention goes away', async () => {
    put('.documentation/guides/one.md', doc('Uses `externalThing()` from a vendor.'));
    put('.documentation/guides/three.md', doc('Also `externalThing()` from the vendor.', 'src/b.ts'));
    git('add', '-A'); git('commit', '-qm', 'mentions');
    await check_equal();
    plant('guides/one.md');
    put('.documentation/guides/three.md', doc('No mention any more.', 'src/b.ts'));
    const graph = await check_equal();
    expect(is_reused(graph, 'guides/one.md')).toBe(false); // was unknown (mentioned elsewhere), now missing
  });

  it('a link to a non-kept doc (archive/) follows that file being created and deleted', async () => {
    put('.documentation/guides/six.md', doc('See [old](../archive/old.md#gone-heading).', 'src/b.ts'));
    await check_equal();
    const resolved = async () => (await check_equal()).docs['guides/six.md']!.refs.find((reference) => reference.target.startsWith('../archive'));
    expect(await resolved()).toMatchObject({ resolved: false });
    put('.documentation/archive/old.md', '# Old\n\n## Gone heading\n');
    expect(await resolved()).toMatchObject({ resolved: true });
    rmSync(join(docs, 'archive/old.md'));
    expect(await resolved()).toMatchObject({ resolved: false });
  });

  it('a non-kept link target changing leaves unrelated entries reused', async () => {
    plant('guides/three.md');
    put('.documentation/archive/old.md', '# Old\n\n## Gone heading\n');
    expect(is_reused(await check_equal(), 'guides/three.md')).toBe(true);
  });

  it('installing and removing a node_modules/.bin tool re-resolves its npx refs', async () => {
    put('.documentation/guides/seven.md', doc('Run `npx widgetbin-zz` first.', 'src/b.ts'));
    const status = async () => (await check_equal()).docs['guides/seven.md']!.refs.find((reference) => reference.target.includes('widgetbin-zz'));
    const before = await status();
    expect(before).toBeDefined();
    put('node_modules/.bin/widgetbin-zz', '#!/bin/sh\n');
    expect(await status()).toMatchObject({ resolved: true });
    rmSync(join(dir, 'node_modules'), { recursive: true });
    expect(await status()).toMatchObject({ resolved: before!.resolved });
  });

  it('--dry-run writes no cache', async () => {
    const before = readFileSync(cache_file(), 'utf-8');
    put('.documentation/guides/five.md', doc('Dry run edit.'));
    await write_graph({ root: dir, docs_root: docs, config, dry_run: true });
    expect(readFileSync(cache_file(), 'utf-8')).toBe(before);
  });
});
