import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import matter from 'gray-matter';
import { fix_retrieval_fields } from '../../../src/core/metadata/fix-retrieval-fields.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'frf-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const put = (name: string, fm: string, body = '# T\n\nBody text.\n') =>
  writeFile(join(dir, name), `---\n${fm}\n---\n\n${body}`);
const read = async (name: string) => matter(await readFile(join(dir, name), 'utf-8'));

describe('fixRetrievalFields', () => {
  it('moves summary to purpose, keeping other keys and body', async () => {
    await put('a.md', 'title: A\nsummary: Explains how the nightly export job retries failed uploads\nowner: me');
    const r = await fix_retrieval_fields({ docs_root: dir, apply: true });
    expect(r.changed).toHaveLength(1);
    const p = await read('a.md');
    expect(p.data).toEqual({ title: 'A', owner: 'me', purpose: 'Explains how the nightly export job retries failed uploads' });
    expect(p.content).toContain('Body text.');
  });

  it('moves description when there is no summary', async () => {
    await put('b.md', 'title: B\ndescription: Explains how the nightly export job retries failed uploads');
    await fix_retrieval_fields({ docs_root: dir, apply: true });
    expect((await read('b.md')).data).toEqual({ title: 'B', purpose: 'Explains how the nightly export job retries failed uploads' });
  });

  it('prefers summary and leaves description when both present', async () => {
    await put('c.md', 'summary: Explains how the nightly export job retries failed uploads\ndescription: D');
    await fix_retrieval_fields({ docs_root: dir, apply: true });
    expect((await read('c.md')).data).toEqual({ purpose: 'Explains how the nightly export job retries failed uploads', description: 'D' });
  });

  it('reports a conflict and leaves both when purpose exists', async () => {
    await put('d.md', 'purpose: P\nsummary: S');
    const r = await fix_retrieval_fields({ docs_root: dir, apply: true });
    expect(r.conflicts).toHaveLength(1);
    expect(r.changed).toHaveLength(0);
    expect((await read('d.md')).data).toEqual({ purpose: 'P', summary: 'S' });
  });

  it('merges keywords into tags, deduped in order', async () => {
    await put('e.md', 'tags: [a, b]\nkeywords: [b, c]');
    await fix_retrieval_fields({ docs_root: dir, apply: true });
    expect((await read('e.md')).data).toEqual({ tags: ['a', 'b', 'c'] });
  });

  it('dry run writes nothing', async () => {
    await put('f.md', 'summary: Explains how the nightly export job retries failed uploads\nkeywords: [k]');
    const before = await readFile(join(dir, 'f.md'), 'utf-8');
    const r = await fix_retrieval_fields({ docs_root: dir });
    expect(r.changed).toHaveLength(1);
    expect(await readFile(join(dir, 'f.md'), 'utf-8')).toBe(before);
  });

  it('keeps unquoted dates as dates and the body byte-identical (review fix)', async () => {
    const body = '\n# T\n\n  indented line\n\n```\ncode\n```\n';
    await writeFile(join(dir, 'e.md'), `---\ntitle: E\nlast_updated: 2024-01-05\nsummary: Explains how the nightly export job retries failed uploads\n---\n${body}`);
    await fix_retrieval_fields({ docs_root: dir, apply: true });
    const raw = await readFile(join(dir, 'e.md'), 'utf-8');
    expect(raw).toContain("last_updated: '2024-01-05'");
    expect(raw).not.toContain('T00:00:00');
    expect(raw.endsWith(`---\n${body}`)).toBe(true);
  });

  it('skips a file with malformed YAML and still fixes the others', async () => {
    await writeFile(join(dir, 'bad.md'), '---\ntitle: [unclosed\n---\nx\n');
    await put('ok.md', 'title: OK\nsummary: Explains how the nightly export job retries failed uploads');
    const r = await fix_retrieval_fields({ docs_root: dir, apply: true });
    expect(r.errors.map((e) => e.file)).toEqual([join(dir, 'bad.md')]);
    expect((await read('ok.md')).data).toMatchObject({ purpose: 'Explains how the nightly export job retries failed uploads' });
  });

  it('falls through to a real description when the summary is filler, in one run (review fix)', async () => {
    await put('f.md', 'title: Foo\nsummary: Documentation for Foo\ndescription: Explains how the nightly export job retries failed uploads');
    const r = await fix_retrieval_fields({ docs_root: dir, apply: true });
    expect((await read('f.md')).data).toEqual({ title: 'Foo', purpose: 'Explains how the nightly export job retries failed uploads' });
    expect(r.dropped).toBe(1);
    expect((await fix_retrieval_fields({ docs_root: dir, apply: true })).changed).toEqual([]);
  });

  it('drops a filler summary instead of writing it to purpose', async () => {
    await put('g.md', 'title: Gee\nsummary: Documentation for Gee');
    const r = await fix_retrieval_fields({ docs_root: dir, apply: true });
    expect(r.changed[0]!.actions).toEqual(['summary was filler, dropped']);
    expect(r.dropped).toBe(1);
    expect((await read('g.md')).data).toEqual({ title: 'Gee' });
  });

  it('clears an existing generator-fallback purpose, then moves a real summary', async () => {
    await put('h.md', 'title: Aitch\npurpose: documentation for aitch \nsummary: Explains how the nightly export job retries failed uploads');
    const r = await fix_retrieval_fields({ docs_root: dir, apply: true });
    expect(r.cleared).toBe(1);
    expect(r.changed[0]!.actions).toEqual(['purpose was generator filler, cleared', 'summary -> purpose']);
    expect((await read('h.md')).data).toEqual({ title: 'Aitch', purpose: 'Explains how the nightly export job retries failed uploads' });
  });

  it('leaves a human-written short purpose alone', async () => {
    await put('i.md', 'title: Eye\npurpose: Short one');
    const r = await fix_retrieval_fields({ docs_root: dir, apply: true });
    expect(r.changed).toHaveLength(0);
    expect((await read('i.md')).data).toEqual({ title: 'Eye', purpose: 'Short one' });
  });

  it('is idempotent: a second run changes nothing', async () => {
    await put('j.md', 'title: Jay\npurpose: Documentation for Jay');
    await put('k.md', 'title: Kay\nsummary: Documentation for Kay');
    expect((await fix_retrieval_fields({ docs_root: dir, apply: true })).changed).toHaveLength(2);
    const r = await fix_retrieval_fields({ docs_root: dir, apply: true });
    expect(r.changed).toHaveLength(0);
    expect(r.dropped + r.cleared).toBe(0);
  });

  it.each([
    ['unindented', 'tags:\n- a\n- b', 'tags:\n- a\n- b\n'],
    ['indented', 'tags:\n  - a\n  - b', 'tags:\n  - a\n  - b\n'],
  ])('keeps %s list style: diff touches only the moved field', async (_n, list, expected) => {
    await put('s.md', `title: S\n${list}\nsummary: Explains how the nightly export job retries failed uploads`);
    await fix_retrieval_fields({ docs_root: dir, apply: true });
    const fm = (await readFile(join(dir, 's.md'), 'utf-8')).split('---')[1]!;
    expect(fm).toBe(`\ntitle: S\n${expected}purpose: Explains how the nightly export job retries failed uploads\n`);
  });

  it('setFrontmatter keeps list style from an explicit original; new files default to indented', async () => {
    const { with_frontmatter: set_frontmatter, render_frontmatter: stringify_frontmatter } = await import('../../../src/utils/frontmatter.js');
    const orig = '---\ntags:\n- a\n---\n\nB\n';
    expect(set_frontmatter('B\n', { tags: ['a', 'b'] }, orig)).toContain('tags:\n- a\n- b\n');
    expect(stringify_frontmatter({ tags: ['a'] })).toBe('tags:\n  - a\n');
  });
});
