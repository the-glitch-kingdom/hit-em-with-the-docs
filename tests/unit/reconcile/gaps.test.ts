import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse_gaps } from '../../../src/core/reconcile/gaps.js';

let repo: string;
let ctx: { docsRoot: string; repoRoot: string };
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'gaps-'));
  const docs = join(repo, '.documentation');
  mkdirSync(join(docs, 'devops'), { recursive: true });
  writeFileSync(join(docs, 'devops/release-flow.md'), '# x\n');
  ctx = { docsRoot: docs, repoRoot: repo };
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('parseGaps', () => {
  it('reads the v1 object and normalizes the query', () => {
    const r = parse_gaps(JSON.stringify({ version: 1, source: 's', gaps: [{ query: '  how do I  roll back?? ', used_doc: 'devops/release-flow.md', suggested: 'symptoms.user_phrase', count: 4, last_seen: '2026-11-06' }] }), ctx);
    expect(r.source).toBe('s');
    expect(r.errors).toEqual([]);
    expect(r.gaps).toEqual([{ query: 'how do I roll back', used_doc: 'devops/release-flow.md', suggested: 'symptoms.user_phrase', count: 4, last_seen: '2026-11-06' }]);
  });
  it('reads a bare array of gap objects, an array of strings and plain lines', () => {
    expect(parse_gaps('[{"query":"a b","used_doc":null}]', ctx).gaps[0]).toEqual({ query: 'a b', used_doc: null });
    expect(parse_gaps('["one q","two q"]', ctx).gaps.map((g) => g.query)).toEqual(['one q', 'two q']);
    expect(parse_gaps('# note\none q?\n\n two q \n', ctx).gaps.map((g) => g.query)).toEqual(['one q', 'two q']);
  });
  it('refuses an unknown version naming the supported one', () => {
    expect(() => parse_gaps('{"version":2,"gaps":[]}', ctx)).toThrow(/gaps\.v1 \(version: 1\)/);
    expect(() => parse_gaps('{"gaps":[]}', ctx)).toThrow(/Unsupported/);
  });
  it('skips invalid entries with their index and keeps the rest', () => {
    const r = parse_gaps(JSON.stringify({ version: 1, gaps: [{ query: 'ok' }, { query: '' }, 5, { query: 'x', count: 0 }, { query: 'y', suggested: 'nope' }, { query: 'z', last_seen: 'yesterday' }, { query: 'fine', count: 2 }] }), ctx);
    expect(r.gaps.map((g) => g.query)).toEqual(['ok', 'fine']);
    expect(r.errors.map((e) => e.slice(0, 7))).toEqual(['gaps[1]', 'gaps[2]', 'gaps[3]', 'gaps[4]', 'gaps[5]']);
  });
  it('resolves docs-relative, vault-relative and absolute used_doc; unknown becomes no doc and is reported', () => {
    const abs = join(ctx.docsRoot, 'devops/release-flow.md');
    const paths = ['devops/release-flow.md', '.documentation/devops/release-flow.md', abs];
    for (const p of paths) expect(parse_gaps(JSON.stringify([{ query: 'q', used_doc: p }]), ctx).gaps[0].used_doc).toBe('devops/release-flow.md');
    const bad = parse_gaps(JSON.stringify([{ query: 'q', used_doc: 'nope.md' }, { query: 'q', used_doc: '../outside.md' }]), ctx);
    expect(bad.gaps.map((g) => g.used_doc)).toEqual([null, null]);
    expect(bad.errors).toHaveLength(2);
  });
  it('a generated index or a non-markdown file is not a live doc', () => {
    writeFileSync(join(ctx.docsRoot, 'devops/INDEX.md'), '---\ngenerated: true\n---\n# Index\n');
    writeFileSync(join(ctx.docsRoot, 'devops/notes.txt'), 'x\n');
    const r = parse_gaps(JSON.stringify([{ query: 'q', used_doc: 'devops/INDEX.md' }, { query: 'q', used_doc: 'devops/notes.txt' }]), ctx);
    expect(r.gaps.map((g) => g.used_doc)).toEqual([null, null]);
  });
  it('ships a schema whose gap shape matches the reader', () => {
    const s = JSON.parse(readFileSync(join(__dirname, '../../../schemas/gaps.v1.schema.json'), 'utf8'));
    expect(s.properties.version.const).toBe(1);
    expect(Object.keys(s.$defs.gap.properties)).toEqual(['query', 'used_doc', 'suggested', 'count', 'last_seen']);
  });
});
