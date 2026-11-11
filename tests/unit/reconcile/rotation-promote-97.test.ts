import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { rename } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { compute_tree_checksum, create_stage, get_cold_prefix, is_in_cold, run_promote } from '../../../src/core/reconcile/rotation';
import { load_plugin_config } from '../../../src/utils/config';

let root: string;
let docs: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=A', '-c', 'user.email=a@a', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rotation-promote-'));
  docs = join(root, '.documentation');
  put('.documentation/backend/a.md', '---\ntitle: a\n---\n\n# a\n');
  put('.gitignore', '.hewtd/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('run_promote rollback (#97)', () => {
  it('a failure between the two renames puts the old tree back and leaves nothing behind', async () => {
    const live_before = compute_tree_checksum(docs);
    const stage = await create_stage({ repo_root: root, docs_root: docs, stage_dir: join(root, '.hewtd/stage') });
    put('.hewtd/stage/docs/backend/a.md', '---\ntitle: a\n---\n\n# a changed\n');
    const staged_before = compute_tree_checksum(stage.docs_root);
    const head = g('rev-parse', 'HEAD');
    let calls = 0;
    const second_rename_fails = async (from: string, to: string): Promise<void> => { if (++calls === 2) throw new Error('boom between the renames'); await rename(from, to); };

    await expect(run_promote({ repo_root: root, docs_root: docs, stage, config: await load_plugin_config(root), rename: second_rename_fails })).rejects.toThrow(/boom between the renames; rolled back, nothing changed/);

    expect(calls).toBe(2);
    expect(compute_tree_checksum(docs)).toBe(live_before);
    expect(compute_tree_checksum(stage.docs_root)).toBe(staged_before);
    expect(existsSync(join(root, '.documentation-cold'))).toBe(false);
    expect(g('rev-parse', 'HEAD')).toBe(head);
    expect(g('status', '--porcelain')).toBe('');
    expect(statSync(join(docs, 'backend/a.md')).mode & 0o200).not.toBe(0);
    expect(existsSync(join(root, '.claude/hit-em-with-the-docs.json'))).toBe(false);
  });

  it('the first rename failing changes nothing either', async () => {
    const stage = await create_stage({ repo_root: root, docs_root: docs, stage_dir: join(root, '.hewtd/stage') });
    const live_before = compute_tree_checksum(docs);
    await expect(run_promote({ repo_root: root, docs_root: docs, stage, config: await load_plugin_config(root), rename: async () => { throw new Error('first'); } })).rejects.toThrow(/rolled back/);
    expect(compute_tree_checksum(docs)).toBe(live_before);
    expect(compute_tree_checksum(stage.docs_root)).toBe(live_before);
    expect(existsSync(join(root, '.documentation-cold'))).toBe(false);
  });
});

describe('cold root helpers', () => {
  it('get_cold_prefix reads reconcile.cold_root and rejects unusable values', () => {
    expect(get_cold_prefix(root)).toBe('.documentation-cold');
    for (const [value, expected] of [['./cold/', 'cold'], ['', undefined], ['.', undefined], ['../out', undefined], ['/abs', undefined]] as const) {
      put('.claude/hit-em-with-the-docs.json', JSON.stringify({ reconcile: { cold_root: value } }));
      expect(get_cold_prefix(root), value).toBe(value === '' ? '.documentation-cold' : expected); // '' fails the schema: default
    }
    expect(readFileSync(join(root, '.claude/hit-em-with-the-docs.json'), 'utf8')).toContain('/abs');
  });

  it('is_in_cold matches the folder and its children only', () => {
    expect(is_in_cold('cold/2026/a.md', 'cold')).toBe(true);
    expect(is_in_cold('cold', 'cold')).toBe(true);
    expect(is_in_cold('cold-other/a.md', 'cold')).toBe(false);
    expect(is_in_cold('a.md', undefined)).toBe(false);
  });
});
