import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import matter from 'gray-matter';
import { fixRetrievalFields } from '../../../src/core/metadata/fix-retrieval-fields.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'frf-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const put = (name: string, fm: string, body = '# T\n\nBody text.\n') =>
  writeFile(join(dir, name), `---\n${fm}\n---\n\n${body}`);
const read = async (name: string) => matter(await readFile(join(dir, name), 'utf-8'));

describe('fixRetrievalFields', () => {
  it('moves summary to purpose, keeping other keys and body', async () => {
    await put('a.md', 'title: A\nsummary: Sum\nowner: me');
    const r = await fixRetrievalFields({ docsPath: dir, apply: true });
    expect(r.changed).toHaveLength(1);
    const p = await read('a.md');
    expect(p.data).toEqual({ title: 'A', owner: 'me', purpose: 'Sum' });
    expect(p.content).toContain('Body text.');
  });

  it('moves description when there is no summary', async () => {
    await put('b.md', 'title: B\ndescription: Desc');
    await fixRetrievalFields({ docsPath: dir, apply: true });
    expect((await read('b.md')).data).toEqual({ title: 'B', purpose: 'Desc' });
  });

  it('prefers summary and leaves description when both present', async () => {
    await put('c.md', 'summary: S\ndescription: D');
    await fixRetrievalFields({ docsPath: dir, apply: true });
    expect((await read('c.md')).data).toEqual({ purpose: 'S', description: 'D' });
  });

  it('reports a conflict and leaves both when purpose exists', async () => {
    await put('d.md', 'purpose: P\nsummary: S');
    const r = await fixRetrievalFields({ docsPath: dir, apply: true });
    expect(r.conflicts).toHaveLength(1);
    expect(r.changed).toHaveLength(0);
    expect((await read('d.md')).data).toEqual({ purpose: 'P', summary: 'S' });
  });

  it('merges keywords into tags, deduped in order', async () => {
    await put('e.md', 'tags: [a, b]\nkeywords: [b, c]');
    await fixRetrievalFields({ docsPath: dir, apply: true });
    expect((await read('e.md')).data).toEqual({ tags: ['a', 'b', 'c'] });
  });

  it('dry run writes nothing', async () => {
    await put('f.md', 'summary: S\nkeywords: [k]');
    const before = await readFile(join(dir, 'f.md'), 'utf-8');
    const r = await fixRetrievalFields({ docsPath: dir });
    expect(r.changed).toHaveLength(1);
    expect(await readFile(join(dir, 'f.md'), 'utf-8')).toBe(before);
  });

  it('keeps unquoted dates as dates and the body byte-identical (review fix)', async () => {
    const body = '\n# T\n\n  indented line\n\n```\ncode\n```\n';
    await writeFile(join(dir, 'e.md'), `---\ntitle: E\nlast_updated: 2024-01-05\nsummary: S\n---\n${body}`);
    await fixRetrievalFields({ docsPath: dir, apply: true });
    const raw = await readFile(join(dir, 'e.md'), 'utf-8');
    expect(raw).toContain("last_updated: '2024-01-05'");
    expect(raw).not.toContain('T00:00:00');
    expect(raw.endsWith(`---\n${body}`)).toBe(true);
  });

  it('skips a file with malformed YAML and still fixes the others', async () => {
    await writeFile(join(dir, 'bad.md'), '---\ntitle: [unclosed\n---\nx\n');
    await put('ok.md', 'title: OK\nsummary: S');
    const r = await fixRetrievalFields({ docsPath: dir, apply: true });
    expect(r.errors.map((e) => e.file)).toEqual([join(dir, 'bad.md')]);
    expect((await read('ok.md')).data).toMatchObject({ purpose: 'S' });
  });
});
