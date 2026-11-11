import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// #97 validation: the whole cycle through the built CLI, plus the gaps the focused suites leave.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const { compute_tree_checksum } = await import('../../src/core/reconcile/rotation');
let root: string;
let docs: string;

const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const fm = (title: string, extra = '') => `---\ntitle: ${title}\ndomains:\n  - backend\n${extra}---\n\n# ${title}\n\nBody of ${title}.\n`;
const make_writable = (dir: string): void => { spawnSync('chmod', ['-R', 'u+w', dir]); };
const state = (): string => [compute_tree_checksum(docs), g('rev-parse', 'HEAD'), g('status', '--porcelain', '--ignored')].join('\n');
const manifest = (): Array<Record<string, any>> => JSON.parse(readFileSync(join(root, '.claude/hit-em-with-the-docs.json'), 'utf8')).cold_storage ?? [];
const today = new Date().toISOString().slice(0, 10);

/** Stage into `.hewtd/<name>`, then triage, write-review, accept all as `verify` and apply, all on the copy. */
const stage_and_reconcile = (name: string): string => {
  const stage = join(root, '.hewtd', name);
  expect(hewtd(['reconcile', '--stage', stage]).status).toBe(0);
  expect(hewtd(['reconcile', '--staged', stage, 'backend']).status).toBe(0);
  expect(hewtd(['reconcile', '--staged', stage, 'backend', '--write-review']).status).toBe(0);
  const review = readdirSync(join(stage, 'reconcile')).filter((f) => /^review-.*\.md$/.test(f)).map((f) => join(stage, 'reconcile', f))[0]!;
  writeFileSync(review, readFileSync(review, 'utf8').split(/^(?=## )/m).map((sec) => {
    const m = /```json\n([\s\S]*?)\n```/.exec(sec);
    if (!m) return sec;
    return sec.replace(m[1]!, JSON.stringify({ ...JSON.parse(m[1]!), verdict: 'verify', sources: ['src/real.ts'] }, null, 2)).replace('- [ ] accept', '- [x] accept');
  }).join(''));
  const applied = hewtd(['reconcile', '--staged', stage, '--apply', review]);
  expect(applied.status, applied.stdout + applied.stderr).toBe(0);
  return stage;
};

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rotate-e2e-97-'));
  docs = join(root, '.documentation');
  put('src/real.ts', 'export const realThing = 1;\n');
  put('.documentation/backend/a.md', fm('a') + '\nSee `src/real.ts`.\n');
  put('.documentation/backend/b.md', fm('b') + '\nSee `src/real.ts` and `src/gone.ts`.\n');
  put('.documentation/archive/backend/old.md', fm('old'));
  put('.documentation/reports/run.md', 'generated report, gitignored\n');
  put('.claude/hit-em-with-the-docs.json', JSON.stringify({ updatePolicy: 'nudge', somethingUnmodeled: { keep: true } }, null, 2) + '\n');
  put('.gitignore', '.hewtd/\n.documentation/reports/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => { make_writable(root); rmSync(root, { recursive: true, force: true }); });

describe('cold rotation end to end (#97)', () => {
  it('stage, reconcile the copy, promote, list, undo, promote again', () => {
    const live_before = compute_tree_checksum(docs);
    const head_before = g('rev-parse', 'HEAD');
    const stage = stage_and_reconcile('stage');
    const status_before = g('status', '--porcelain', '--ignored'); // .hewtd/ now exists (ignored)
    // the live side never moved while the copy was reconciled
    expect(compute_tree_checksum(docs)).toBe(live_before);
    expect(g('rev-parse', 'HEAD')).toBe(head_before);
    expect(g('status', '--porcelain', '--ignored')).toBe(status_before);

    const staged_checksum = compute_tree_checksum(join(stage, 'docs'));
    const staged_a = readFileSync(join(stage, 'docs/backend/a.md'), 'utf8');
    const dry = hewtd(['reconcile', '--promote', '--staged', stage]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(state()).toBe([live_before, head_before, status_before].join('\n'));

    const commits_before = g('rev-list', '--count', 'HEAD');
    const done = hewtd(['reconcile', '--promote', '--staged', stage, '--confirm']);
    expect(done.status, done.stdout + done.stderr).toBe(0);
    const [entry] = manifest();
    const cold = join(root, entry!.path);
    expect(entry).toMatchObject({ generation: today, checksum: live_before });
    expect(compute_tree_checksum(cold)).toBe(live_before);
    expect(existsSync(join(cold, 'reports/run.md'))).toBe(true); // gitignored file kept
    expect(statSync(join(cold, 'backend/a.md')).mode & 0o222).toBe(0);
    // live == staged apart from the regenerated indexes
    expect(readFileSync(join(docs, 'backend/a.md'), 'utf8')).toBe(staged_a);
    expect(staged_checksum).toHaveLength(64);
    expect(Number(g('rev-list', '--count', 'HEAD')) - Number(commits_before)).toBe(1);
    expect(g('status', '--porcelain')).toBe('');
    expect(existsSync(join(docs, 'INDEX.md'))).toBe(true);

    expect(hewtd(['reconcile', '--generations']).stdout).toContain(today);
    const after_promote = compute_tree_checksum(docs);

    const undone = hewtd(['reconcile', '--undo', today, '--confirm']);
    expect(undone.status, undone.stdout + undone.stderr).toBe(0);
    expect(compute_tree_checksum(docs)).toBe(live_before);
    expect(g('status', '--porcelain')).toBe('');

    // the rejected tree can be promoted again from its own stage
    const rejected = readdirSync(join(root, '.hewtd/stage')).filter((f) => f.startsWith('rejected-'))[0]!;
    // (rejected-* sits inside .hewtd/stage, so promote it from where undo put it)
    const again = hewtd(['reconcile', '--promote', '--staged', join(root, '.hewtd/stage', rejected), '--confirm']);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(compute_tree_checksum(docs)).toBe(after_promote);
    expect(manifest()).toHaveLength(1);
  });

  it('a second promote the same day gets a -2 suffix; undo of the older generation is refused or leaves the newer intact', () => {
    const first = stage_and_reconcile('s1');
    expect(hewtd(['reconcile', '--promote', '--staged', first, '--confirm']).status).toBe(0);
    const live_one = compute_tree_checksum(docs);
    expect(hewtd(['reconcile', '--stage', join(root, '.hewtd/s2')]).status).toBe(0);
    put('.hewtd/s2/docs/backend/c.md', fm('c'));
    const second = hewtd(['reconcile', '--promote', '--staged', join(root, '.hewtd/s2'), '--confirm']);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(manifest().map((e) => e.generation)).toEqual([today, `${today}-2`]);
    expect(compute_tree_checksum(join(root, `.documentation-cold/${today}-2`))).toBe(live_one);
    expect(g('status', '--porcelain')).toBe('');
    const live_two = compute_tree_checksum(docs);
    const older = hewtd(['reconcile', '--undo', today, '--confirm']);
    // whichever it decides, no tree may be lost: the newer generation and the live tree stay recoverable
    expect(existsSync(join(root, `.documentation-cold/${today}-2`))).toBe(true);
    if (older.status !== 0) expect(compute_tree_checksum(docs)).toBe(live_two);
  });

  it('promoting twice from the same stage refuses', () => {
    const stage = stage_and_reconcile('stage');
    expect(hewtd(['reconcile', '--promote', '--staged', stage, '--confirm']).status).toBe(0);
    const before = state();
    expect(hewtd(['reconcile', '--promote', '--staged', stage, '--confirm']).status).toBe(1);
    expect(state()).toBe(before);
    expect(manifest()).toHaveLength(1);
  });

  it('an unwritable cold root refuses or rolls back with the live tree untouched', () => {
    const stage = stage_and_reconcile('stage');
    mkdirSync(join(root, '.documentation-cold'));
    chmodSync(join(root, '.documentation-cold'), 0o555);
    const before = state();
    const r = hewtd(['reconcile', '--promote', '--staged', stage, '--confirm']);
    chmodSync(join(root, '.documentation-cold'), 0o755);
    expect(r.status).toBe(1);
    expect(state()).toBe(before);
    expect(existsSync(join(stage, 'docs/backend/a.md'))).toBe(true);
    expect(manifest()).toEqual([]);
  });

  it('promotes a stage whose apply moved the ledger, and a symlink inside the tree survives the round trip', () => {
    execFileSync('ln', ['-s', 'backend/a.md', join(docs, 'link.md')]);
    g('add', '-A'); g('commit', '-qm', 'symlink');
    const live_before = compute_tree_checksum(docs);
    const stage = stage_and_reconcile('stage');
    expect(existsSync(join(stage, 'ledger.json'))).toBe(true);
    const done = hewtd(['reconcile', '--promote', '--staged', stage, '--confirm']);
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(existsSync(join(root, '.hewtd/reconcile.json'))).toBe(true);
    expect(compute_tree_checksum(join(root, `.documentation-cold/${today}`))).toBe(live_before);
    expect(hewtd(['reconcile', '--undo', today, '--confirm']).status).toBe(0);
    expect(compute_tree_checksum(docs)).toBe(live_before);
  });

  it('the cold copy is invisible to link-check and duplicates, and the opt-in secrets hook passes on the promote commit', () => {
    // the hook runs `npx --no-install hewtd`: give the temp repo a local shim so it is hermetic
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules/.bin/hewtd'), `#!/bin/sh\nexec node "${CLI}" "$@"\n`);
    chmodSync(join(root, 'node_modules/.bin/hewtd'), 0o755);
    put('.gitignore', '.hewtd/\n.documentation/reports/\nnode_modules/\n');
    g('commit', '-qam', 'ignore node_modules');
    expect(hewtd(['hooks', 'install']).status).toBe(0);
    const stage = stage_and_reconcile('stage');
    const done = hewtd(['reconcile', '--promote', '--staged', stage, '--confirm']);
    expect(done.status, done.stdout + done.stderr).toBe(0); // the hook ran inside the commit
    expect(hewtd(['reconcile', '--generations']).status).toBe(0);
    for (const args of [['link-check'], ['duplicates']]) {
      const r = hewtd(args);
      expect(r.stdout + r.stderr, args.join(' ')).not.toContain('documentation-cold');
    }
  });
});
