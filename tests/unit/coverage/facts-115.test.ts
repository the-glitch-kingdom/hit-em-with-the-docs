import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build_drafts, extract_stated_constant } from '../../../src/core/coverage/draft.js';
import type { Proposal } from '../../../src/core/coverage/merge.js';
import { load_review, render_review } from '../../../src/core/reconcile/review.js';

let repo: string, docs: string;
const w = (p: string, t: string): void => { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), t); };
const config = { allow: [], disabled_rules: [] };
const proposal = (extra: Partial<Proposal>): Proposal => ({ kind: 'new', closes: [{ key: 'q1', query: 'how large is an upload chunk', count: 1 }], count: 1, missing_facets: [], sources: [], source_files: [], cited_by: [], instruction_files: [], flags: [], notes: [], generated_reference: [], domain: 'ops', ...extra });
const run = (proposals: Proposal[]) => build_drafts({ repo_root: repo, docs_root: docs, proposals, secrets_config: config, today: '2026-11-14' });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'facts-'));
  docs = join(repo, '.documentation');
  w('src/upload.ts', 'export const CHUNK_SIZE = 10 * 1024 * 1024;\nexport function drain_queue() {}\nconst expiry_seconds = 24 * 3600;\nconst label = "hello";\n');
  w('src/ttl.py', 'CACHE_TTL = 3600\nretry_limit: int = 5\n');
  w('.documentation/ops/uploads.md', '---\ntitle: Uploads\n---\n# Uploads\n\nHow uploads work.\n');
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('extract_stated_constant (#115)', () => {
  it('accepts number, arithmetic, duration and size constants in TS, Python, Go, Java forms', () => {
    expect(extract_stated_constant('export const CHUNK_SIZE = 10 * 1024 * 1024;')).toEqual({ name: 'CHUNK_SIZE', literal: '10 * 1024 * 1024' });
    expect(extract_stated_constant('retry_limit: int = 5')).toEqual({ name: 'retry_limit', literal: '5' });
    expect(extract_stated_constant('CACHE_TTL = 3600  # seconds')).toEqual({ name: 'CACHE_TTL', literal: '3600' });
    expect(extract_stated_constant('const idle = 30 * time.Second')).toEqual({ name: 'idle', literal: '30 * time.Second' });
    expect(extract_stated_constant('private static final int MAX_BYTES = 2 * 1024 * 1024;')).toEqual({ name: 'MAX_BYTES', literal: '2 * 1024 * 1024' });
    expect(extract_stated_constant('let timeout_ms = 1_500;')).toEqual({ name: 'timeout_ms', literal: '1_500' });
  });
  it('refuses strings, calls, env reads and defaults, and names that carry a host, port, id, url or key', () => {
    for (const line of ['const label = "hello";', 'API = os.environ.get("A", 5)', 'const t = process.env.T ?? 30;', 'const a = b * 2;', 'DB_PORT = 5432', 'const server_host = 10', 'USER_ID = 1234567', 'const base_url = 5', 'API_KEY = 12345678', 'const x = compute(5);', 'x == 5']) expect(extract_stated_constant(line), line).toBeUndefined();
  });
});

describe('fact-stating drafts (#115)', () => {
  it('a new doc states the constant with file and line, the facet matches the sentence, no pointer bullets', async () => {
    const r = await run([proposal({ missing_facets: ['chunk_size.{0,20}10 \\* 1024'], sources: [{ file: 'src/upload.ts', line: 1 }, { file: 'src/upload.ts', line: 2 }], source_files: ['src/upload.ts'] })]);
    const text = r.entries[0]!.draft!;
    expect(r.entries[0]!.verdict).toBe('create');
    expect(text).toContain('`CHUNK_SIZE` is `10 * 1024 * 1024` (`src/upload.ts`, line 1).');
    expect(text).not.toMatch(/Related code|is defined in/);
    expect(new RegExp('chunk_size.{0,20}10 \\* 1024', 'i').test(text)).toBe(true);
    expect(r.entries[0]!.for_judge).toBeUndefined();
  });
  it('an extend patch holds only stated facts; a facet it cannot state is listed for the judge with file:line', async () => {
    const r = await run([proposal({ kind: 'extend', doc: 'ops/uploads.md', missing_facets: ['chunk_size', 'drain_queue'], sources: [{ file: 'src/upload.ts', line: 1 }, { file: 'src/upload.ts', line: 2 }], source_files: ['src/upload.ts'] })]);
    const e = r.entries[0]!;
    expect(e.verdict).toBe('verify');
    expect(e.patch![0]!.new).toContain('`CHUNK_SIZE` is `10 * 1024 * 1024` (`src/upload.ts`, line 1).');
    expect(e.patch![0]!.new).not.toContain('drain_queue');
    expect(e.for_judge).toEqual([{ facet: 'drain_queue', at: ['src/upload.ts:2'] }]);
  });
  it('a sentence that does not match its facet is not stated: the facet goes to the judge', async () => {
    const r = await run([proposal({ missing_facets: ['24 hours'], sources: [{ file: 'src/upload.ts', line: 3 }], source_files: ['src/upload.ts'] })]);
    // expiry_seconds = 24 * 3600 holds no "24 hours"; the facet does not even match the line
    expect(r.entries[0]!.for_judge).toEqual([{ facet: '24 hours', at: [] }]);
  });
  it('a proposal with nothing stateable gets a null-verdict entry: no patch, no draft, facets listed', async () => {
    const r = await run([proposal({ kind: 'extend', doc: 'ops/uploads.md', missing_facets: ['drain_queue'], sources: [{ file: 'src/upload.ts', line: 2 }], source_files: ['src/upload.ts'] })]);
    const e = r.entries[0]!;
    expect(e).toMatchObject({ path: 'ops/uploads.md', verdict: null, for_judge: [{ facet: 'drain_queue', at: ['src/upload.ts:2'] }] });
    expect(e.patch).toBeUndefined();
    expect(e.draft).toBeUndefined();
    const n = (await run([proposal({ missing_facets: ['drain_queue'], sources: [{ file: 'src/upload.ts', line: 2 }], source_files: ['src/upload.ts'] })])).entries[0]!;
    expect(n).toMatchObject({ verdict: null, path: 'ops/how-large-is-an-upload-chunk.md' });
    expect(n.draft).toBeUndefined();
  });
  it('config files and values are never stated', async () => {
    w('.env', 'CHUNK_SIZE=5\n');
    const r = await run([proposal({ missing_facets: ['chunk_size'], sources: [{ file: '.env', line: 1 }], source_files: ['.env'] })]);
    expect(r.entries[0]!.verdict).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/CHUNK_SIZE=5/);
  });
  it('a null-verdict entry survives the review file round trip and apply never touches it', async () => {
    const r = await run([proposal({ kind: 'extend', doc: 'ops/uploads.md', missing_facets: ['drain_queue'], sources: [{ file: 'src/upload.ts', line: 2 }], source_files: ['src/upload.ts'] })]);
    const file = join(repo, 'review.md');
    writeFileSync(file, render_review({ batch: '1', shard: 1, scope: 'gaps' }, r.entries).replace('- [ ] accept', '- [x] accept'));
    const loaded = await load_review(file);
    expect(loaded.entries[0]).toMatchObject({ accepted: true, entry: { verdict: null, for_judge: [{ facet: 'drain_queue', at: ['src/upload.ts:2'] }] } });
  });
});
