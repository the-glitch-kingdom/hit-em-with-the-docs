import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { name_new_doc, place_new_doc, MAX_SLUG_LENGTH } from '../../../src/core/coverage/naming.js';
import { resolve_decision, type DocText } from '../../../src/core/coverage/decide.js';
import { merge_decisions } from '../../../src/core/coverage/merge.js';
import { build_drafts } from '../../../src/core/coverage/draft.js';
import type { Proposal } from '../../../src/core/coverage/merge.js';

describe('name_new_doc: named after the subject, not the question (#118 section 3)', () => {
  it('the dominant identifier names the doc; a generic class suffix is dropped', () => {
    expect(name_new_doc({ queries: ['how large can an upload be with ChunkedUploadService'], facets: ['ChunkedUploadService', 'max_file_size'], source_files: ['src/upload/limits.ts'] })).toBe('chunked-upload');
  });
  it('the most frequent identifier wins; ties go to the longer name, then alphabetical', () => {
    expect(name_new_doc({ queries: ['q'], facets: ['FooBar\\(', 'BazQux', 'FooBar'], source_files: [] })).toBe('foo-bar');
    expect(name_new_doc({ queries: ['q'], facets: ['alpha_one', 'beta_two_three'], source_files: [] })).toBe('beta-two-three');
  });
  it('regex syntax in facets is not an identifier', () => {
    expect(name_new_doc({ queries: ['how long is the cache'], facets: ['\\bttl\\s*=\\s*\\d+', 'cache'], source_files: ['src/cache/store.ts'] })).toBe('store');
  });
  it('without an identifier: the source module basename, unless it is generic', () => {
    expect(name_new_doc({ queries: ['how long'], facets: ['410'], source_files: ['src/uploads/chunked_uploads.py'] })).toBe('chunked-uploads');
    expect(name_new_doc({ queries: ['how are invoices rounded'], facets: ['412'], source_files: ['src/billing/index.ts', 'src/billing/utils.ts'] })).toBe('invoices-rounded');
  });
  it('last resort: a cleaned question noun phrase, whole words only, never question words, capped', () => {
    const slug = name_new_doc({ queries: ['how does a new account get a populated workspace after the registration email is confirmed'], facets: ['4'], source_files: [] });
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.startsWith('how')).toBe(false);
    for (const word of slug.split('-')) expect('how does a new account get a populated workspace after the registration email is confirmed').toContain(word);
    expect(name_new_doc({ queries: ['how?'], facets: [], source_files: [] })).toBe('topic');
  });
});

describe('place_new_doc: never the knowledge-base root (#118 section 3)', () => {
  it('a folder is kept; knowledge-base falls back; a fact goes to knowledge-base/facts', () => {
    expect(place_new_doc({ folder: 'features/uploads', domain: 'features', tier: 'guide' })).toEqual({ dir: 'features/uploads', fallback: false });
    expect(place_new_doc({ domain: 'ops', tier: 'guide' })).toEqual({ dir: 'ops', fallback: false });
    expect(place_new_doc({ domain: 'knowledge-base', tier: 'guide' })).toEqual({ dir: 'features', fallback: true });
    expect(place_new_doc({ tier: 'guide' })).toEqual({ dir: 'features', fallback: true });
    expect(place_new_doc({ domain: 'ops', tier: 'fact' })).toEqual({ dir: 'knowledge-base/facts', fallback: false });
  });
});

describe('placement from nearby docs (#118 section 3)', () => {
  const doc = (path: string, sources: string[]): DocText => ({ path, text: `# ${path}`, sources });
  const miss = { key: 'q', query: 'how large can an upload be', count: 1, facets: ['zz_upload_limit'] };
  const located = { code: new Map([['zz_upload_limit', [{ file: 'src/uploads/chunk.ts', line: 3 }]]]), instructions: new Map() };
  it('the deepest common folder of the non-hub docs about nearby code', () => {
    const docs = [doc('features/uploads/a.md', ['src/uploads/x.ts']), doc('features/uploads/b.md', ['src/uploads/y.ts']), doc('features/other/c.md', ['src/elsewhere/z.ts'])];
    const decision = resolve_decision(miss, located, docs);
    expect(decision).toMatchObject({ kind: 'new', domain: 'features', folder: 'features/uploads' });
    expect(merge_decisions([decision])[0]).toMatchObject({ domain: 'features', folder: 'features/uploads' });
  });
  it('voting docs in different subfolders: the common parent', () => {
    const docs = [doc('features/uploads/a.md', ['src/uploads/x.ts']), doc('features/media/b.md', ['src/uploads/y.ts'])];
    expect(resolve_decision(miss, located, docs)).toMatchObject({ domain: 'features', folder: 'features' });
  });
  it('knowledge-base docs never vote: a fact citing nearby code does not make the vault root the home', () => {
    const docs = [doc('knowledge-base/facts/limit.md', ['src/uploads/x.ts']), doc('knowledge-base/limit-note.md', ['src/uploads/x.ts'])];
    const decision = resolve_decision(miss, located, docs);
    expect(decision.kind).toBe('new');
    expect(decision.domain).toBeUndefined();
    expect(decision.folder).toBeUndefined();
  });
});

describe('build_drafts paths', () => {
  let repo: string;
  const proposal = (extra: Partial<Proposal>): Proposal => ({ kind: 'new', closes: [{ key: 'q1', query: 'how large can an upload be with ChunkedUploadService', count: 1 }], count: 1, missing_facets: ['max_file_size', 'ChunkedUploadService'], sources: [{ file: 'src/upload/limits.ts', line: 1 }], source_files: ['src/upload/limits.ts'], cited_by: [], instruction_files: [], flags: [], notes: [], generated_reference: [], ...extra });
  const run = (proposals: Proposal[]) => build_drafts({ repo_root: repo, docs_root: join(repo, '.documentation'), proposals, secrets_config: { allow: [], disabled_rules: [] }, today: '2026-11-15' });
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'name118-'));
    mkdirSync(join(repo, 'src/upload'), { recursive: true });
    mkdirSync(join(repo, '.documentation/features/uploads'), { recursive: true });
    writeFileSync(join(repo, 'src/upload/limits.ts'), 'export const MAX_FILE_SIZE = 10 * 1024 * 1024;\n');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  it('a new doc lands in the folder beside the nearby docs, named after the subject', async () => {
    const r = await run([proposal({ domain: 'features', folder: 'features/uploads' })]);
    expect(r.entries[0]!.path).toBe('features/uploads/chunked-upload.md');
  });
  it('a numbered sibling, never an overwrite', async () => {
    writeFileSync(join(repo, '.documentation/features/uploads/chunked-upload.md'), '# x\n');
    const r = await run([proposal({ domain: 'features', folder: 'features/uploads' })]);
    expect(r.entries[0]!.path).toBe('features/uploads/chunked-upload-2.md');
  });
  it('never the knowledge-base root', async () => {
    const r = await run([proposal({ domain: 'knowledge-base' })]);
    expect(r.entries[0]!.path).toBe('features/chunked-upload.md');
    expect(r.entries[0]!.reasons!.join(' ')).toMatch(/fallback/);
  });
});
