import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { compute_tree_checksum, create_stage, load_stage } from '../../../src/core/reconcile/rotation';

let root: string;
let docs: string;
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rotation-stage-'));
  docs = join(root, 'docs');
  put('docs/a/one.md', 'one\n');
  put('docs/archive/old.md', 'old\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('compute_tree_checksum', () => {
  it('is deterministic, ignores empty dirs and mtimes, and changes on content, name or symlink target', () => {
    const base = compute_tree_checksum(docs);
    expect(compute_tree_checksum(docs)).toBe(base);
    mkdirSync(join(docs, 'empty'));
    expect(compute_tree_checksum(docs)).toBe(base);
    writeFileSync(join(docs, 'a/one.md'), 'one\n'); // same bytes, new mtime
    expect(compute_tree_checksum(docs)).toBe(base);
    writeFileSync(join(docs, 'a/one.md'), 'two\n');
    const edited = compute_tree_checksum(docs);
    expect(edited).not.toBe(base);
    writeFileSync(join(docs, 'a/one.md'), 'one\n');
    symlinkSync('one.md', join(docs, 'a/link.md'));
    const linked = compute_tree_checksum(docs);
    expect(linked).not.toBe(base);
    rmSync(join(docs, 'a/link.md'));
    symlinkSync('other.md', join(docs, 'a/link.md'));
    expect(compute_tree_checksum(docs)).not.toBe(linked);
  });
});

describe('create_stage', () => {
  it('copies archive/ and gitignored files, records the manifest, and leaves the live tree alone', async () => {
    put('docs/reports/run.md', 'gitignored\n');
    const before = compute_tree_checksum(docs);
    const stage = await create_stage({ repo_root: root, docs_root: docs, stage_dir: join(root, '.hewtd/s') });
    expect(compute_tree_checksum(join(stage.docs_root))).toBe(before);
    expect(compute_tree_checksum(docs)).toBe(before);
    expect(stage).toMatchObject({ format: 1, docs_path: 'docs', live_checksum: before });
    expect(stage.source_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(load_stage(stage.stage_dir).staged_at).toBe(stage.staged_at);
  });

  it('refuses, with nothing written, for a non-empty stage, one inside or around the docs, one outside the repo', async () => {
    put('.hewtd/full/x', 'x');
    const cases: [string, RegExp][] = [
      [join(root, '.hewtd/full'), /not empty/],
      [join(docs, 'sub'), /outside the docs tree/],
      [root, /must not contain the docs/],
      [join(tmpdir(), `rotation-outside-${process.pid}`), /inside the repo/],
    ];
    for (const [stage_dir, message] of cases) await expect(create_stage({ repo_root: root, docs_root: docs, stage_dir })).rejects.toThrow(message);
    expect(existsSync(join(docs, 'sub'))).toBe(false);
    expect(existsSync(join(root, '.hewtd/full/stage.json'))).toBe(false);
    expect(readFileSync(join(docs, 'a/one.md'), 'utf8')).toBe('one\n');
  });

  it('load_stage rejects a directory that is not a stage', () => {
    expect(() => load_stage(root)).toThrow(/not a stage/);
  });
});
