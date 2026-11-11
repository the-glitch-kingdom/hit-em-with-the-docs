import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join, relative, resolve } from 'path';
import { create_stage, list_generations, run_promote, run_undo, plan_promote, plan_undo } from '../../src/core/reconcile/rotation';
import { load_plugin_config } from '../../src/utils/config';

// #97 adversarial-review fixes for promote / undo, in process (git is real, temp repos).
let root: string;
let docs: string;
let old_umask: number;
const CONFIG = '.claude/hit-em-with-the-docs.json';
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=A', '-c', 'user.email=a@a', '-c', 'core.quotepath=off', ...a], { cwd, encoding: 'utf-8' }).trim();
const g = (...a: string[]) => git(root, ...a);
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const writable = (dir: string) => { try { execFileSync('chmod', ['-R', 'u+w', dir]); } catch { /* gone */ } };

/** mode + size + content for every file and dir under a tree. */
const mode_sum = (dir: string): string => {
  const lines: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      const st = statSync(p);
      lines.push(`${relative(dir, p)} ${(st.mode & 0o7777).toString(8)} ${entry.isDirectory() ? 0 : st.size} ${entry.isFile() ? createHash('sha256').update(readFileSync(p)).digest('hex') : ''}`);
      if (entry.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return lines.sort().join('\n');
};

const ctx = async (c: string = root) => ({ repo_root: c, docs_root: join(c, '.documentation'), config: await load_plugin_config(c) });
const stage_it = async (edit = true) => {
  const stage = await create_stage({ repo_root: root, docs_root: docs, stage_dir: join(root, '.hewtd/stage') });
  if (edit) put('.hewtd/stage/docs/backend/a.md', '---\ntitle: a\n---\n\n# a reconciled\n');
  return stage;
};
const promote = async () => run_promote({ ...(await ctx()), stage: await stage_it() });
const manifest = () => JSON.parse(readFileSync(join(root, CONFIG), 'utf8')).cold_storage as Array<Record<string, any>>;
const hook_fails = () => { const hook = join(root, '.git/hooks/pre-commit'); writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755); return hook; };

