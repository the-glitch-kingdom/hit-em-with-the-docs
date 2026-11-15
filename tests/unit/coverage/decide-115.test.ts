import { describe, it, expect } from 'vitest';
import { resolve_decision, is_hub_doc, EXTEND_MIN_SHARE, SPECIFIC_MAX_SOURCES, type DocText } from '../../../src/core/coverage/decide.js';
import { merge_decisions } from '../../../src/core/coverage/merge.js';
import type { Decision } from '../../../src/core/coverage/decide.js';
import type { CoverageMiss } from '../../../src/core/coverage/facets.js';

const doc = (path: string, text: string, sources: string[] = []): DocText => ({ path, text, sources });
const miss = (facets: string[], extra: Partial<CoverageMiss> = {}): CoverageMiss => ({ key: 'q', query: 'how does it work', count: 1, facets, ...extra });
const code = (...entries: Array<[string, string, number]>) => new Map(entries.map(([facet, file, line]) => [facet, [{ file, line }]] as const));
const none = new Map();

describe('target order (#115 problems 1 and 2)', () => {
  it('best coverage beats cited-by: A holds 3/4, B only cites the file among 10 others', () => {
    const a = doc('ops/a.md', 'alpha_one alpha_two alpha_three');
    const b = doc('ops/b.md', 'unrelated', ['src/x.ts', ...Array.from({ length: 10 }, (_, i) => `src/o${i}.ts`)]);
    const d = resolve_decision(miss(['alpha_one', 'alpha_two', 'alpha_three', 'alpha_four']), { code: code(['alpha_four', 'src/x.ts', 3]), instructions: none }, [a, b]);
    expect(d).toMatchObject({ kind: 'extend', doc: 'ops/a.md', held: 3, missing_facets: ['alpha_four'] });
  });
  it('the eval nearest doc wins only a tie; a better doc beats it', () => {
    const near = doc('ops/near.md', 'beta_one');
    const best = doc('ops/best.md', 'beta_one beta_two beta_three');
    const eval_near = { nearest_doc: { path: 'ops/near.md', facet_coverage: '1/4', rank: 2 } };
    expect(resolve_decision(miss(['beta_one', 'beta_two', 'beta_three', 'beta_four'], eval_near), { code: none, instructions: none }, [near, best]).doc).toBe('ops/best.md');
    const tie = doc('ops/a-tie.md', 'beta_one beta_two');
    const tie_near = doc('ops/z-tie.md', 'beta_one beta_two');
    const eval_tie = { nearest_doc: { path: 'ops/z-tie.md', facet_coverage: '2/4', rank: 2 } };
    expect(resolve_decision(miss(['beta_one', 'beta_two', 'beta_three', 'beta_four'], eval_tie), { code: none, instructions: none }, [tie, tie_near]).doc).toBe('ops/z-tie.md');
  });
  it('ties break on fewer sources, then path', () => {
    const wide = doc('ops/a.md', 'gam_one gam_two', ['s/1.ts', 's/2.ts', 's/3.ts']);
    const narrow = doc('ops/b.md', 'gam_one gam_two', ['s/1.ts']);
    expect(resolve_decision(miss(['gam_one', 'gam_two', 'gam_three']), { code: none, instructions: none }, [wide, narrow]).doc).toBe('ops/b.md');
  });
  it('unrelated citer: a pure function cited only by an incident narrative gets a new doc, domain from nearby code', () => {
    const incident = doc('knowledge-base/incidents/login-rollout.md', 'login rollout story', ['src/finance/round.ts']);
    const nearby = doc('finance/ledger.md', 'ledger', ['src/finance/ledger.ts']);
    const d = resolve_decision(miss(['round_half_even', 'banker_mode']), { code: code(['round_half_even', 'src/finance/round.ts', 4]), instructions: none }, [incident, nearby]);
    expect(d).toMatchObject({ kind: 'new', domain: 'finance', source_files: ['src/finance/round.ts'] });
  });
  it('topic absent: no doc holds a facet and none cites the source -> new doc', () => {
    const d = resolve_decision(miss(['zzz_one', 'zzz_two']), { code: code(['zzz_one', 'src/z.ts', 1]), instructions: none }, [doc('ops/a.md', 'nothing', ['src/q.ts'])]);
    expect(d.kind).toBe('new');
  });
  it('0-1 of 3-4 facets with only a broad citer -> new doc', () => {
    const broad = doc('ops/broad.md', 'dlt_one', ['src/x.ts', ...Array.from({ length: SPECIFIC_MAX_SOURCES }, (_, i) => `src/o${i}.ts`)]);
    const d = resolve_decision(miss(['dlt_one', 'dlt_two', 'dlt_three', 'dlt_four']), { code: code(['dlt_two', 'src/x.ts', 1]), instructions: none }, [broad]);
    expect(d.kind).toBe('new');
  });
  it('a specific citer is chosen among citers (fewest sources, most facets)', () => {
    const wide = doc('ops/wide.md', 'x', ['src/x.ts', 'a', 'b', 'c']);
    const tight = doc('ops/tight.md', 'x', ['src/x.ts']);
    const d = resolve_decision(miss(['eps_one', 'eps_two']), { code: code(['eps_one', 'src/x.ts', 1]), instructions: none }, [wide, tight]);
    expect(d).toMatchObject({ kind: 'extend', doc: 'ops/tight.md' });
  });
  it('covered stays covered, even when the doc is an overview', () => {
    expect(EXTEND_MIN_SHARE).toBe(0.5);
    const d = resolve_decision(miss(['eta_one', 'eta_two']), { code: none, instructions: none }, [doc('architecture/overview.md', 'eta_one eta_two')]);
    expect(d.kind).toBe('covered');
  });
});

