import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
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

/** Cold build of the tree as it is now, without touching the cache the incremental run left behind. */
async function cold(): Promise<string> {
  const saved = existsSync(cache_file()) ? readFileSync(cache_file(), 'utf-8') : null;
  rmSync(cache_file(), { force: true });
  const text = render_graph(await build_graph({ root: dir, docs_root: docs, config, dry_run: true }));
  if (saved !== null) writeFileSync(cache_file(), saved);
  return text;
}
async function incremental_equals_cold(next_config = config): Promise<string> {
  const result = await write_graph({ root: dir, docs_root: docs, config: next_config });
  const text = readFileSync(graph_file(), 'utf-8');
  expect(text).toBe(await cold());
  return result.status;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'graph-inc-'));
  docs = join(dir, '.documentation');
  git('init', '-q');
  put('src/a.ts', 'export function widgetRetry() {}\n');
  put('src/b.ts', 'export const B = 1;\n');
  put('.documentation/guides/one.md', doc('See `src/a.ts`, `widgetRetry()` and `lateSymbol()`.'));
  put('.documentation/guides/two.md', doc('See `src/b.ts` and [one](./one.md).', 'src/b.ts'));
  git('add', '-A'); git('commit', '-qm', 'one');
  put('src/a.ts', 'export function widgetRetry() { return 1; }\n');
  git('add', '-A'); git('commit', '-qm', 'two');
  config = await load_plugin_config(dir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('incremental graph export equals a cold build', () => {
  it('first build writes the graph and the cache', async () => {
    expect(await incremental_equals_cold()).toBe('written');
    expect(existsSync(cache_file())).toBe(true);
  });

  it('an unchanged tree is skipped without a rebuild (graph.json mtime kept)', async () => {
    const before = statSync(graph_file()).mtimeMs;
    rmSync(join(dir, '.documentation/guides/INDEX.md'), { force: true });
    expect(await incremental_equals_cold()).toBe('unchanged');
    expect(statSync(graph_file()).mtimeMs).toBe(before);
  });

  it.each([
    ['a doc body', () => put('.documentation/guides/two.md', doc('See `src/b.ts` again, now `src/nope.ts` too.', 'src/b.ts'))],
    ['a cited code file (uncommitted)', () => put('src/a.ts', 'export function widgetRetry() { return 2; }\n')],
    ['a new code file defining a missing symbol', () => { put('src/late.ts', 'export function lateSymbol() {}\n'); git('add', '-A'); }],
    ['a deleted cited file', () => { rmSync(join(dir, 'src/b.ts')); git('add', '-A'); }],
    ['the ledger', () => put('.hewtd/reconcile.json', JSON.stringify({ version: 1, entries: { 'guides/one.md': { path: 'guides/one.md', lane: 'check', verdict: 'verify', content_hash: 'x' } } }))],
    ['a new commit', () => { git('add', '-A'); git('commit', '-qm', 'three'); }],
  ])('after %s', async (_name, change) => {
    change();
    await incremental_equals_cold(); // the graph may legitimately not change (uncommitted code edit); it must never differ from cold
  });

  it('after a config change', async () => {
    const next = { ...config, reconcile: { ...config.reconcile, team: { ...config.reconcile.team, min_docs: 99 } } };
    const status = await incremental_equals_cold(next);
    expect(['written', 'unchanged']).toContain(status);
  });

  it('a corrupt or old-version cache is ignored and rebuilt', async () => {
    writeFileSync(cache_file(), '{not json');
    put('src/b2.ts', 'export const B2 = 1;\n'); git('add', '-A');
    await incremental_equals_cold();
    writeFileSync(cache_file(), JSON.stringify({ cache_version: 0, fingerprint: { value: 'x', graph_hash: 'y' }, staleness: { head: 'z', entries: 5 } }));
    expect(await incremental_equals_cold()).toBe('unchanged');
  });

  it('--dry-run writes neither the graph nor any cache', async () => {
    rmSync(cache_file(), { force: true });
    const graph_before = readFileSync(graph_file(), 'utf-8');
    put('.documentation/guides/one.md', doc('Edited so the graph would change `src/a.ts`.'));
    const result = await write_graph({ root: dir, docs_root: docs, config, dry_run: true });
    expect(result.status).toBe('would-write');
    expect(readFileSync(graph_file(), 'utf-8')).toBe(graph_before);
    expect(existsSync(cache_file())).toBe(false);
  });
});