beforeEach(() => {
  old_umask = process.umask(0o002);
  root = mkdtempSync(join(tmpdir(), 'rotate-review-'));
  docs = join(root, '.documentation');
  put('.documentation/backend/a.md', '---\ntitle: a\n---\n\n# a\n');
  put('.documentation/backend/b.md', '---\ntitle: b\n---\n\n# b\n');
  put(CONFIG, '{"updatePolicy":"nudge"}');
  put('.gitignore', '.hewtd/\n.documentation/reports/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => { process.umask(old_umask); writable(root); rmSync(root, { recursive: true, force: true }); });

describe('#2 paths git would C-quote', () => {
  it('gitignored files with a quote, backslash or tab are not committed and are listed exactly', async () => {
    const names = ['q"q.md', 'back\\slash.md', 'tab\tname.md', 'trail .md', 'end .md ', ' lead.md', '#hash.md', '!bang.md', 'star*.md'];
    for (const name of names) put(`.documentation/reports/${name}`, `disk only ${name}\n`);
    const done = await promote();
    const cold = done.cold_path;
    expect(g('ls-files', '-z', cold).split('\0').filter((f) => f.includes('/reports/'))).toEqual([]);
    expect(manifest()[0]!.untracked_files.sort()).toEqual(names.map((n) => `${cold}/reports/${n}`).sort());
    expect(g('status', '--porcelain', '-z')).toBe('');
    for (const name of names) expect(existsSync(join(root, cold, 'reports', name))).toBe(true);
  });
});

describe('#3 files-only lock', () => {
  it('git checkout of the commit before the rotation, and back, both work with a clean tree', async () => {
    const before = g('rev-parse', 'HEAD');
    const branch = g('rev-parse', '--abbrev-ref', 'HEAD');
    const done = await promote();
    expect(statSync(join(root, done.cold_path, 'backend/a.md')).mode & 0o222).toBe(0);
    expect(statSync(join(root, done.cold_path, 'backend')).mode & 0o200).not.toBe(0);
    g('checkout', '-q', before);
    expect(g('status', '--porcelain')).toBe('');
    g('checkout', '-q', branch);
    expect(g('status', '--porcelain')).toBe('');
    expect(existsSync(join(root, done.cold_path, 'backend/a.md'))).toBe(true);
  });
});

describe('#4 exact modes', () => {
  const prepare = () => {
    chmodSync(join(docs, 'backend/b.md'), 0o444);
    chmodSync(join(docs, 'backend/a.md'), 0o664);
    mkdirSync(join(docs, 'sub'), { mode: 0o775 }); chmodSync(join(docs, 'sub'), 0o775);
    put('.documentation/sub/c.md', 'c\n'); chmodSync(join(docs, 'sub/c.md'), 0o664);
    g('add', '-A'); g('commit', '-qm', 'modes');
  };
  it('a rolled-back promote restores every mode, size and content', async () => {
    prepare();
    const before = mode_sum(docs);
    const stage = await stage_it();
    hook_fails();
    await expect(run_promote({ ...(await ctx()), stage })).rejects.toThrow(/rolled back/);
    expect(mode_sum(docs)).toBe(before);
  });
  it('promote then undo restores every mode, size and content', async () => {
    prepare();
    const before = mode_sum(docs);
    const done = await promote();
    expect(existsSync(join(root, '.documentation-cold/.generations', done.generation, 'modes.json'))).toBe(true);
    await run_undo({ ...(await ctx()), generation: done.generation });
    expect(mode_sum(docs)).toBe(before);
  });
});

describe('#5 / #6 plugin config', () => {
  it('promote and undo refuse, changing nothing, when the config is not valid JSON', async () => {
    const bad = '{\n  // comment\n  "updatePolicy": "nudge",\n}\n';
    put(CONFIG, bad); g('commit', '-qam', 'bad config');
    const stage = await stage_it();
    const head = g('rev-parse', 'HEAD');
    await expect(run_promote({ ...(await ctx()), stage })).rejects.toThrow(/hit-em-with-the-docs\.json.*(JSON|parse)/s);
    await expect(plan_undo({ ...(await ctx()), generation: 'x' })).rejects.toThrow(/hit-em-with-the-docs\.json.*(JSON|parse)/s);
    expect(readFileSync(join(root, CONFIG), 'utf8')).toBe(bad);
    expect(g('rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(join(root, '.documentation-cold'))).toBe(false);
    expect(readFileSync(join(docs, 'backend/a.md'), 'utf8')).not.toContain('reconciled');
  });

  it('a failed promote leaves the one-line config byte for byte (status clean) and a retry works', async () => {
    const original = readFileSync(join(root, CONFIG), 'utf8');
    const stage = await stage_it();
    const hook = hook_fails();
    await expect(run_promote({ ...(await ctx()), stage })).rejects.toThrow(/rolled back/);
    expect(readFileSync(join(root, CONFIG), 'utf8')).toBe(original);
    expect(g('status', '--porcelain')).toBe('');
    rmSync(hook);
    const done = await run_promote({ ...(await ctx()), stage });
    const text = readFileSync(join(root, CONFIG), 'utf8');
    expect(text.includes('\n')).toBe(false); // style kept: one line, no trailing newline
    expect(JSON.parse(text)).toMatchObject({ updatePolicy: 'nudge', cold_storage: [{ generation: done.generation }] });
  });

  it('keeps the indent and trailing newline of a pretty config; a failed undo restores its bytes', async () => {
    const original = JSON.stringify({ updatePolicy: 'nudge' }, null, '\t') + '\n';
    put(CONFIG, original); g('commit', '-qam', 'tabs');
    const done = await promote();
    const text = readFileSync(join(root, CONFIG), 'utf8');
    expect(text.startsWith('{\n\t"updatePolicy"')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
    const after_promote = text;
    hook_fails();
    await expect(run_undo({ ...(await ctx()), generation: done.generation })).rejects.toThrow(/rolled back/);
    expect(readFileSync(join(root, CONFIG), 'utf8')).toBe(after_promote);
    expect(g('status', '--porcelain')).toBe('');
  });
});

describe('#7 tracked checksum versus disk checksum', () => {
  it('a fresh clone reports ok with the absent disk-only files counted, and undo restores what exists', async () => {
    put('.documentation/reports/run.md', 'disk only\n');
    const done = await promote();
    const [entry] = manifest();
    expect(entry!.checksum).toHaveLength(64);
    expect(entry!.disk_checksum).toHaveLength(64);
    expect(entry!.disk_checksum).not.toBe(entry!.checksum);
    const here = list_generations(root, manifest() as any);
    expect(here[0]).toMatchObject({ status: 'ok', disk_only_absent: 0 });

    const clone = mkdtempSync(join(tmpdir(), 'rotate-clone-'));
    try {
      rmSync(clone, { recursive: true });
      execFileSync('git', ['clone', '-q', root, clone]);
      const rows = list_generations(clone, manifest() as any);
      expect(rows[0]).toMatchObject({ status: 'ok', disk_only_absent: 1 });
      writable(join(clone, '.documentation-cold'));
      writeFileSync(join(clone, done.cold_path, 'backend/b.md'), 'tampered');
      expect(list_generations(clone, manifest() as any)[0]!.status).toBe('CHANGED');
      git(clone, 'checkout', '-q', '--', '.');
      const undone = await run_undo({ ...(await ctx(clone)), generation: done.generation });
      expect(undone.disk_only_absent).toBe(1);
      expect(readFileSync(join(clone, '.documentation/backend/a.md'), 'utf8')).toBe('---\ntitle: a\n---\n\n# a\n');
      expect(existsSync(join(clone, '.documentation/reports/run.md'))).toBe(false);
    } finally { writable(clone); rmSync(clone, { recursive: true, force: true }); }
  });
});

describe('#10 undo cleans up', () => {
  it('leaves no empty cold root behind when the generation had no ledger copy', async () => {
    put('.documentation/reports/run.md', 'disk only\n');
    const done = await promote();
    await run_undo({ ...(await ctx()), generation: done.generation });
    expect(existsSync(join(root, '.documentation-cold'))).toBe(false);
    expect(g('status', '--porcelain')).toBe('');
  });
  it('keeps a cold root that still holds another generation', async () => {
    const first = await promote();
    rmSync(join(root, '.hewtd/stage'), { recursive: true });
    const second = await run_promote({ ...(await ctx()), stage: await stage_it() });
    await run_undo({ ...(await ctx()), generation: second.generation });
    expect(existsSync(join(root, first.cold_path))).toBe(true);
  });
});

// keep plan_promote referenced (type import parity with the CLI)
void plan_promote;

describe('#9 audit finds the cold generations from a subdirectory', () => {
  it('warns about a changed generation when run from a subfolder of the repo', async () => {
    const done = await promote();
    writable(join(root, '.documentation-cold'));
    writeFileSync(join(root, done.cold_path, 'backend/b.md'), 'tampered');
    g('add', '-A'); g('commit', '-qm', 'tamper');
    mkdirSync(join(root, 'sub/deeper'), { recursive: true });
    const cli = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
    const out = spawnSync('node', [cli, 'audit', '-r', '-p', docs], { cwd: join(root, 'sub/deeper'), encoding: 'utf8' });
    const report = /Report saved: (\S+)/.exec(out.stdout + out.stderr)?.[1];
    expect(report, out.stdout + out.stderr).toBeTruthy();
    expect(readFileSync(report!, 'utf8')).toContain(`cold generation ${done.generation} changed`);
  });
});
