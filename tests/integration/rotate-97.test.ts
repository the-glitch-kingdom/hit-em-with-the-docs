import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// #97 promote / undo / generations: the swap, the cold generation, and the refusals.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const { compute_tree_checksum } = await import('../../src/core/reconcile/rotation');
let root: string;
let docs: string;
let stage: string;

const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const fm = (title: string, extra = '') => `---\ntitle: ${title}\ndomains:\n  - backend\n${extra}---\n\n# ${title}\n\nBody of ${title}.\n`;
// built at runtime: no secret-shaped literal in a committed file
const fake_key = (): string => ['AKIA', 'QWERTYUIOPASDFGH'].join('');
const make_writable = (dir: string): void => { spawnSync('chmod', ['-R', 'u+w', dir]); };
const state = (): string => [compute_tree_checksum(docs), g('rev-parse', 'HEAD'), g('status', '--porcelain', '--ignored')].join('\n');

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rotate-97-'));
  docs = join(root, '.documentation');
  stage = join(root, '.hewtd/stage');
  put('src/real.ts', 'export const realThing = 1;\n');
  put('.documentation/backend/a.md', fm('a') + `\nSee \`src/real.ts\`. key=${fake_key()}\n`);
  put('.documentation/backend/b.md', fm('b') + '\nSee `src/real.ts`.\n');
  put('.documentation/archive/backend/old.md', fm('old'));
  put('.documentation/reports/run.md', 'generated report, gitignored\n');
  put('.claude/hit-em-with-the-docs.json', JSON.stringify({ updatePolicy: 'nudge', somethingUnmodeled: { keep: true } }, null, 2) + '\n');
  put('.gitignore', '.hewtd/\n.documentation/reports/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => { make_writable(root); rmSync(root, { recursive: true, force: true }); });

/** Stage the live tree and edit the copy, as a reconcile round would. */
const stage_and_edit = (): void => {
  expect(hewtd(['reconcile', '--stage', stage]).status).toBe(0);
  writeFileSync(join(stage, 'docs/backend/a.md'), fm('a') + '\nSee `src/real.ts`. Reconciled.\n');
  put('.hewtd/stage/docs/backend/new.md', fm('new'));
};
const manifest = (): Array<Record<string, unknown>> => JSON.parse(readFileSync(join(root, '.claude/hit-em-with-the-docs.json'), 'utf8')).cold_storage ?? [];
const generation = (): string => manifest()[0]!.generation as string;

describe('reconcile --promote (#97, acceptance)', () => {
  it('without --confirm prints the plan and changes nothing', () => {
    stage_and_edit();
    const before = state();
    const staged_before = compute_tree_checksum(join(stage, 'docs'));
    const planned = hewtd(['reconcile', '--promote', '--staged', stage]);
    expect(planned.status, planned.stderr).toBe(0);
    expect(planned.stdout).toContain('--confirm');
    expect(planned.stdout).toMatch(/1 secret finding/);
    expect(planned.stdout).not.toContain(fake_key());
    expect(state()).toBe(before);
    expect(compute_tree_checksum(join(stage, 'docs'))).toBe(staged_before);
    expect(existsSync(join(root, '.documentation-cold'))).toBe(false);
  });

  it('swaps the tree in and keeps the old one as a committed, read-only, dated cold generation', () => {
    const live_before = compute_tree_checksum(docs); // includes the gitignored reports/
    stage_and_edit();
    const done = hewtd(['reconcile', '--promote', '--staged', stage, '--confirm']);
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(done.stdout + done.stderr).not.toContain(fake_key());

    // the live tree is the staged tree (plus regenerated INDEX/REGISTRY)
    expect(readFileSync(join(docs, 'backend/a.md'), 'utf8')).toContain('Reconciled.');
    expect(existsSync(join(docs, 'backend/new.md'))).toBe(true);
    expect(existsSync(join(docs, 'reports/run.md'))).toBe(true);

    const [entry] = manifest();
    const today = new Date().toISOString().slice(0, 10);
    expect(entry).toMatchObject({ generation: today, path: `.documentation-cold/${today}`, disk_checksum: live_before, checksum: expect.stringMatching(/^[0-9a-f]{64}$/), source_commit: expect.any(String) });
    const cold = join(root, entry!.path as string);
    expect(compute_tree_checksum(cold)).toBe(live_before);
    expect(readFileSync(join(cold, 'reports/run.md'), 'utf8')).toContain('gitignored');
    expect(statSync(join(cold, 'backend/a.md')).mode & 0o222).toBe(0);
    expect(statSync(join(cold, 'backend')).mode & 0o200).not.toBe(0); // files are locked, directories are not (git checkout must unlink)
    expect(entry!.secrets_findings).toEqual([expect.stringMatching(/^backend\/a\.md:\d+$/)]);
    expect(entry!.untracked_files).toEqual([`.documentation-cold/${today}/reports/run.md`]);
    expect(JSON.stringify(entry)).not.toContain(fake_key());
    // the config keeps every key it does not model
    expect(JSON.parse(readFileSync(join(root, '.claude/hit-em-with-the-docs.json'), 'utf8'))).toMatchObject({ updatePolicy: 'nudge', somethingUnmodeled: { keep: true } });

    expect(g('log', '-1', '--format=%s')).toBe(`docs(rotate): promote .hewtd/stage and keep ${today} cold`);
    expect(g('status', '--porcelain')).toBe('');
    const tracked = g('ls-files', '.documentation-cold').split('\n');
    expect(tracked).toContain(`.documentation-cold/${today}/backend/a.md`);
    expect(tracked.some((f) => f.endsWith('reports/run.md'))).toBe(false);
  });

  it('--undo restores the previous tree byte for byte and moves the rejected tree to a new stage', () => {
    const live_before = compute_tree_checksum(docs);
    stage_and_edit();
    const promoted_a = readFileSync(join(stage, 'docs/backend/a.md'), 'utf8');
    expect(hewtd(['reconcile', '--promote', '--staged', stage, '--confirm']).status).toBe(0);
    const gen = generation();
    const head_promoted = g('rev-parse', 'HEAD');

    expect(hewtd(['reconcile', '--undo', gen]).status).toBe(1);
    expect(g('rev-parse', 'HEAD')).toBe(head_promoted);

    const undone = hewtd(['reconcile', '--undo', gen, '--confirm']);
    expect(undone.status, undone.stdout + undone.stderr).toBe(0);
    expect(compute_tree_checksum(docs)).toBe(live_before);
    expect(manifest()).toEqual([]);
    expect(g('log', '-1', '--format=%s')).toBe(`docs(rotate): undo ${gen}`);
    expect(g('status', '--porcelain')).toBe('');
    const stages = join(root, '.hewtd/stage');
    const rejected = readdirSync(stages).filter((f) => f.startsWith('rejected-'))[0]!;
    expect(readFileSync(join(stages, rejected, 'docs/backend/a.md'), 'utf8')).toBe(promoted_a);
    expect(JSON.parse(readFileSync(join(stages, rejected, 'stage.json'), 'utf8'))).toMatchObject({ format: 1, docs_path: '.documentation', live_checksum: live_before });
    expect(JSON.parse(readFileSync(join(root, '.claude/hit-em-with-the-docs.json'), 'utf8')).somethingUnmodeled).toEqual({ keep: true });
    expect(statSync(join(docs, 'backend/a.md')).mode & 0o200).not.toBe(0); // writable again
    expect(existsSync(join(root, '.documentation-cold', gen))).toBe(false);
  });

  it('--generations lists the generation with its checksum status, and --json', () => {
    stage_and_edit();
    hewtd(['reconcile', '--promote', '--staged', stage, '--confirm']);
    const list = hewtd(['reconcile', '--generations']);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain(generation());
    expect(list.stdout).toContain('ok');
    const rows = JSON.parse(hewtd(['reconcile', '--generations', '--json']).stdout);
    expect(rows[0]).toMatchObject({ generation: generation(), status: 'ok', secrets_findings: 1 });
    make_writable(join(root, '.documentation-cold'));
    writeFileSync(join(root, '.documentation-cold', generation(), 'backend/b.md'), 'tampered');
    expect(JSON.parse(hewtd(['reconcile', '--generations', '--json']).stdout)[0].status).toBe('CHANGED');
  });
});

describe('promote / undo refusals change nothing (#97)', () => {
  it('refuses when the live tree drifted since the stage, listing the drifted path', () => {
    stage_and_edit();
    put('.documentation/backend/b.md', fm('b') + '\nChanged after the stage.\n');
    g('commit', '-qam', 'drift');
    const before = state();
    const r = hewtd(['reconcile', '--promote', '--staged', stage, '--confirm']);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('backend/b.md');
    expect(state()).toBe(before);
    expect(existsSync(join(root, '.documentation-cold'))).toBe(false);
  });

  it('refuses a missing stage and an uncommitted docs tree', () => {
    stage_and_edit();
    expect(hewtd(['reconcile', '--promote', '--staged', join(root, '.hewtd/nope'), '--confirm']).status).toBe(1);
    writeFileSync(join(docs, 'backend/b.md'), 'dirty'); // drifted and dirty: refuses either way
    const before = state();
    expect(hewtd(['reconcile', '--promote', '--staged', stage, '--confirm']).status).toBe(1);
    expect(state()).toBe(before);
  });

  it('refuses a dirty tree even when it did not drift (stage taken from the dirty state)', () => {
    put('.documentation/backend/untracked.md', fm('untracked'));
    stage_and_edit();
    const before = state();
    const r = hewtd(['reconcile', '--promote', '--staged', stage, '--confirm']);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('uncommitted');
    expect(state()).toBe(before);
  });

  it('refuses a cold root inside the docs tree, and --promote without --staged', () => {
    stage_and_edit();
    expect(hewtd(['reconcile', '--promote', '--confirm']).status).toBe(1);
    put('.claude/hit-em-with-the-docs.json', JSON.stringify({ reconcile: { cold_root: '.documentation/cold' } }));
    g('commit', '-qam', 'cold root in docs');
    const before = state();
    const r = hewtd(['reconcile', '--promote', '--staged', stage, '--confirm']);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('cold_root');
    expect(state()).toBe(before);
  });

  it('--undo refuses a changed generation and an unknown one', () => {
    stage_and_edit();
    hewtd(['reconcile', '--promote', '--staged', stage, '--confirm']);
    const gen = generation();
    expect(hewtd(['reconcile', '--undo', 'nope', '--confirm']).status).toBe(1);
    make_writable(join(root, '.documentation-cold'));
    writeFileSync(join(root, '.documentation-cold', gen, 'backend/b.md'), 'tampered');
    g('add', '-A'); g('commit', '-qm', 'tamper');
    const live_after_promote = compute_tree_checksum(docs);
    const r = hewtd(['reconcile', '--undo', gen, '--confirm']);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('changed');
    expect(compute_tree_checksum(docs)).toBe(live_after_promote);
  });

  it('rolls back the moves when the commit fails (pre-commit hook exits 1)', () => {
    const live_before = compute_tree_checksum(docs);
    stage_and_edit();
    const staged_checksum = compute_tree_checksum(join(stage, 'docs'));
    const hook = join(root, '.git/hooks/pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    const head = g('rev-parse', 'HEAD');
    const r = hewtd(['reconcile', '--promote', '--staged', stage, '--confirm']);
    expect(r.status).toBe(1);
    expect(compute_tree_checksum(docs)).toBe(live_before);
    // the staged tree is back in the stage (regenerated INDEX/REGISTRY aside)
    expect(readFileSync(join(stage, 'docs/backend/a.md'), 'utf8')).toContain('Reconciled.');
    expect(existsSync(join(stage, 'docs/backend/new.md'))).toBe(true);
    expect(staged_checksum).toHaveLength(64);
    expect(g('rev-parse', 'HEAD')).toBe(head);
    expect(g('status', '--porcelain')).toBe('');
    expect(manifest()).toEqual([]);
    expect(statSync(join(docs, 'backend/a.md')).mode & 0o200).not.toBe(0);
    expect(existsSync(join(root, '.documentation-cold', new Date().toISOString().slice(0, 10)))).toBe(false);
  });
});
