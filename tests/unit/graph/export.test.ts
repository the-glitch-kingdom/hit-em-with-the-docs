import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { load_plugin_config } from '../../../src/utils/config';
import { find_duplicates } from '../../../src/core/reconcile/duplicates';
import { compute_content_hash } from '../../../src/core/reconcile/ledger';
import { list_markdown_files, triage_docs } from '../../../src/core/reconcile/triage';
import { build_graph, render_graph } from '../../../src/core/graph/export';

let dir: string;
let docs: string;
const put = (rel: string, body: string, base = docs) => {
  mkdirSync(join(base, rel, '..'), { recursive: true });
  writeFileSync(join(base, rel), body);
};
const commit = (msg: string, date: string) => {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', msg], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
};
const steps = Array.from({ length: 8 }, (_, i) => `${i + 1}. Run the release step number ${i + 1} and confirm the pipeline reports green before tagging version ${i}.`).join('\n');
const filler = Array.from({ length: 400 }, (_, i) => `Admin note ${i}: rotate unrelated knob ${i * 7} weekly.`).join('\n');
const fm = (extra = '') => `---\ntitle: T\npurpose: Explains how the widget pipeline retries failed jobs after a timeout\nsources: [src/a.ts]\nlast_verified: 2026-01-01\n${extra}---\n`;
const verified_raw = fm() + 'See `src/a.ts` and `widgetRetry()`.\n';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-'));
  docs = join(dir, '.documentation');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  put('src/a.ts', 'export function widgetRetry() {}\n', dir);
  put('ops/verified.md', verified_raw);
  put('ops/missing.md', fm() + 'See `src/a.ts` and `src/nope.ts`.\n');
  put('procedures/release.md', `---\ntitle: Release procedure\npurpose: How to cut and tag a release\n---\n# Release procedure\n\n${steps}\n`);
  put('guides/admin.md', `---\ntitle: Admin\n---\n# Admin\n\n${filler}\n\n## Cutting a release\n\n${steps}\n`);
  put('plans/plan.md', '---\ntitle: P\ntier: plan\n---\nSee `src/ghost.ts`.\n');
  put('drafts/d.md', '---\ntitle: D\n---\nDraft.\n');
  put('ops/gen.md', '---\ntitle: G\ngenerated: true\n---\nGenerated.\n');
  put('.hewtd/reconcile.json', JSON.stringify({ version: 1, entries: {
    'ops/verified.md': { path: 'ops/verified.md', lane: 'clean', verdict: 'verify', content_hash: compute_content_hash(verified_raw) },
    'ops/missing.md': { path: 'ops/missing.md', lane: 'check', verdict: 'point', content_hash: 'x', pointer: { target: 'procedures/release.md#release-procedure', section_hash: 'h' } },
  } }), dir);
  commit('one', '2026-02-01T12:00:00');
  put('src/a.ts', 'export function widgetRetry() { return 1; }\n', dir);
  commit('two', '2026-04-01T12:00:00');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('buildGraph', () => {
  it('assembles the v1 graph from refs, dates, ledger and duplicates', async () => {
    const config = await load_plugin_config(dir);
    const g = await build_graph({ root: dir, docs_path: docs, config });
    expect(g.version).toBe(1);
    expect(g.source_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(g.docs)).toEqual(['drafts/d.md', 'guides/admin.md', 'ops/gen.md', 'ops/missing.md', 'ops/verified.md', 'plans/plan.md', 'procedures/release.md']); // triage's set, sorted
    expect(g.docs['plans/plan.md']!.refs).toEqual([{ kind: 'file', target: 'src/ghost.ts', resolved: false }]);
    expect(g.symbols.widgetRetry).toMatchObject({ file: 'src/a.ts', file_kind: 'definition' });
    expect(g.docs['ops/verified.md']!.refs[1]).toMatchObject({ file_kind: 'definition' });

    const v = g.docs['ops/verified.md']!;
    expect(v).toMatchObject({ verdict: 'verified', last_verified: '2026-01-01', body_changed: '2026-02-01' });
    expect(v.refs).toEqual([
      { kind: 'file', target: 'src/a.ts', resolved: true, code_changed: '2026-04-01' },
      { kind: 'symbol', target: 'widgetRetry', file: 'src/a.ts', file_kind: 'definition', resolved: true, code_changed: '2026-04-01' },
    ]);
    expect(g.symbols['widgetRetry']).toEqual({ file: 'src/a.ts', file_kind: 'definition', cited_by: ['ops/verified.md'] });

    // every triage `missing` is a resolved:false ref; every resolved file ref has code_changed
    const t = (await triage_docs({ root: dir, docs_path: docs, rels: Object.keys(g.docs), config })).docs;
    for (const d of t) for (const m of d.missing) expect(g.docs[d.path]!.refs).toContainEqual({ kind: 'file', target: m, resolved: false });
    for (const d of Object.values(g.docs)) for (const r of d.refs) if (r.kind === 'file' && r.resolved) expect(r.code_changed).toBeDefined();
    expect(g.docs['ops/missing.md']!.verdict).toBe('check');

    // pointer and duplicate data match the ledger and findDuplicates
    expect(g.docs['ops/missing.md']!.points_to).toEqual([{ from: null, to: 'procedures/release.md#release-procedure' }]);
    const dup = (await find_duplicates(docs, config)).get('guides/admin.md')![0]!;
    expect(g.docs['guides/admin.md']!.duplicates).toEqual([{ section: `#${dup.section}`, owner: `${dup.owner}#${dup.section}` }]);
    expect(g.docs['procedures/release.md']!.owner_of).toEqual(['procedures/release.md#release-procedure']);
  });

  it('exports exactly the docs triage judges', async () => {
    const config = await load_plugin_config(dir);
    const rels = (await list_markdown_files(docs)).map((f) => relative(docs, f));
    const judged = (await triage_docs({ root: dir, docs_path: docs, rels, config })).docs.map((d) => d.path).sort();
    expect(Object.keys((await build_graph({ root: dir, docs_path: docs, config })).docs).sort()).toEqual(judged);
    expect(judged).toEqual(expect.arrayContaining(['drafts/d.md', 'ops/gen.md', 'plans/plan.md']));
  });

  it('serializes deterministically with sorted keys and a trailing newline', async () => {
    const config = await load_plugin_config(dir);
    const a = render_graph(await build_graph({ root: dir, docs_path: docs, config }));
    const b = render_graph(await build_graph({ root: dir, docs_path: docs, config }));
    expect(a).toBe(b);
    expect(a.endsWith('}\n')).toBe(true);
    expect(a.indexOf('"docs"')).toBeLessThan(a.indexOf('"source_commit"'));
  });
});

