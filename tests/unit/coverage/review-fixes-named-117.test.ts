import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plugin_config_schema } from '../../../src/utils/config.js';
import { run_coverage } from '../../../src/core/coverage/coverage.js';
import { resolve_decision, is_hub_doc, type DocText } from '../../../src/core/coverage/decide.js';
import { grade_surfaces } from '../../../src/core/coverage/grade.js';
import type { CoverageMiss } from '../../../src/core/coverage/facets.js';
import type { Surface } from '../../../src/core/coverage/surfaces/index.js';

const doc = (path: string, text: string, sources: string[] = []): DocText => ({ path, text, sources });
const miss = (query: string, facets: string[], extra: Partial<CoverageMiss> = {}): CoverageMiss => ({ key: 'q', query, count: 1, facets, ...extra });
const code = (...entries: Array<[string, string, number]>) => new Map(entries.map(([facet, file, line]) => [facet, [{ file, line }]] as const));
const none = new Map();
const surface = (kind: Surface['kind'], name: string, file: string): Surface => ({ kind, name, file, line: 1, source_kind: 'x' });

describe('finding 1: a named surface extends the doc that names it', () => {
  let repo: string;
  const w = (p: string, t: string): void => { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), t); };
  it('is extend, not covered, with the located line for the judge and no ranking note', async () => {
    repo = mkdtempSync(join(tmpdir(), 'named-'));
    try {
      w('.documentation/ops/alert-list.md', '---\ntitle: Alert list\ntier: guide\ndomains: [ops]\nstatus: active\n---\n# Alert list\n\nRules: QueueBacklog.\n');
      w('.documentation/ops/index.md', '---\ntitle: Index\ntier: index\ndomains: [ops]\nstatus: active\n---\n# Index\n\nQueueBacklog\n');
      w('monitoring/rules.yml', 'groups:\n- rules:\n  - alert: QueueBacklog\n    expr: queue_depth > 100\n');
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
      const report = await run_coverage({ repo_root: repo, docs_root: join(repo, '.documentation'), config: plugin_config_schema.parse({}), today: '2026-11-15' });
      expect(report.surfaces.find((s) => s.name === 'QueueBacklog')?.grade).toBe('named');
      const decision = report.plan!.decisions[0]!;
      expect(decision).toMatchObject({ kind: 'extend', doc: 'ops/alert-list.md' });
      expect(decision.notes.join(' ')).not.toMatch(/ranking/);
      const entry = report.plan!.drafts.entries[0]!;
      expect(entry).toMatchObject({ path: 'ops/alert-list.md', verdict: null });
      expect(entry.for_judge?.[0]?.at).toEqual(['monitoring/rules.yml:3']);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
  it('prefers a non-knowledge-base doc, and one that cites the source', () => {
    const kb = doc('knowledge-base/facts/q.md', 'QueueBacklog');
    const plain = doc('ops/a.md', 'QueueBacklog');
    const cites = doc('ops/z.md', 'QueueBacklog', ['monitoring/rules.yml']);
    const d = resolve_decision(miss('What does it do?', ['QueueBacklog'], { named: true }), { code: code(['QueueBacklog', 'monitoring/rules.yml', 3]), instructions: none }, [kb, plain, cites]);
    expect(d).toMatchObject({ kind: 'extend', doc: 'ops/z.md', missing_facets: ['QueueBacklog'] });
  });
  it('a name only in a knowledge-base doc is never extended', () => {
    const kb = doc('knowledge-base/facts/q.md', 'QueueBacklog');
    const d = resolve_decision(miss('What does it do?', ['QueueBacklog'], { named: true }), { code: code(['QueueBacklog', 'monitoring/rules.yml', 3]), instructions: none }, [kb]);
    expect(d.kind).toBe('new');
  });
});

describe('finding 2: a name in a list of identifiers is named only', () => {
  const s = surface('scheduled-job', 'purge-trials', 'app/jobs.py');
  const grade = (text: string) => grade_surfaces([s], [doc('ops/jobs.md', text, ['app/jobs.py'])])[0]!.grade;
  it('comma list', () => expect(grade('Scheduled: purge-trials, send-digest, rotate-logs, nightly')).toBe('named'));
  it('bullet list on one line', () => expect(grade('- purge-trials, send-digest, rotate-logs')).toBe('named'));
  it('a sentence about that one name still explains it', () => {
    expect(grade('Scheduled: purge-trials, send-digest, rotate-logs.\n\npurge-trials removes expired trial accounts every night.')).toBe('explained');
  });
  it('prose with commas is still a purpose', () => expect(grade('purge-trials removes expired trial accounts, logs the count, and stops.')).toBe('explained'));
});

describe('finding 3: and/or and URLs are not paths', () => {
  it('a prose runbook of and/or bullets is not a hub', () => {
    const body = ['# Runbook', '', '- restart and/or reload the worker', '- check logs and/or metrics', '- page and/or email on-call', '- yes/no: is it down', '- scale up and/or down', '- see https://example.com/status/page for state'].join('\n');
    expect(is_hub_doc(doc('ops/runbook.md', body))).toBe(false);
  });
  it('a real file map still is', () => {
    const body = ['# Map', '', ...['src/a/b.ts', 'src/c.py', 'lib/d', 'app/e/f', 'deploy/g.yaml', 'tests/h'].map((p) => `- ${p} - part`)].join('\n');
    expect(is_hub_doc(doc('ops/map.md', body))).toBe(true);
  });
});

describe('finding 4: one shared generic noun is not relevance', () => {
  const shared = 'src/scheduler/base.py';
  it('"email" alone does not make "Email provider rate limits" relevant', () => {
    const limits = doc('ops/email-limits.md', '---\ntitle: Email provider rate limits\npurpose: Provider rate limits\n---\n# Email provider rate limits\n', [shared]);
    const d = resolve_decision(miss('what is the trial email schedule', ['zz_facet_one', 'zz_facet_two']), { code: code(['zz_facet_one', shared, 1]), instructions: none }, [limits]);
    expect(d.kind).toBe('new');
  });
  it('two distinctive shared terms qualify', () => {
    const d1 = doc('ops/trial-digest.md', '---\ntitle: Trial digest cadence\n---\n# Trial digest cadence\n', [shared]);
    expect(resolve_decision(miss('when is the trial digest sent', ['zz_facet_one', 'zz_facet_two']), { code: code(['zz_facet_one', shared, 1]), instructions: none }, [d1]).kind).toBe('extend');
  });
  it('one identifier-like shared term qualifies', () => {
    const d1 = doc('ops/trial-days.md', '---\ntitle: trial_email_days\n---\n# trial_email_days\n', [shared]);
    expect(resolve_decision(miss('what is trial_email_days', ['zz_facet_one', 'zz_facet_two']), { code: code(['zz_facet_one', shared, 1]), instructions: none }, [d1]).kind).toBe('extend');
  });
});

describe('finding 5: the eval nearest doc needs a distinctive facet and a relevance or citation check', () => {
  it('a generic facet absent from the code does not win', () => {
    const near = doc('ops/z-near.md', 'subscription is not renewed in some cases');
    const d = resolve_decision(miss('how does retry backoff work', ['not renewed', 'zz_other_one', 'zz_third_one'], { nearest_doc: { path: 'ops/z-near.md', facet_coverage: '1/3', rank: 1 } }), { code: code(['zz_other_one', 'src/q.py', 5]), instructions: none }, [near]);
    expect(d.kind).toBe('new');
  });
  it('a located, identifier-like facet still wins when the doc is relevant', () => {
    const near = doc('ops/z-near.md', 'retry backoff uses nn_one here');
    const d = resolve_decision(miss('how does retry backoff work', ['nn_one', 'nn_two', 'nn_three'], { nearest_doc: { path: 'ops/z-near.md', facet_coverage: '1/3', rank: 1 } }), { code: code(['nn_one', 'src/q.py', 5]), instructions: none }, [near]);
    expect(d).toMatchObject({ kind: 'extend', doc: 'ops/z-near.md' });
  });
});
