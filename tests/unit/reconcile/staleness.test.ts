import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { find_staleness_signal, find_body_change } from '../../../src/core/reconcile/staleness';

let dir: string;
const g = (...a: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'ignore' });
const commit = (file: string, body: string) => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), body);
  g('add', file);
  g('commit', '-m', `edit ${file} ${body}`);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stale-'));
  g('init', '-q');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('stalenessSignal', () => {
  it('counts commits to cited files after the doc', () => {
    commit('src/a.ts', '0');
    commit('doc.md', 'x');
    commit('src/a.ts', '1');
    commit('src/a.ts', '2');
    commit('src/a.ts', '3');
    const s = find_staleness_signal(dir, 'doc.md', ['src/a.ts']);
    expect(s).toMatchObject({ status: 'signal', commits: 3 });
  });

  it('ignores unrelated commits', () => {
    commit('src/a.ts', '0');
    commit('doc.md', 'x');
    commit('other.ts', '1');
    commit('other.ts', '2');
    expect(find_staleness_signal(dir, 'doc.md', ['src/a.ts'])).toMatchObject({ status: 'signal', commits: 0 });
  });

  it('gives no signal for an uncommitted doc', () => {
    commit('src/a.ts', '0');
    writeFileSync(join(dir, 'new.md'), 'x');
    expect(find_staleness_signal(dir, 'new.md', ['src/a.ts'])).toEqual({ status: 'none' });
  });

  it('follows a renamed doc', () => {
    commit('old.md', 'x');
    commit('src/a.ts', '1');
    g('mv', 'old.md', 'new.md');
    g('commit', '-m', 'rename');
    commit('src/a.ts', '2');
    // body unchanged since the first commit (the rename kept it), so both cited commits count
    expect(find_staleness_signal(dir, 'new.md', ['src/a.ts'])).toMatchObject({ status: 'signal', commits: 2 });
  });

  it('ignores frontmatter-only commits to the doc', () => {
    commit('doc.md', '---\ntitle: a\n---\n\nbody\n');
    commit('src/a.ts', '1');
    commit('src/a.ts', '2');
    commit('src/a.ts', '3');
    commit('doc.md', '---\ntitle: a\nlast_verified: 2026-01-01\n---\n\nbody\n');
    const s = find_staleness_signal(dir, 'doc.md', ['src/a.ts']);
    expect(s).toMatchObject({ status: 'signal', commits: 3 });
    expect((s as { doc_date: string }).doc_date).toMatch(/^\d{4}-/);
    expect(find_body_change(dir, 'doc.md')?.date).toBe((s as { doc_date: string }).doc_date);
  });

  it('resets on a body edit after the code commits', () => {
    commit('doc.md', '---\ntitle: a\n---\n\nold\n');
    commit('src/a.ts', '1');
    commit('doc.md', '---\ntitle: a\n---\n\nnew\n');
    expect(find_staleness_signal(dir, 'doc.md', ['src/a.ts'])).toMatchObject({ status: 'signal', commits: 0 });
  });

  it('is unknown in a shallow clone', () => {
    commit('doc.md', 'x');
    commit('src/a.ts', '1');
    commit('src/a.ts', '2');
    const clone = mkdtempSync(join(tmpdir(), 'stale-clone-'));
    try {
      execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, clone], { stdio: 'ignore' });
      const s = find_staleness_signal(clone, 'doc.md', ['src/a.ts']);
      expect(s.status).toBe('unknown');
      expect((s as { warning: string }).warning).toMatch(/shallow/);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it('gives no signal outside a git repo', () => {
    const plain = mkdtempSync(join(tmpdir(), 'stale-plain-'));
    try {
      expect(find_staleness_signal(plain, 'doc.md', ['a.ts'])).toEqual({ status: 'none' });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
