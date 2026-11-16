import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { merge_decisions } from '../../../src/core/coverage/merge.js';
import type { Decision } from '../../../src/core/coverage/decide.js';
import { plan_coverage_misses } from '../../../src/core/coverage/plan.js';
import { load_plugin_config } from '../../../src/utils/config.js';

const d = (key: string, kind: Decision['kind'], extra: Partial<Decision> = {}): Decision => ({ key, query: `question ${key}`, count: 1, kind, held: 0, total: 1, missing_facets: [`f_${key}`], sources: [], source_files: [], cited_by: [], flags: [], notes: [], ids: [key], ...extra });
const at = (file: string, line: number) => ({ source_files: [file], sources: [{ file, line }] });

describe('merge_decisions: file ties (#120 section 1)', () => {
  it('a declared-list file never ties misses', () => {
    const r = merge_decisions([d('a', 'new', at('src/beat.py', 5)), d('b', 'new', at('src/beat.py', 7)), d('c', 'new', at('src/beat.py', 9))], { declared_files: new Set(['src/beat.py']) });
    expect(r.map((p) => p.closes.map((c) => c.key))).toEqual([['a'], ['b'], ['c']]);
  });
  it('without a declared list, misses tie only when their lines are near each other', () => {
    const r = merge_decisions([d('a', 'new', at('src/q.ts', 5)), d('b', 'new', at('src/q.ts', 9)), d('c', 'new', at('src/q.ts', 400))]);
    expect(r.map((p) => p.closes.map((c) => c.key))).toEqual([['a', 'b'], ['c']]);
  });
  it('a member without a doc never takes another member doc unless that doc holds one of its facets', () => {
    const members = [d('a', 'extend', { doc: 'ops/mail.md', ...at('src/q.ts', 5) }), d('b', 'new', at('src/q.ts', 6))];
    expect(merge_decisions(members, { doc_holds: () => false })).toHaveLength(2);
    expect(merge_decisions(members, { doc_holds: (_doc, _facets, files) => files.includes('src/never.ts') })).toHaveLength(2);
    const joined = merge_decisions(members, { doc_holds: () => true });
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ kind: 'extend', doc: 'ops/mail.md' });
  });
});

let repo: string;
const w = (p: string, t: string): void => { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), t); };
const check = 'if not verify_password(user, supplied):';
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'merge120-'));
  w('src/beat.py', "BEAT = {\n  'cleanup_sessions': {'schedule': '0 3 * * *'},\n  'trial_emails': {'schedule': '15 4 * * *'},\n  'reap_registrations': {'schedule': '30 5 * * *'},\n}\n");
  w('src/auth_task.py', `def reap():\n    name_b = 2\n    pass\n    ${check}\n        return\n`);
    w('.documentation/ops/mail.md', '---\ntitle: Mail\nsources:\n  - src/beat.py\n---\n# Mail\n\nTemplates.\n');
  w('.documentation/ops/index.md', '# Ops\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const run = async (gaps: Parameters<typeof plan_coverage_misses>[0]['gaps']) => plan_coverage_misses({ repo_root: repo, docs_root: join(repo, '.documentation'), config: await load_plugin_config(repo), gaps, today: '2026-11-15' });

describe('plan: schedule file misses stay apart (#120 section 1)', () => {
  const facets = [['cleanup_sessions'], ['trial_emails'], ['reap_registrations']];
  it('question-set form: three units', async () => {
    const r = await run(facets.map((f, i) => ({ query: `why job ${i}`, used_doc: null, id: `q${i}`, facets: f })));
    expect(r.proposals.map((p) => p.closes.length)).toEqual([1, 1, 1]);
  });
  it('gaps.v1 form with a nearest_doc holding none of the others: three units, no inherited doc', async () => {
    const r = await run(facets.map((f, i) => ({ query: `why job ${i}`, used_doc: null, id: `q${i}`, facets: f, ...(i === 1 && { nearest_doc: { path: 'ops/mail.md', facet_coverage: '0/1' } }) })));
    expect(r.proposals.map((p) => p.closes.length)).toEqual([1, 1, 1]);
  });
});

describe('plan: a security hold is per member (#120 section 1)', () => {
  it('the member on a check line goes to needs_human alone; the others draft', async () => {
    const r = await run([
      { query: 'why does reap skip', used_doc: null, id: 'held', facets: ['verify_password'] },
      { query: 'what is name b', used_doc: null, id: 'free', facets: ['name_b'] },
    ]);
    expect(r.proposals).toHaveLength(2);
    expect(r.drafts.needs_human.map((h) => h.keys)).toEqual([['held']]);
    expect(r.drafts.entries.map((e) => e.reasons?.[0])).toEqual(['coverage miss: free']);
  });
});