describe('buildGraph review fixes', () => {
  let d2: string;
  let docs2: string;
  const put2 = (rel: string, body: string, base = docs2) => { mkdirSync(join(base, rel, '..'), { recursive: true }); writeFileSync(join(base, rel), body); };
  const OWNER = '---\ntitle: Deploy\n---\n# Deploy\n\n## Release\n\nRun `deploy.sh --canary` and wait 30 minutes.\n';
  const POINTING = fm() + 'Release: canary first. Details: [Deploy: Release](../ops/deploy.md#release)\n';
  beforeAll(() => {
    d2 = mkdtempSync(join(tmpdir(), 'graph2-'));
    docs2 = join(d2, '.documentation');
    execFileSync('git', ['init', '-q'], { cwd: d2 });
    put2('src/a.ts', 'export function widgetRetry() {}\n', d2);
    put2('ops/deploy.md', OWNER);
    put2('guides/pointing.md', POINTING);
    put2('guides/never.md', '---\ntitle: Never reconciled\n---\nSee `src/a.ts` and `src/gone.ts`.\n');
    put2('.hewtd/reconcile.json', JSON.stringify({ version: 1, entries: {
      'guides/pointing.md': { path: 'guides/pointing.md', lane: 'clean', verdict: 'verify', content_hash: compute_content_hash(POINTING), pointer: { target: 'ops/deploy.md#release', section_hash: 'hash-of-an-older-section' } },
    } }), d2);
    execFileSync('git', ['add', '-A'], { cwd: d2 });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: d2 });
  });
  afterAll(() => rmSync(d2, { recursive: true, force: true }));

  it('a verified doc whose pointer target changed is not reported verified', async () => {
    const g = await build_graph({ root: d2, docs_path: docs2, config: await load_plugin_config(d2) });
    expect(g.docs['guides/pointing.md']!.verdict).toBe('check');
  });

  it('a doc never through reconcile is unreviewed; the ledger file is not modified', async () => {
    const before = execFileSync('cat', [join(d2, '.hewtd/reconcile.json')], { encoding: 'utf-8' });
    const g = await build_graph({ root: d2, docs_path: docs2, config: await load_plugin_config(d2) });
    expect(g.docs['guides/never.md']!.verdict).toBe('unreviewed');
    expect(g.docs['guides/never.md']!.refs).toContainEqual({ kind: 'file', target: 'src/gone.ts', resolved: false });
    expect(execFileSync('cat', [join(d2, '.hewtd/reconcile.json')], { encoding: 'utf-8' })).toBe(before);
  });

  it('dry-run does not write the cache', async () => {
    rmSync(join(d2, '.hewtd/graph-cache.json'), { force: true });
    await build_graph({ root: d2, docs_path: docs2, config: await load_plugin_config(d2), dry_run: true });
    expect(execFileSync('ls', ['-a', join(d2, '.hewtd')], { encoding: 'utf-8' })).not.toContain('graph-cache.json');
  });
});
