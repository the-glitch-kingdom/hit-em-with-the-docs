import { describe, it, expect } from 'vitest';
import { merge_decisions, detect_declared_lists } from '../../../src/core/coverage/merge.js';
import type { Decision } from '../../../src/core/coverage/decide.js';

const d = (key: string, kind: Decision['kind'], extra: Partial<Decision> = {}): Decision => ({ key, query: `question ${key}`, count: 1, kind, held: 0, total: 2, missing_facets: [`f_${key}`], sources: [], source_files: [], cited_by: [], flags: [], notes: [], ids: [key], ...extra });

describe('merge_decisions (#113)', () => {
  it('two misses for one doc become one proposal listing both questions', () => {
    const r = merge_decisions([d('a', 'extend', { doc: 'ops/x.md', source_files: ['src/a.ts'], sources: [{ file: 'src/a.ts', line: 1 }] }), d('b', 'extend', { doc: 'ops/x.md', source_files: ['src/a.ts', 'src/b.ts'], sources: [{ file: 'src/a.ts', line: 1 }, { file: 'src/b.ts', line: 4 }] })]);
    expect(r).toHaveLength(1);
    expect(r[0]!.closes.map((c) => c.key)).toEqual(['a', 'b']);
    expect(r[0]!.missing_facets).toEqual(['f_a', 'f_b']);
    expect(r[0]!.source_files).toEqual(['src/a.ts', 'src/b.ts']);
  });
  it('new-doc misses sharing a source file become one new doc; unrelated ones stay apart', () => {
    const r = merge_decisions([d('a', 'new', { source_files: ['src/q.ts'], sources: [{ file: 'src/q.ts', line: 1 }], domain: 'ops' }), d('b', 'new', { source_files: ['src/q.ts'], sources: [{ file: 'src/q.ts', line: 2 }] }), d('c', 'new', { source_files: ['src/other.ts'], sources: [{ file: 'src/other.ts', line: 2 }] })]);
    expect(r.map((p) => [p.kind, p.closes.map((c) => c.key), p.domain])).toEqual([['new', ['a', 'b'], 'ops'], ['new', ['c'], undefined]]);
  });
  it('a new-doc miss sharing code with an extend joins the extend', () => {
    const r = merge_decisions([d('a', 'extend', { doc: 'ops/x.md', source_files: ['src/q.ts'], sources: [{ file: 'src/q.ts', line: 1 }] }), d('b', 'new', { source_files: ['src/q.ts'], sources: [{ file: 'src/q.ts', line: 3 }] })]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'extend', doc: 'ops/x.md' });
  });
  it('covered misses group by doc; counts add; the blind flag survives', () => {
    const r = merge_decisions([d('a', 'covered', { doc: 'ops/x.md', count: 2 }), d('b', 'covered', { doc: 'ops/x.md', blind: true })]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'covered', count: 3, blind: true });
  });
  it('is deterministic whatever the input order', () => {
    const a = d('a', 'new', { source_files: ['src/q.ts'] }), b = d('b', 'new', { source_files: ['src/q.ts'] });
    expect(JSON.stringify(merge_decisions([a, b]))).toBe(JSON.stringify(merge_decisions([b, a])));
  });
});

describe('detect_declared_lists (#113)', () => {
  it('finds routes, cron schedules, alert rules, CLI flags and config keys; ignores small lists', () => {
    const files = new Map([
      ['src/routes.ts', "app.get('/a', h);\napp.post('/b', h);\nrouter.delete('/c', h);\n"],
      ['src/jobs.py', "# every night\n'0 3 * * *'\n'*/5 * * * *'\n'15 4 * * 1'\n"],
      ['ops/alerts.yml', '- alert: HighErrors\n- alert: SlowQueue\n- alert: Down\n'],
      ['src/cli.ts', ".option('--a')\n.option('--b')\n.option('--c')\n"],
      ['src/env.ts', 'process.env.ALPHA_X; process.env.BETA_Y;\nprocess.env.GAMMA_Z;\nprocess.env.DELTA_W;\n'],
      ['src/small.ts', "app.get('/only', h);\n.option('--one')\n"],
    ]);
    const r = detect_declared_lists(files);
    expect(r.map((h) => [h.kind, h.file])).toEqual([['alert-rules', 'ops/alerts.yml'], ['cli-flags', 'src/cli.ts'], ['config-keys', 'src/env.ts'], ['routes', 'src/routes.ts'], ['schedules', 'src/jobs.py']]);
    expect(r.every((h) => h.count >= 3 && /generat/.test(h.suggestion))).toBe(true);
  });
});
