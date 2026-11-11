import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { find_body_change, prefetch_body_changes, reset_history_memo } from '../../../src/core/reconcile/staleness';

// #101: promote/undo graph export walked every doc with its own `git log --follow`; the batched pass must give the same answers.
let root: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=A', '-c', 'user.email=a@a', ...a], { cwd: root, encoding: 'utf-8', env: { ...process.env, GIT_COMMITTER_DATE: '2024-03-02T10:00:00Z', GIT_AUTHOR_DATE: '2024-03-02T10:00:00Z' } }).trim();
const put = (rel: string, text: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const doc = (title: string, body: string) => `---\ntitle: ${title}\n---\n\n${body}\n`;
const commit = (message: string) => { g('add', '-A'); g('commit', '-qm', message); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'body-batch-101-'));
  g('init', '-q');
  put('d/edited.md', doc('e', 'v1')); put('d/fm.md', doc('f', 'same')); put('d/moved.md', doc('m', 'moved body\nline two\nline three')); put('d/solo.md', doc('s', 'solo'));
  commit('one');
  put('d/edited.md', doc('e', 'v2'));
  commit('two');
  put('d/fm.md', doc('f2', 'same'));
  renameSync(join(root, 'd/moved.md'), join(root, 'd/renamed.md'));
  commit('three: frontmatter-only change and a rename');
  put('d/edited.md', doc('e', 'v3'));
  put('d/uncommitted.md', doc('u', 'not in git'));
});
afterEach(() => { reset_history_memo(); rmSync(root, { recursive: true, force: true }); });

describe('prefetch_body_changes (#101)', () => {
  it('gives the same body-change commit and date as the per-doc --follow walk', () => {
    const paths = ['d/edited.md', 'd/fm.md', 'd/renamed.md', 'd/solo.md', 'd/uncommitted.md', 'd/missing.md'];
    reset_history_memo();
    const expected = paths.map((doc_path) => find_body_change(root, doc_path));
    reset_history_memo();
    prefetch_body_changes(root, paths, 1);
    const batched = paths.map((doc_path) => find_body_change(root, doc_path));
    expect(batched).toEqual(expected);
    expect(batched[0]).not.toBeNull();
    expect(batched[2]).not.toBeNull(); // the rename kept its history
    expect(batched[4]).toBeNull();
  });

  it('is a no-op outside a git repo', () => {
    const plain = mkdtempSync(join(tmpdir(), 'body-batch-plain-'));
    try { expect(() => prefetch_body_changes(plain, ['a.md'], 1)).not.toThrow(); } finally { rmSync(plain, { recursive: true, force: true }); }
  });
});
