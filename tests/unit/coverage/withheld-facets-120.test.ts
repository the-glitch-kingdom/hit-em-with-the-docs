// A facet that is only a value is carried as a count, never as text: it is not compiled, located, merged on, named or listed (#120).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan_coverage_misses } from '../../../src/core/coverage/plan.js';
import { render_gaps_report } from '../../../src/core/reconcile/gaps-report.js';
import { plugin_config_schema } from '../../../src/utils/config.js';

// built at run time so no real-shape secret literal sits in the repo
const pass = ['S3cr', '3tPass9'].join('');
const pass_two = ['Tr0ub4', 'dor9xyz'].join('');
let repo: string;
const write = (path: string, text: string): void => { mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), text); };
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'withheld-'));
  mkdirSync(join(repo, '.documentation/ops'), { recursive: true });
  writeFileSync(join(repo, '.documentation/ops/a.md'), '# a\n');
  write('src/boot.ts', `const DEFAULT_PASS = '${pass}';\nexport function start_worker() { return 1; }\n`);
  write('src/beat.py', `app.conf.beat_schedule = {\n    'sync_rows': {'task': 'a.b', 'schedule': 60, 'args': ['${pass_two}']},\n    'sweep_rows': {'task': 'a.c', 'schedule': 60},\n    'purge_rows': {'task': 'a.d', 'schedule': 60},\n}\n`);
  write('src/pool.ts', 'export function open_pool() { return 1; }\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const plan = (gaps: { id: string; query: string; facets: string[] }[]) => plan_coverage_misses({ repo_root: repo, docs_root: join(repo, '.documentation'), config: plugin_config_schema.parse({}), gaps, today: '2026-11-15' });

describe('a withheld facet is a count', () => {
  it('one redacted and one name facet: the name is drafted from its own line, the other is counted, not matched', async () => {
    const result = await plan([{ id: 'm1', query: 'how does the worker start', facets: [pass, 'start_worker'] }]);
    const [proposal] = result.proposals;
    expect(proposal!.missing_facets).toEqual(['start_worker']);
    expect(proposal!.withheld_facets).toBe(1);
    expect(proposal!.sources.map((found) => `${found.file}:${found.line}`)).toEqual(['src/boot.ts:2']);
    expect(result.drafts.needs_human.some((unit) => unit.keys.includes('m1') && /credential or a config value/.test(unit.reason))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(pass);
  });
  it('only redacted facets: nothing is located or cited, and the miss goes to a human', async () => {
    const result = await plan([{ id: 'm2', query: 'what is the default', facets: [pass] }]);
    const [proposal] = result.proposals;
    expect(proposal!.missing_facets).toEqual([]);
    expect(proposal!.sources).toEqual([]);
    expect(proposal!.withheld_facets).toBe(1);
    expect(result.drafts.entries).toEqual([]);
    expect(result.drafts.skipped).toEqual([]);
    expect(result.drafts.needs_human).toEqual([expect.objectContaining({ keys: ['m2'], reason: expect.stringContaining('every facet is withheld (1)') })]);
    expect(render_gaps_report({ proposals: [], candidates: [], questions: [], dropped: [], facet_gaps: [], warnings: [] } as never, { allow: [], disabled_rules: [] }, '2026-11-15', result)).toContain('1 facet(s) withheld');
  });
  it('a withheld facet on a line of a declared list never covers an entry or lets the hint skip the miss', async () => {
    const result = await plan([{ id: 'm3', query: 'which args does the sync take', facets: [pass_two, 'open_pool'] }]);
    const [proposal] = result.proposals;
    expect(proposal!.missing_facets).toEqual(['open_pool']);
    expect(proposal!.generated_reference.flatMap((list) => list.covers ?? [])).toEqual([]);
    expect(result.drafts.skipped.some((unit) => /generated reference/.test(unit.reason))).toBe(false);
    expect(result.drafts.needs_human.some((unit) => unit.keys.includes('m3'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(pass_two);
  });
  it('a withheld facet alone on a declared-list line is held, not skipped for the hint', async () => {
    const result = await plan([{ id: 'm4', query: 'which args does the sync take', facets: [pass_two] }]);
    expect(result.drafts.skipped).toEqual([]);
    expect(result.drafts.needs_human.map((unit) => unit.keys)).toEqual([['m4']]);
  });
});
