import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { discover_outside } from '../../../src/core/reconcile/outside';
import { DEFAULT_RECONCILE_KEEP_IN_PLACE } from '../../../src/utils/config';

// #97 review: the two git grep passes of the outside lane must leave the cold root out too.
let root: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=A', '-c', 'user.email=a@a', ...a], { cwd: root, encoding: 'utf-8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'outside-cold-'));
  put('.documentation/a.md', '# a\n');
  put('notes/NOTES.md', `# Notes\n\n${words(60)}\n`);
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'base');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('outside lane ignores cold copies of non-markdown files (#97)', () => {
  it('a cold manifest.json naming the doc and a cold script writing it do not change its class', async () => {
    const before = await discover_outside(join(root, '.documentation'), DEFAULT_RECONCILE_KEEP_IN_PLACE);
    expect(before.find((doc) => doc.path === 'notes/NOTES.md')?.cls).toBe('misplaced');
    put('.documentation-cold/2026-01-01/backend/manifest.json', '{"file": "notes/NOTES.md"}\n');
    put('.documentation-cold/2026-01-01/build.sh', 'echo hi > notes/NOTES.md\n');
    g('add', '-A'); g('commit', '-qm', 'rotate');
    const after = await discover_outside(join(root, '.documentation'), DEFAULT_RECONCILE_KEEP_IN_PLACE);
    expect(after).toEqual(before);
  });
});
