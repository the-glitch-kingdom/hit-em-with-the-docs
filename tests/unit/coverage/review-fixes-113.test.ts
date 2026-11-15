// Regression tests for the #113 adversarial review findings (3.5.0).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile_facet, match_facets } from '../../../src/core/coverage/facets.js';
import { resolve_decision, type Decision, type DocText } from '../../../src/core/coverage/decide.js';
import { merge_decisions } from '../../../src/core/coverage/merge.js';
import { extract_declared_name } from '../../../src/core/coverage/draft.js';
import { is_security_sensitive } from '../../../src/core/security/gate.js';
import { parse_gaps, classify_gaps } from '../../../src/core/reconcile/gaps.js';
import { load_plugin_config } from '../../../src/utils/config.js';

let repo: string, ctx: { docs_root: string; repo_root: string };
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'review-113-'));
  mkdirSync(join(repo, '.documentation/ops'), { recursive: true });
  writeFileSync(join(repo, '.documentation/ops/a.md'), '# a\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  ctx = { docs_root: join(repo, '.documentation'), repo_root: repo };
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('facet matching is time-limited (review: nested groups and polynomial patterns hung the run)', () => {
  for (const source of ['((a+))+$', '(?:(?:a+))+$', 'a*a*a*a*a*a*b']) {
    it(`${source} returns within the limit instead of hanging`, () => {
      const regex = compile_facet(source).regex;
      if (!regex) return; // refused by shape: also fine
      const started = performance.now();
      const [found] = match_facets([regex], ['a'.repeat(31) + '!', 'a'.repeat(20_000)], 5);
      expect(found).toBeNull(); // timed out: no matches claimed
      expect(performance.now() - started).toBeLessThan(5_000);
    });
  }
  it('ordinary facets still match, per facet, up to the limit', () => {
    expect(match_facets([/cache_ttl/i, /nope/i], ['x', 'cache_ttl = 1', 'CACHE_TTL'], 5)).toEqual([[1, 2], []]);
    expect(match_facets([/a/i], ['a', 'a', 'a'], 2)).toEqual([[0, 1]]);
  });
});

describe('JSONL question sets with // comment lines (review: every eval set starts with //)', () => {
  it('reads a // header then facet objects as JSONL', () => {
    const r = parse_gaps('// Identifier-shape set\n{"id":"q1","q":"how long is the ttl","facets":["cache_ttl"]}\n// trailing note\n{"id":"q2","q":"retry limit","facets":["max_retries"]}\n', ctx);
    expect(r.errors).toEqual([]);
    expect(r.gaps.map((gap) => [gap.id, gap.facets])).toEqual([['q1', ['cache_ttl']], ['q2', ['max_retries']]]);
  });
});

describe('wrong-typed #101 fields on usage-log entries (review: 3.4.1 ignored them)', () => {
  it('an entry without facets keeps its 3.4.1 shape and raises no error', () => {
    const r = parse_gaps('[{"query":"a b c","used_doc":null,"count":2,"id":12,"tier":2,"blind":"no"}]', ctx);
    expect(r.errors).toEqual([]);
    expect(r.gaps[0]).toEqual({ query: 'a b c', used_doc: null, count: 2 });
  });
  it('an entry with facets keeps the entry and reports the ignored field', () => {
    const r = parse_gaps('[{"query":"a b c","id":12,"facets":["cache_ttl"]}]', ctx);
    expect(r.gaps[0]).toMatchObject({ query: 'a b c', facets: ['cache_ttl'] });
    expect(r.gaps[0]!.id).toBeUndefined();
    expect(r.errors.join(' ')).toMatch(/"id" must be a string/);
  });
});

describe('facet and query values never reach the report (review: host and IP:port leaked)', () => {
  it('drops facets holding a hostname, IP or port; withholds a query holding one', async () => {
    const config = await load_plugin_config(repo);
    const gaps = parse_gaps(JSON.stringify([
      { id: 'host', query: 'where is the database', facets: ['db-prod\\.acme-corp\\.internal:5432', 'pool_size'] },
      { id: 'ip', query: 'what does 10.20.30.40 serve', facets: ['10\\.20\\.30\\.40:5432', 'serve_name'] },
    ]), ctx).gaps;
    const result = await classify_gaps(gaps, { root: repo, docs_root: ctx.docs_root, config });
    const out = JSON.stringify(result);
    for (const value of ['acme-corp', '10.20.30.40', '10\\\\.20', '5432']) expect(out).not.toContain(value);
    expect(result.facet_gaps.map((gap) => gap.facets)).toEqual([['pool_size'], ['serve_name']]);
    expect(result.dropped.filter((drop) => drop.query === '[redacted facet]')).toHaveLength(2);
  });
});

describe('security-sensitive identifiers (review: \\b missed snake_case and camelCase)', () => {
  for (const text of ['check_auth_token', 'verify_jwt_signature', 'is_admin_bypass', 'iam_role_arn', 'AuthGuard', 'user_permissions', 'password_hash', 'checkDeletePermission', 'isAuthorized', 'session_cookie', 'tls_cert', 'src/login/handler.ts', '\\bauth\\b'])
    it(`flags ${text}`, () => expect(is_security_sensitive(text)).toBe(true));
  for (const text of ['cache_ttl', 'max_retries', 'tokenizer_config', 'author_name', 'src/queue/worker.ts'])
    it(`does not flag ${text}`, () => expect(is_security_sensitive(text)).toBe(false));
});

describe('declared names come from code, not string literals (review: draft could quote a string)', () => {
  it('ignores a declaration keyword inside a string', () => {
    expect(extract_declared_name('log("class hunter2sekrit")')).toBeUndefined();
    expect(extract_declared_name("msg = 'def p4ssw0rdValue'")).toEqual({ name: 'msg', verb: 'defined in' });
    expect(extract_declared_name('export function load_cache() {')).toEqual({ name: 'load_cache', verb: 'defined in' });
  });
});

const decision = (key: string, kind: Decision['kind'], extra: Partial<Decision> = {}): Decision => ({ key, query: `question ${key}`, count: 1, kind, held: 0, total: 1, missing_facets: [`f_${key}`], sources: [], source_files: [], cited_by: [], flags: [], notes: [], ids: [key], ...extra });

describe('merge keeps different target docs apart (review: a shared source moved one miss into another doc)', () => {
  it('two extends of different docs sharing a source stay two proposals', () => {
    const shared = { source_files: ['src/shared.ts'], sources: [{ file: 'src/shared.ts', line: 1 }] };
    const proposals = merge_decisions([decision('mx', 'extend', { doc: 'ops/x.md', ...shared }), decision('my', 'extend', { doc: 'ops/y.md', ...shared })]);
    expect(proposals.map((proposal) => [proposal.doc, proposal.closes.map((closed) => closed.key)])).toEqual([['ops/x.md', ['mx']], ['ops/y.md', ['my']]]);
  });
});

describe('covered wins over the eval nearest doc when another doc holds every facet (review)', () => {
  it('reports covered at the doc that holds them all', () => {
    const docs: DocText[] = [{ path: 'ops/both.md', text: 'cache_ttl and purge_interval', sources: [] }, { path: 'ops/cache.md', text: 'cache_ttl only', sources: [] }];
    const result = resolve_decision({ key: 'q', query: 'cache', count: 1, facets: ['cache_ttl', 'purge_interval'], nearest_doc: { path: 'ops/cache.md', facet_coverage: '1/2', rank: 3 } }, { code: new Map(), instructions: new Map() }, docs);
    expect(result).toMatchObject({ kind: 'covered', doc: 'ops/both.md' });
    expect(result.notes.join(' ')).toMatch(/ops\/cache\.md/);
  });
});
