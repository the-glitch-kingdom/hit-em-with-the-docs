import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { apply_reviews } from '../../../src/core/reconcile/apply';
import { render_review, write_review_skeletons, type ReviewEntry } from '../../../src/core/reconcile/review';
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

describe('sources merge on apply (#85)', () => {
  it('existing first, then new, deduplicated, own path dropped', async () => {
    await run([review([entry('backend/a.md', { sources: ['src/c.ts', 'src/a.ts', 'backend/a.md', '.documentation/backend/a.md'] })])]);
    expect(sources_of('backend/a.md')).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('sources_remove drops the named ones', async () => {
    await run([review([entry('backend/a.md', { sources: ['src/c.ts'], sources_remove: ['src/b.ts'] })])]);
    expect(sources_of('backend/a.md')).toEqual(['src/a.ts', 'src/c.ts']);
  });

  it('a source missing from the repo is kept and reported; urls are not', async () => {
    const res = await run([review([entry('backend/a.md', { sources: ['src/gone.ts', 'https://example.com/x'] })])]);
    expect(sources_of('backend/a.md')).toContain('src/gone.ts');
    expect(res.outcomes[0]!.detail).toContain('src/gone.ts');
    expect(res.outcomes[0]!.detail).not.toContain('example.com');
  });

  it('an entry without sources leaves the existing ones alone', async () => {
    await run([review([entry('backend/a.md', { patch: [{ old: 'See', new: 'Look at' }] })])]);
    expect(sources_of('backend/a.md')).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('--write-review with named docs (#85)', () => {
  const triage: any = { docs: [{ path: 'backend/a.md', lane: 'check', reasons: [] }, { path: 'backend/b.md', lane: 'clean', reasons: [] }], shards: [], totals: {}, mode: 'serial', warnings: [] };
  it('include_clean writes the clean lane too; default leaves it out', async () => {
    const [file] = await write_review_skeletons({ root, docs_root: docs, triage, scope: 'backend', include_clean: true });
    expect(readFileSync(file!, 'utf-8')).toContain('## backend/b.md');
    const [other] = await write_review_skeletons({ root, docs_root: docs, triage, scope: 'backend' });
    expect(readFileSync(other!, 'utf-8')).not.toContain('## backend/b.md');
  });
});

