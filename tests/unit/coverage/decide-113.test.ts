import { describe, it, expect } from 'vitest';
import { resolve_decision, type DocText } from '../../../src/core/coverage/decide.js';
import type { CoverageMiss } from '../../../src/core/coverage/facets.js';

const doc = (path: string, text: string, sources: string[] = []): DocText => ({ path, text, sources });
const miss = (facets: string[], extra: Partial<CoverageMiss> = {}): CoverageMiss => ({ key: 'q', query: 'how does it work', count: 1, facets, ...extra });
const code = (...entries: Array<[string, string, number]>) => new Map(entries.map(([facet, file, line]) => [facet, [{ file, line }]] as const));

describe('resolve_decision (#113)', () => {
  const docs = [
    doc('ops/cache.md', 'The cache_ttl is set once. refresh_token rotates.', ['src/cache.ts']),
    doc('ops/queue.md', 'Queue docs mention max_retries only.'),
  ];
  it('extend: one doc holds most facets; lists the missing ones and the located sources', () => {
    const d = resolve_decision(miss(['cache_ttl', 'refresh_token', 'purge_interval']), { code: code(['purge_interval', 'src/cache.ts', 9]), instructions: new Map() }, docs);
    expect(d).toMatchObject({ kind: 'extend', doc: 'ops/cache.md', held: 2, total: 3, missing_facets: ['purge_interval'], source_files: ['src/cache.ts'] });
  });
  it('new: no doc holds more than a small share and none cites the source', () => {
    const d = resolve_decision(miss(['alpha_job', 'beta_job', 'gamma_job', 'delta_job']), { code: code(['alpha_job', 'src/jobs/a.ts', 1], ['beta_job', 'src/jobs/b.ts', 2]), instructions: new Map() }, [...docs, doc('ops/x.md', 'nothing here', ['src/other.ts'])]);
    expect(d.kind).toBe('new');
    expect(d.source_files).toEqual(['src/jobs/a.ts', 'src/jobs/b.ts']);
  });
  it('extend by graph signal: a doc already citing the located source is the home, though it holds no facet', () => {
    // #118: a citing doc with no facet must also be about the question (here: the cache), so the question names it
    const d = resolve_decision(miss(['purge_interval', 'other_thing'], { query: 'how often does the cache purge run' }), { code: code(['purge_interval', 'src/cache.ts', 9]), instructions: new Map() }, docs);
    expect(d).toMatchObject({ kind: 'extend', doc: 'ops/cache.md', held: 0 });
    expect(d.cited_by).toEqual(['ops/cache.md']);
  });
  it('covered: a doc holds every facet; the eval rank rides along', () => {
    const d = resolve_decision(miss(['cache_ttl', 'refresh_token'], { nearest_doc: { path: 'ops/cache.md', facet_coverage: '2/2', rank: 7 } }), { code: new Map(), instructions: new Map() }, docs);
    expect(d).toMatchObject({ kind: 'covered', doc: 'ops/cache.md', rank: 7 });
    expect(d.notes.join(' ')).toMatch(/rank 7/);
  });
  it('uses the eval nearest_doc and says when its own count disagrees', () => {
    const d = resolve_decision(miss(['max_retries', 'queue docs', 'purge_interval', 'x_y_z'], { nearest_doc: { path: 'ops/queue.md', facet_coverage: '3/4', rank: null } }), { code: code(['purge_interval', 'src/q.ts', 1]), instructions: new Map() }, docs);
    expect(d.doc).toBe('ops/queue.md');
    expect(d.notes.join(' ')).toMatch(/eval counts 3\/4.*hewtd counts 2\/4/);
  });
  it('instruction-only: facets found only in agent instruction files are unreachable by search', () => {
    const d = resolve_decision(miss(['nightly_vacuum']), { code: new Map(), instructions: new Map([['nightly_vacuum', [{ file: 'CLAUDE.md', line: 3 }]]]) }, docs);
    expect(d).toMatchObject({ kind: 'instruction-only', instruction_files: ['CLAUDE.md'] });
  });
  it('facet-shape: an outcome built only on code-line facets says so', () => {
    const d = resolve_decision(miss(['_TTL_SECONDS = 24 * 60 * 60']), { code: code(['_TTL_SECONDS = 24 * 60 * 60', 'src/c.ts', 2]), instructions: new Map() }, docs);
    expect(d.flags).toContain('facet-shape');
    expect(d.notes.join(' ')).toMatch(/facet shape/);
  });
  it('is deterministic', () => {
    const run = () => JSON.stringify(resolve_decision(miss(['cache_ttl', 'a_b_c']), { code: code(['a_b_c', 'src/z.ts', 1]), instructions: new Map() }, [...docs].reverse()));
    expect(run()).toBe(run());
  });
  it('new-doc domain follows the docs that cite code in the same folder', () => {
    const d = resolve_decision(miss(['zeta_job']), { code: code(['zeta_job', 'src/cache.ts', 1]), instructions: new Map() }, [doc('backend/c.md', 'x', ['src/cache2.ts']), doc('backend/d.md', 'y', ['src/zzz.ts'])]);
    expect(d.kind).toBe('new');
    expect(d.domain).toBe('backend');
  });
});