describe('hub docs (#115 problem 3)', () => {
  it('recognises hubs by name, tier, kind, generated, folder, incident and breadth', () => {
    const fm = (body: string) => `---\n${body}\n---\ntext`;
    for (const d of [
      doc('architecture/overview.md', 'x'), doc('ops/INDEX.md', 'x'), doc('ops/README.md', 'x'), doc('api/index-of-things.md', 'x'),
      doc('a/b.md', fm('tier: reference')), doc('a/c.md', fm('kind: overview')), doc('a/d.md', fm('generated: true')),
      doc('archive/old.md', 'x'), doc('knowledge-base/incidents/i1/narrative.md', 'x'), doc('knowledge-base/incidents/flat.md', 'x'),
      doc('a/e.md', fm('tier: incident-narrative')), doc('a/f.md', 'x', Array.from({ length: 16 }, (_, i) => `s/${i}.ts`)),
    ]) expect(is_hub_doc(d), d.path).toBe(true);
    expect(is_hub_doc(doc('ops/queue.md', fm('tier: guide'), ['s/a.ts']))).toBe(false);
  });
  it('a hub that merely cites the source is never chosen; a hub is a last resort only by coverage', () => {
    const hub = doc('architecture/overview.md', 'x', ['src/x.ts']);
    expect(resolve_decision(miss(['th_one', 'th_two']), { code: code(['th_one', 'src/x.ts', 1]), instructions: none }, [hub]).kind).toBe('new');
    const holds = doc('architecture/overview.md', 'th_one th_two th_three');
    const real = doc('ops/real.md', 'th_one th_two');
    expect(resolve_decision(miss(['th_one', 'th_two', 'th_three', 'th_four']), { code: none, instructions: none }, [holds, real]).doc).toBe('ops/real.md');
  });
});

const dec = (key: string, kind: Decision['kind'], extra: Partial<Decision> = {}): Decision => ({ key, query: `q ${key}`, count: 1, kind, held: 0, total: 2, missing_facets: [`f_${key}`], sources: [], source_files: [], cited_by: [], flags: [], notes: [], ids: [key], ...extra });
describe('merge rules (#115 problem 3)', () => {
  it('two unrelated misses sharing only a hub target stay two proposals', () => {
    const r = merge_decisions([dec('a', 'extend', { doc: 'architecture/overview.md', hub: true, source_files: ['src/db.ts'], sources: [{ file: 'src/db.ts', line: 1 }] }), dec('b', 'extend', { doc: 'architecture/overview.md', hub: true, source_files: ['src/metrics.ts'], sources: [{ file: 'src/metrics.ts', line: 1 }] })]);
    expect(r).toHaveLength(2);
  });
  it('two misses whose facets live in one source file become one proposal', () => {
    const shared = { source_files: ['ops/alerts.yml'], sources: [{ file: 'ops/alerts.yml', line: 1 }] };
    const r = merge_decisions([dec('a', 'new', shared), dec('b', 'new', shared)]);
    expect(r).toHaveLength(1);
    expect(r[0]!.closes.map((c) => c.key)).toEqual(['a', 'b']);
  });
  it('misses extending different docs never merge, even on a shared file', () => {
    const shared = { source_files: ['src/q.ts'], sources: [{ file: 'src/q.ts', line: 1 }] };
    expect(merge_decisions([dec('a', 'extend', { doc: 'ops/a.md', ...shared }), dec('b', 'extend', { doc: 'ops/b.md', ...shared })])).toHaveLength(2);
  });
});

describe('a hub that is the only doc holding facets (validation edge)', () => {
  it('is still chosen to extend by coverage, flagged as a hub, rather than a new doc', () => {
    const hub = doc('architecture/overview.md', 'th_one th_two th_three');
    const r = resolve_decision(miss(['th_one', 'th_two', 'th_three', 'th_four']), { code: none, instructions: none }, [hub]);
    expect(r.doc).toBe('architecture/overview.md');
    expect(r.hub).toBe(true);
  });
});
