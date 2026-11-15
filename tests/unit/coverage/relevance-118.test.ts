import { describe, it, expect } from 'vitest';
import { resolve_decision, is_hub_doc, type DocText } from '../../../src/core/coverage/decide.js';
import type { CoverageMiss } from '../../../src/core/coverage/facets.js';

const doc = (path: string, text: string, sources: string[] = [], source_refs?: DocText['source_refs']): DocText => ({ path, text, sources, ...(source_refs && { source_refs }) });
const miss = (query: string, facets: string[], extra: Partial<CoverageMiss> = {}): CoverageMiss => ({ key: 'q', query, count: 1, facets, ...extra });
const code = (...entries: Array<[string, string, number]>) => new Map(entries.map(([facet, file, line]) => [facet, [{ file, line }]] as const));
const none = new Map();

describe('rule 2 needs relevance (#118 section 1)', () => {
  const shared = 'src/scheduler/base.py';
  it('a short fact doc citing a shared file for an unrelated function, 0 facets, no shared terms -> new doc', () => {
    const unrelated = doc('knowledge-base/facts/postal-crosswalk.md', '# Postal crosswalk\n\nThe crosswalk API rate limit.', [shared]);
    const d = resolve_decision(miss('how is the trial email schedule defined', ['trial_email_days', 'send_trial_email']), { code: code(['trial_email_days', shared, 3]), instructions: none }, [unrelated]);
    expect(d.kind).toBe('new');
  });
  it('a citing doc that holds a facet qualifies', () => {
    const holder = doc('ops/holder.md', 'trial_email_days is mentioned', [shared]);
    const d = resolve_decision(miss('how is the trial email schedule defined', ['trial_email_days', 'send_trial_email', 'other_thing_here']), { code: code(['send_trial_email', shared, 3]), instructions: none }, [holder]);
    expect(d).toMatchObject({ kind: 'extend', doc: 'ops/holder.md' });
  });
  it('a citing doc whose title or purpose overlaps the question qualifies (alerts runbook)', () => {
    const runbook = doc('ops/alerts-runbook.md', '---\ntitle: Alerts runbook\npurpose: What each alert rule means\n---\n# Alerts runbook\n', ['src/alerts/rules.yml']);
    const unrelated = doc('ops/cache.md', '# Cache refresh cost', ['src/alerts/rules.yml']);
    const d = resolve_decision(miss('which alert rules fire on exporter failure', ['alert_exporter_down', 'alert_scrape_failed']), { code: code(['alert_exporter_down', 'src/alerts/rules.yml', 9]), instructions: none }, [unrelated, runbook]);
    expect(d).toMatchObject({ kind: 'extend', doc: 'ops/alerts-runbook.md' });
  });
  it('a citing doc sharing distinctive terms in its body qualifies; stop and generic words do not count', () => {
    const generic = doc('ops/generic.md', 'how does the system work and what is the value', [shared]);
    expect(resolve_decision(miss('how does the system work and what is the value', ['zz_facet_one', 'zz_facet_two']), { code: code(['zz_facet_one', shared, 1]), instructions: none }, [generic]).kind).toBe('new');
    const body = doc('ops/cleanup.md', 'The cleanup schedule removes expired registration entries nightly.', [shared]);
    expect(resolve_decision(miss('when does the registration cleanup schedule run', ['zz_facet_one', 'zz_facet_two']), { code: code(['zz_facet_one', shared, 1]), instructions: none }, [body]).kind).toBe('extend');
  });
});

describe('file maps are hubs (#118 section 1)', () => {
  const map = ['# Monitoring file map', '', ...Array.from({ length: 8 }, (_, i) => `- \`src/monitoring/part${i}.py\` - part ${i}`)].join('\n');
  it('a body that is mostly a list of paths is a hub', () => {
    expect(is_hub_doc(doc('ops/monitoring-map.md', map))).toBe(true);
    expect(is_hub_doc(doc('ops/prose.md', '# Prose\n\nThis explains the retry policy in some detail.\n\n- see `src/a.ts` for the code\n'))).toBe(false);
  });
  it('a file map is not chosen as the specific citer', () => {
    const d = resolve_decision(miss('which alert rules fire', ['alert_one', 'alert_two']), { code: code(['alert_one', 'src/monitoring/part1.py', 2]), instructions: none }, [doc('ops/monitoring-map.md', map, ['src/monitoring/part1.py'])]);
    expect(d.kind).toBe('new');
  });
});

describe('citation granularity and the eval nearest doc (#118)', () => {
  it('a citer whose cited lines miss the facet lines loses to one that covers them', () => {
    const miss_lines = doc('ops/a-other-fn.md', 'retry backoff', ['src/q.py'], [{ path: 'src/q.py', lines: [[1, 10]] }]);
    const covers = doc('ops/b-this-fn.md', 'retry backoff', ['src/q.py'], [{ path: 'src/q.py', lines: [[40, 60]] }]);
    const d = resolve_decision(miss('how does retry backoff work', ['zz_a', 'zz_b']), { code: code(['zz_a', 'src/q.py', 50]), instructions: none }, [miss_lines, covers]);
    expect(d.doc).toBe('ops/b-this-fn.md');
  });
  it('without line data nothing changes (path granularity)', () => {
    const a = doc('ops/a.md', 'retry backoff', ['src/q.py']);
    const d = resolve_decision(miss('how does retry backoff work', ['zz_a', 'zz_b']), { code: code(['zz_a', 'src/q.py', 50]), instructions: none }, [a]);
    expect(d.doc).toBe('ops/a.md');
  });
  it('the eval nearest doc holding >= 1 facet beats a citing doc holding none', () => {
    const near = doc('ops/z-near.md', 'only nn_one is here');
    const citer = doc('ops/a-citer.md', 'retry backoff scheduler', ['src/q.py']);
    const d = resolve_decision(miss('how does retry backoff work', ['nn_one', 'nn_two', 'nn_three'], { nearest_doc: { path: 'ops/z-near.md', facet_coverage: '1/3', rank: 1 } }), { code: code(['nn_two', 'src/q.py', 5]), instructions: none }, [near, citer]);
    expect(d).toMatchObject({ kind: 'extend', doc: 'ops/z-near.md' });
  });
  it('a nearest doc holding no facet is not preferred', () => {
    const near = doc('ops/z-near.md', 'nothing');
    const d = resolve_decision(miss('how does retry backoff work', ['nn_one', 'nn_two']), { code: none, instructions: none }, [near]);
    expect(d.kind).toBe('new');
  });
});
