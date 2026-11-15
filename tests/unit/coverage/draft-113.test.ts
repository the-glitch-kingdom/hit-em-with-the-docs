import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build_drafts } from '../../../src/core/coverage/draft.js';
import type { Proposal } from '../../../src/core/coverage/merge.js';
import { compute_content_hash } from '../../../src/core/reconcile/ledger.js';

const token = 'AK' + 'IA' + 'Q7ZR3LMP9XVB2NCK';
let repo: string, docs: string;
const w = (p: string, t: string): void => { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), t); };
const config = { allow: [], disabled_rules: [] };
const proposal = (extra: Partial<Proposal>): Proposal => ({ kind: 'new', closes: [{ key: 'q1', query: 'what is the retry limit', count: 1 }], count: 1, missing_facets: ['retry_limit'], sources: [], source_files: [], cited_by: [], instruction_files: [], flags: [], notes: [], generated_reference: [], ...extra });
const run = (proposals: Proposal[], include_blind = false) => build_drafts({ repo_root: repo, docs_root: docs, proposals, secrets_config: config, include_blind, today: '2026-11-14' });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'draft-'));
  docs = join(repo, '.documentation');
  w('src/queue.ts', 'export const retry_limit = 5;\nexport function drain_queue() {}\nconst host = "db.internal.example.com";\n');
  w('src/creds.ts', `const aws_key = "${token}";\n`);
  w('src/env.ts', 'const v = process.env.QUEUE_NAME || "jobs";\n');
  w('.documentation/ops/queue.md', '---\ntitle: Queue\n---\n# Queue\n\nHow the queue works.\n');
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('build_drafts (#113)', () => {
  it('new doc: a create entry with template frontmatter, sources, and a stated fact citing file:line (#115: states the fact, no pointer bullets)', async () => {
    const r = await run([proposal({ domain: 'ops', sources: [{ file: 'src/queue.ts', line: 1 }, { file: 'src/queue.ts', line: 2 }], source_files: ['src/queue.ts'] })]);
    expect(r.entries).toHaveLength(1);
    const e = r.entries[0]!;
    expect(e).toMatchObject({ verdict: 'create', path: 'ops/what-is-the-retry-limit.md', content_hash: compute_content_hash(''), sources: ['src/queue.ts'] });
    expect(e.draft).toMatch(/^---\n/);
    expect(e.draft).toContain('`retry_limit` is `5` (`src/queue.ts`, line 1).');
    expect(e.draft).not.toContain('drain_queue'); // line 2 holds no missing facet: not cited
    const sentences = (e.draft!.match(/^- .*$/gm) ?? []);
    expect(sentences.length).toBe(1);
    expect(sentences.every((s) => /line \d+\)/.test(s))).toBe(true);
  });
  it('never overwrites: an existing path gets a numbered sibling', async () => {
    w('.documentation/ops/what-is-the-retry-limit.md', '# x\n');
    const r = await run([proposal({ domain: 'ops', sources: [{ file: 'src/queue.ts', line: 1 }], source_files: ['src/queue.ts'] })]);
    expect(r.entries[0]!.path).toBe('ops/what-is-the-retry-limit-2.md');
  });
  it('extend: a patch entry on the target doc anchored to its last line, with sources', async () => {
    const r = await run([proposal({ kind: 'extend', doc: 'ops/queue.md', sources: [{ file: 'src/queue.ts', line: 1 }], source_files: ['src/queue.ts'] })]);
    const e = r.entries[0]!;
    expect(e.verdict).toBe('verify');
    expect(e.patch?.[0]?.old).toBe('How the queue works.');
    expect(e.patch?.[0]?.new).toContain('`retry_limit` is `5` (`src/queue.ts`, line 1).');
    expect(e.sources).toEqual(['src/queue.ts']);
  });
  it('env names are never stated and their values never appear: the facet goes to the judge as file:line', async () => {
    const r = await run([proposal({ domain: 'ops', missing_facets: ['QUEUE_NAME'], sources: [{ file: 'src/env.ts', line: 1 }], source_files: ['src/env.ts'] })]);
    expect(r.entries[0]).toMatchObject({ verdict: null, for_judge: [{ facet: 'QUEUE_NAME', at: ['src/env.ts:1'] }] });
    expect(JSON.stringify(r)).not.toContain('jobs"');
  });
  it('a credential line is withheld, not cited; a fact found only there goes to a human with path:line masked, the rest of the unit is kept (#115)', async () => {
    const r = await run([proposal({ missing_facets: ['aws_key'], sources: [{ file: 'src/creds.ts', line: 1 }], source_files: ['src/creds.ts'] })]);
    expect(r.entries).toEqual([]);
    expect(r.needs_human[0]).toMatchObject({ keys: ['q1'], reason: expect.stringContaining('src/creds.ts:1') });
    expect(JSON.stringify(r)).not.toContain(token);
    const mixed = await run([proposal({ domain: 'ops', missing_facets: ['retry_limit', 'aws_key'], sources: [{ file: 'src/queue.ts', line: 1 }, { file: 'src/creds.ts', line: 1 }], source_files: ['src/creds.ts', 'src/queue.ts'] })]);
    expect(mixed.entries[0]!.draft).toContain('`retry_limit` is `5`');
    expect(mixed.entries[0]!.sources).toEqual(['src/queue.ts']);
    expect(mixed.needs_human).toHaveLength(1);
    expect(JSON.stringify(mixed)).not.toContain(token);
  });
  it('security-sensitive topics are listed for a human with unit names only, never drafted', async () => {
    const r = await run([proposal({ closes: [{ key: 'q9', query: 'how does the permission check work', count: 1 }], sources: [{ file: 'src/queue.ts', line: 1 }], source_files: ['src/queue.ts'] })]);
    expect(r.entries).toEqual([]);
    expect(r.needs_human).toEqual([{ keys: ['q9'], source_files: ['src/queue.ts'] }]);
  });
  it('blind proposals are skipped unless include_blind; covered, instruction-only and generated-reference are not drafted', async () => {
    const base = { sources: [{ file: 'src/queue.ts', line: 1 }], source_files: ['src/queue.ts'], domain: 'ops' };
    expect((await run([proposal({ ...base, blind: true })])).skipped[0]!.reason).toMatch(/blind/);
    expect((await run([proposal({ ...base, blind: true })], true)).entries).toHaveLength(1);
    expect((await run([proposal({ kind: 'covered', doc: 'ops/queue.md' })])).skipped[0]!.reason).toMatch(/ranking/);
    expect((await run([proposal({ kind: 'instruction-only', instruction_files: ['CLAUDE.md'] })])).skipped[0]!.reason).toMatch(/instruction/);
    expect((await run([proposal({ ...base, generated_reference: [{ kind: 'routes', file: 'src/queue.ts', count: 3, suggestion: 'generate it' }] })])).skipped[0]!.reason).toMatch(/generated/);
  });
});
