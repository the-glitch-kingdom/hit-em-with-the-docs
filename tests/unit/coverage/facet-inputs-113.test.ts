import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse_gaps, classify_gaps } from '../../../src/core/reconcile/gaps.js';
import { compile_facet, is_code_line_facet, test_facet } from '../../../src/core/coverage/facets.js';
import { load_plugin_config } from '../../../src/utils/config.js';

let repo: string, ctx: { docs_root: string; repo_root: string };
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'facets-'));
  mkdirSync(join(repo, '.documentation/ops'), { recursive: true });
  writeFileSync(join(repo, '.documentation/ops/a.md'), '# a\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  ctx = { docs_root: join(repo, '.documentation'), repo_root: repo };
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('facet inputs (#113)', () => {
  it('reads the #101 optional fields', () => {
    const r = parse_gaps(JSON.stringify({ version: 1, gaps: [{ query: 'how long is the cache ttl', used_doc: null, id: 'q1', tier: 'blind', blind: false, facets: ['cache_ttl', '24 ?(h|hours?)'], missing_facets: ['24 ?(h|hours?)'], nearest_doc: { path: 'ops/a.md', facet_coverage: '1/2', rank: 4 }, expected: ['ops/a.md'] }] }), ctx);
    expect(r.errors).toEqual([]);
    expect(r.gaps[0]).toMatchObject({ id: 'q1', tier: 'blind', blind: false, facets: ['cache_ttl', '24 ?(h|hours?)'], missing_facets: ['24 ?(h|hours?)'], nearest_doc: { path: 'ops/a.md', facet_coverage: '1/2', rank: 4 }, expected: ['ops/a.md'] });
  });
  it('an old-format entry parses to exactly the old shape', () => {
    expect(parse_gaps('[{"query":"a b c","used_doc":null,"count":2}]', ctx).gaps[0]).toEqual({ query: 'a b c', used_doc: null, count: 2 });
  });
  it('invalid facet regex is reported by index and skipped; the entry stays', () => {
    const r = parse_gaps(JSON.stringify([{ query: 'q one two', facets: ['ok_name', '(unclosed'] }]), ctx);
    expect(r.errors.some((e) => e.startsWith('gaps[0]') && e.includes('facet 1'))).toBe(true);
    expect(r.gaps[0]!.facets).toEqual(['ok_name']);
  });
  it('bad types: the field is ignored, the entry kept; reported by index only on an entry with facets', () => {
    const r = parse_gaps(JSON.stringify([{ query: 'q', facets: 'x' }, { query: 'q two three', blind: 'yes' }, { query: 'fine one two', facets: ['ok_name'], nearest_doc: { path: 5 } }]), ctx);
    expect(r.gaps).toEqual([{ query: 'q', used_doc: null }, { query: 'q two three', used_doc: null }, { query: 'fine one two', used_doc: null, facets: ['ok_name'] }]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('gaps[2]');
  });
  it('reads the question-set JSONL ({id, tier, q, facets, expected?})', () => {
    const text = '{"id":"b1","tier":"blind","q":"what is the retry limit","facets":["max_retries"],"expected":["ops/a.md"]}\n\n{"id":"b2","tier":"x","q":"where does the queue live","facets":["queue_name"]}\nnot json\n';
    const r = parse_gaps(text, ctx);
    expect(r.gaps.map((g) => [g.id, g.query, g.facets])).toEqual([['b1', 'what is the retry limit', ['max_retries']], ['b2', 'where does the queue live', ['queue_name']]]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('line 4');
  });
  it('flags code-line-shaped facets, not prose-tolerant ones', () => {
    for (const f of ['_TTL_SECONDS = 24 * 60 * 60', 'def refresh_token(', 'class CacheLayer', 'ttl: int', '"socket_timeout": 5;']) expect(is_code_line_facet(f), f).toBe(true);
    for (const f of ['cache_ttl', '24 ?(h|hours?)|86400', 'refresh token']) expect(is_code_line_facet(f), f).toBe(false);
  });
  it('compile guards: invalid, over long and nested-quantifier regexes are refused', () => {
    expect(compile_facet('(a').error).toBeTruthy();
    expect(compile_facet('a'.repeat(400)).error).toBeTruthy();
    expect(compile_facet('(a+)+$').error).toBeTruthy();
    expect(compile_facet('(a|aa)*b').error).toBeTruthy(); // overlapping alternation under a quantifier hung the CLI
    expect(compile_facet('(foo|bar)+x').error).toBeTruthy();
    expect(compile_facet('(foo|bar)x').regex).toBeInstanceOf(RegExp);
    expect(compile_facet('retry_limit').regex).toBeInstanceOf(RegExp);
    expect(test_facet(compile_facet('x{2}').regex!, 'ax' + 'x'.repeat(10) + 'a'.repeat(100000))).toBe(true);
  });
  it('classify: facet entries leave the old buckets; blind warns; secret facets are dropped masked', async () => {
    const token = 'AK' + 'IA' + 'Q7ZR3LMP9XVB2NCK';
    const read = parse_gaps(JSON.stringify([
      { query: 'what is the retry limit', facets: ['max_retries'], id: 'a' },
      { query: 'blind one two', facets: ['blind_thing'], blind: true, id: 'b' },
      { query: 'leaky facet one', facets: [token], id: 'c' },
      { query: 'plain where is the zzz', used_doc: null },
    ]), ctx);
    const r = await classify_gaps(read.gaps, { root: repo, docs_root: ctx.docs_root, config: await load_plugin_config(repo) });
    expect(r.facet_gaps.map((g) => g.id)).toEqual(['a', 'b']);
    expect(r.questions.map((q) => q.query)).toEqual(['plain where is the zzz']);
    expect(r.warnings.some((w) => w.includes('blind') && w.includes('b'))).toBe(true);
    expect(JSON.stringify(r)).not.toContain(token);
    expect(r.dropped.some((d) => d.reason === 'secret')).toBe(true);
  });
});
