import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { lastChanged, bodyChangedDates } from '../../../src/core/graph/dates.js';

const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf-8' }).trim();
const commit = (cwd: string, msg: string, date: string) => {
  sh(cwd, 'add', '-A');
  execFileSync('git', ['commit', '-qm', msg], { cwd, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
};
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'dates-')); sh(d, 'init', '-q'); return d; };

let repo: string;
beforeAll(() => {
  repo = mk();
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/a.ts'), '1');
  writeFileSync(join(repo, 'src/b.ts'), '1');
  writeFileSync(join(repo, 'doc.md'), '---\nt: 1\n---\nbody\n');
  commit(repo, 'one', '2026-01-10T12:00:00');
  writeFileSync(join(repo, 'src/a.ts'), '2');
  commit(repo, 'two', '2026-03-05T12:00:00');
  renameSync(join(repo, 'src/b.ts'), join(repo, 'src/c.ts'));
  commit(repo, 'rename', '2026-05-20T12:00:00');
});

describe('lastChanged', () => {
  it('matches git log -1 per file, including renames', () => {
    const r = lastChanged(repo)!;
    expect(r.shallow).toBe(false);
    for (const f of ['src/a.ts', 'src/c.ts', 'doc.md']) {
      expect(r.dates.get(f)).toBe(sh(repo, 'log', '-1', '--format=%cs', '--', f));
    }
    expect(r.dates.get('src/a.ts')).toBe('2026-03-05');
    expect(r.dates.get('src/c.ts')).toBe('2026-05-20');
  });

  it('works on a sibling repo (read-only, per root)', () => {
    const sib = mk();
    writeFileSync(join(sib, 'lib.ts'), 'x');
    commit(sib, 's', '2026-02-02T12:00:00');
    expect(lastChanged(sib)!.dates.get('lib.ts')).toBe('2026-02-02');
  });

  it('returns null outside git', () => {
    expect(lastChanged(mkdtempSync(join(tmpdir(), 'nogit-')))).toBeNull();
  });
});

describe('bodyChangedDates', () => {
  const docs = () => [{ path: 'doc.md', content: '---\nt: 1\n---\nbody\n' }];

  it('walks once, then hits the cache while HEAD and content are unchanged', () => {
    const a = bodyChangedDates(repo, docs());
    expect(a.dates.get('doc.md')).toBe('2026-01-10');
    expect(a.walked).toBe(1);
    const b = bodyChangedDates(repo, docs());
    expect(b.walked).toBe(0);
    expect(b.dates.get('doc.md')).toBe('2026-01-10');
  });

  it('re-walks when content changes', () => {
    expect(bodyChangedDates(repo, [{ path: 'doc.md', content: 'other' }]).walked).toBe(1);
  });

  it('gives nulls and does not throw outside git', () => {
    const r = bodyChangedDates(mkdtempSync(join(tmpdir(), 'nogit-')), docs());
    expect(r.dates.get('doc.md')).toBeNull();
  });
});
