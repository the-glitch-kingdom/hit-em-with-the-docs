import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadPluginConfig } from '../../../src/utils/config';
import { findDuplicates } from '../../../src/core/reconcile/duplicates';
import { hashContent } from '../../../src/core/reconcile/ledger';
import { triage } from '../../../src/core/reconcile/triage';
import { buildGraph, serializeGraph } from '../../../src/core/graph/export';

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
const verifiedRaw = fm() + 'See `src/a.ts` and `widgetRetry()`.\n';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-'));
  docs = join(dir, '.documentation');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  put('src/a.ts', 'export function widgetRetry() {}\n', dir);
  put('ops/verified.md', verifiedRaw);
  put('ops/missing.md', fm() + 'See `src/a.ts` and `src/nope.ts`.\n');
  put('procedures/release.md', `---\ntitle: Release procedure\npurpose: How to cut and tag a release\n---\n# Release procedure\n\n${steps}\n`);
  put('guides/admin.md', `---\ntitle: Admin\n---\n# Admin\n\n${filler}\n\n## Cutting a release\n\n${steps}\n`);
  put('ops/plan.md', '---\ntitle: P\ntier: plan\n---\nSee `src/ghost.ts`.\n');
  put('.hewtd/reconcile.json', JSON.stringify({ version: 1, entries: {
    'ops/verified.md': { path: 'ops/verified.md', lane: 'clean', verdict: 'verify', content_hash: hashContent(verifiedRaw) },
    'ops/missing.md': { path: 'ops/missing.md', lane: 'check', verdict: 'point', content_hash: 'x', pointer: { target: 'procedures/release.md#release-procedure', section_hash: 'h' } },
  } }), dir);
  commit('one', '2026-02-01T12:00:00');
  put('src/a.ts', 'export function widgetRetry() { return 1; }\n', dir);
  commit('two', '2026-04-01T12:00:00');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('buildGraph', () => {
  it('assembles the v1 graph from refs, dates, ledger and duplicates', async () => {
    const config = await loadPluginConfig(dir);
    const g = await buildGraph({ root: dir, docsPath: docs, config });
    expect(g.version).toBe(1);
    expect(g.source_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(g.docs)).toEqual(['guides/admin.md', 'ops/missing.md', 'ops/verified.md', 'procedures/release.md']); // plan tier excluded, sorted

    const v = g.docs['ops/verified.md']!;
    expect(v).toMatchObject({ verdict: 'verified', last_verified: '2026-01-01', body_changed: '2026-02-01' });
    expect(v.refs).toEqual([
      { kind: 'file', target: 'src/a.ts', resolved: true, code_changed: '2026-04-01' },
      { kind: 'symbol', target: 'widgetRetry', file: 'src/a.ts', resolved: true, code_changed: '2026-04-01' },
    ]);
    expect(g.symbols['widgetRetry']).toEqual({ file: 'src/a.ts', cited_by: ['ops/verified.md'] });

    // every triage `missing` is a resolved:false ref; every resolved file ref has code_changed
    const t = (await triage({ root: dir, docsPath: docs, rels: Object.keys(g.docs), config })).docs;
    for (const d of t) for (const m of d.missing) expect(g.docs[d.path]!.refs).toContainEqual({ kind: 'file', target: m, resolved: false });
    for (const d of Object.values(g.docs)) for (const r of d.refs) if (r.kind === 'file' && r.resolved) expect(r.code_changed).toBeDefined();
    expect(g.docs['ops/missing.md']!.verdict).toBe('check');

    // pointer and duplicate data match the ledger and findDuplicates
    expect(g.docs['ops/missing.md']!.points_to).toEqual([{ from: null, to: 'procedures/release.md#release-procedure' }]);
    const dup = (await findDuplicates(docs, config)).get('guides/admin.md')![0]!;
    expect(g.docs['guides/admin.md']!.duplicates).toEqual([{ section: `#${dup.section}`, owner: `${dup.owner}#${dup.section}` }]);
    expect(g.docs['procedures/release.md']!.owner_of).toEqual(['procedures/release.md#release-procedure']);
  });

  it('serializes deterministically with sorted keys and a trailing newline', async () => {
    const config = await loadPluginConfig(dir);
    const a = serializeGraph(await buildGraph({ root: dir, docsPath: docs, config }));
    const b = serializeGraph(await buildGraph({ root: dir, docsPath: docs, config }));
    expect(a).toBe(b);
    expect(a.endsWith('}\n')).toBe(true);
    expect(a.indexOf('"docs"')).toBeLessThan(a.indexOf('"source_commit"'));
  });
});
