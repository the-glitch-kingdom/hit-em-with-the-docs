import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { with_frontmatter_keys, with_frontmatter_data, parse_frontmatter } from '../../../src/utils/frontmatter.js';
import { fix_retrieval_fields } from '../../../src/core/metadata/fix-retrieval-fields.js';
import { sync_metadata } from '../../../src/core/metadata/sync.js';
import { archive_doc, unarchive_doc } from '../../../src/core/archive/manage.js';

const BODY = '\n# Title\n\n\nBody  text.\n';
const make = (lines: string[], eol = '\r\n') => `---${eol}${lines.join(eol)}${eol}---${eol}${BODY.replace(/\n/g, eol)}`;
const LINES = [
  'title: "Quoted Title"',
  'last_updated: 2026-10-01',
  '# keep this comment',
  'tags: [a,   b]',
  'summary: Explains how the nightly export job retries failed uploads',
  'description: Filler',
  'keywords: [x, y]',
];
const unowned = (text: string, owned: RegExp) => text.split('\r\n').filter((l) => !owned.test(l));

describe('with_frontmatter_keys removal and with_frontmatter_data (#72)', () => {
  it('removes a middle, a last and a block key with their lines only', () => {
    const raw = make([...LINES, 'block:', '  - one', '  - two']);
    const out = with_frontmatter_keys(raw, { summary: undefined, keywords: undefined, block: undefined });
    expect(out).toBe(raw.replace(/summary: .*\r\n/, '').replace(/keywords: .*\r\n/, '').replace(/\r\nblock:\r\n {2}- one\r\n {2}- two/, ''));
  });

  it('returns the text unchanged when nothing differs', () => {
    const raw = make(LINES);
    expect(with_frontmatter_data(raw, { ...parse_frontmatter(raw).data })).toBe(raw);
  });

  it('changes only differing keys and removes absent ones', () => {
    const raw = make(LINES);
    const data = parse_frontmatter(raw).data as Record<string, unknown>;
    const { keywords: _k, ...rest } = data;
    const out = with_frontmatter_data(raw, { ...rest, tags: ['a', 'b', 'c'], owner: 'me' });
    expect(out).toContain('last_updated: 2026-10-01\r\n');
    expect(out).toContain('title: "Quoted Title"');
    expect(out).toContain('# keep this comment');
    expect(out).not.toContain('keywords');
    expect(out.endsWith(`---\r\n${BODY.replace(/\n/g, '\r\n')}`)).toBe(true);
    expect(parse_frontmatter(out).data).toMatchObject({ tags: ['a', 'b', 'c'], owner: 'me' });
  });
});

describe('writers touch only their own keys (#72)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sfw-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('fix_retrieval_fields --apply removes exactly the dropped lines', async () => {
    const raw = make(LINES);
    const file = join(dir, 'a.md');
    await writeFile(file, raw);
    await fix_retrieval_fields({ docs_root: dir, apply: true });
    const out = await readFile(file, 'utf-8');
    expect(unowned(out, /^(purpose|tags|\s+- )/)).toEqual(unowned(raw, /^(summary|keywords|tags)/));
    expect(out).toContain('last_updated: 2026-10-01\r\n');
    expect(out).toContain('title: "Quoted Title"');
    expect(out).not.toMatch(/^(summary|keywords):/m);
    expect(out.endsWith(`---\r\n${BODY.replace(/\n/g, '\r\n')}`)).toBe(true);
  });

  it('sync_metadata --fix leaves unowned keys and the body untouched', async () => {
    const lines = ['title: "Quoted Title"', 'last_updated: 2026-10-01', '# keep this comment', 'tags: [a,   b]'];
    const raw = make(lines);
    await mkdir(join(dir, 'api'), { recursive: true });
    const file = join(dir, 'api/a.md');
    await writeFile(file, raw);
    await sync_metadata({ docs_root: dir, repo_root: dir, fix: true, silent: true });
    const out = await readFile(file, 'utf-8');
    for (const line of ['title: "Quoted Title"', '# keep this comment', 'tags: [a,   b]']) expect(out).toContain(line);
    expect(out.endsWith(`---\r\n${BODY.replace(/\n/g, '\r\n')}`)).toBe(true);
  });

  it('archive and unarchive change only the stamp keys', async () => {
    const lines = ['title: "Quoted Title"', 'domains: [api]', 'status: active', 'last_updated: 2026-10-01', '# keep this comment', 'tags: [a,   b]'];
    const raw = make(lines);
    const docs_root = join(dir, '.documentation');
    await mkdir(join(docs_root, 'api'), { recursive: true });
    await writeFile(join(docs_root, 'api/a.md'), raw);
    await archive_doc({ repo_root: dir, docs_root, file: 'api/a.md', today: '2026-11-08' });
    const archived = await readFile(join(docs_root, 'archive/api/a.md'), 'utf-8');
    expect(unowned(archived, /^(status|archived_)/)).toEqual(unowned(raw, /^status/));
    expect(archived).toContain('last_updated: 2026-10-01\r\n');
    expect(archived).toContain('title: "Quoted Title"');
    expect(archived.endsWith(`---\r\n${BODY.replace(/\n/g, '\r\n')}`)).toBe(true);

    await unarchive_doc({ repo_root: dir, docs_root, file: 'archive/api/a.md' });
    const restored = await readFile(join(docs_root, 'api/a.md'), 'utf-8');
    expect(restored).toBe(raw.replace('status: active', 'status: active'));
  });
});
