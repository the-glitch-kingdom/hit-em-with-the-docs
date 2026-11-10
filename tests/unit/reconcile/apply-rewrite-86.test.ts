import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { apply_reviews } from '../../../src/core/reconcile/apply';
import { render_review, type ReviewEntry } from '../../../src/core/reconcile/review';
import { compute_content_hash, load_ledger } from '../../../src/core/reconcile/ledger';

let root: string, docs: string, ledger_file: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const read = (rel: string) => readFileSync(join(docs, rel), 'utf-8');
const put = (rel: string, text: string) => { mkdirSync(join(docs, rel, '..'), { recursive: true }); writeFileSync(join(docs, rel), text); };
const entry = (rel: string, over: Partial<ReviewEntry>): ReviewEntry => ({ path: rel, content_hash: compute_content_hash(read(rel)), verdict: 'verify', ...over });
const review = (entries: ReviewEntry[], name = 'review-1-1.md') => {
  const file = join(root, '.hewtd/reconcile', name);
  mkdirSync(join(root, '.hewtd/reconcile'), { recursive: true });
  writeFileSync(file, render_review({ batch: '1', shard: 1, scope: 'backend' }, entries).replace(/- \[ \] accept/g, '- [x] accept'));
  return file;
};
const run = async (files: string[]) => apply_reviews({ root, docs_root: docs, files, ledger: await load_ledger(ledger_file), ledger_file, today: '2026-11-07' });
const sources_of = (rel: string) => (/sources:\n((?:\s+- .*\n)+)/.exec(read(rel))?.[1] ?? '').split('\n').map((l) => l.replace(/^\s+- /, '').replace(/^['"]|['"]$/g, '')).filter(Boolean);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'merge-rw-'));
  docs = join(root, '.documentation');
  ledger_file = join(root, '.hewtd/reconcile.json');
  put('backend/a.md', '---\ntitle: a\ndomains:\n  - backend\nsources:\n  - src/a.ts\n  - src/b.ts\nowner: keep-me\n---\n\n# A\n\n## Old heading\n\nSee `src/old.ts` and [b](b.md).\n');
  put('backend/b.md', '---\ntitle: b\ndomains:\n  - backend\n---\n\n# B\n\nLinks [old](a.md#old-heading).\n');
  mkdirSync(join(root, 'src'), { recursive: true });
  for (const n of ['a', 'b', 'c']) writeFileSync(join(root, `src/${n}.ts`), '//');
  writeFileSync(join(root, '.gitignore'), '.hewtd/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('rewrite lands the draft (#86)', () => {
  const draft = '# A rewritten\n\nBrand new body about `src/c.ts`.\n';
  it('replaces the body, keeps and merges frontmatter, merges sources, commits, ledger has the new hash', async () => {
    const res = await run([review([entry('backend/a.md', { verdict: 'rewrite', draft, frontmatter: { purpose: 'why' }, sources: ['src/c.ts'] })])]);
    expect(res.outcomes[0]!.status).toBe('applied');
    const text = read('backend/a.md');
    expect(text).toContain('Brand new body');
    expect(text).not.toContain('Old heading');
    expect(text).toContain('owner: keep-me');
    expect(text).toContain('purpose: why');
    expect(sources_of('backend/a.md')).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(g('status', '--porcelain', '--', '.documentation')).toBe('');
    expect((await load_ledger(ledger_file)).entries['backend/a.md']!.content_hash).toBe(compute_content_hash(text));
    expect(existsSync(join(root, '.hewtd/reconcile/drafts'))).toBe(false);
  });

  it('a draft with its own frontmatter: its keys sit under the entry', async () => {
    await run([review([entry('backend/a.md', { verdict: 'rewrite', draft: '---\ntitle: from draft\nextra: 1\n---\n\nBody.\n', frontmatter: { title: 'from entry' } })])]);
    const text = read('backend/a.md');
    expect(text).toContain('title: from entry');
    expect(text).toContain('extra: 1');
    expect(text.match(/^---$/gm)).toHaveLength(2);
  });

  it('second apply is already-applied; a hand edit after is stale', async () => {
    const file = review([entry('backend/a.md', { verdict: 'rewrite', draft })]);
    await run([file]);
    expect((await run([file])).outcomes[0]!.status).toBe('already-applied');
    writeFileSync(join(docs, 'backend/a.md'), read('backend/a.md') + '\nhand edit\n');
    g('commit', '-qam', 'human');
    expect((await run([file])).outcomes[0]!.status).toBe('stale');
  });

  it('an empty draft is an error and nothing changes', async () => {
    const before = read('backend/a.md');
    const res = await run([review([entry('backend/a.md', { verdict: 'rewrite', draft: '  ' })])]);
    expect(res.outcomes[0]!.status).toBe('error');
    expect(read('backend/a.md')).toBe(before);
  });

  it('warns when the draft drops an anchor another doc links to, and a cited code path', async () => {
    const res = await run([review([entry('backend/a.md', { verdict: 'rewrite', draft })])]);
    const detail = res.outcomes[0]!.detail ?? '';
    expect(detail).toContain('old-heading');
    expect(detail).toContain('src/old.ts');
  });
});
