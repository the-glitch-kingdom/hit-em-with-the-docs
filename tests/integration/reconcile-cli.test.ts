import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// End-to-end through the built CLI (#54): triage -> review skeleton -> fake agent -> --apply -> rerun.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
let docs: string;

const g = (...a: string[]) =>
  execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8', env: { ...process.env, ...(a[0] === 'commit' && { GIT_AUTHOR_DATE: '2001-02-03T00:00:00', GIT_COMMITTER_DATE: '2001-02-03T00:00:00' }) } }).trim();
const hewtd = (args: string[], cwd = root) => spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const fm = (title: string, extra = '') => `---\ntitle: ${title}\ndomains:\n  - backend\n${extra}---\n\n# ${title}\n\nBody of ${title}.\n`;
// hewtd stamps dates in UTC (formatDate), so the expectation must too, or the test fails in the evening west of UTC.
const today = () => new Date().toISOString().slice(0, 10);
const sha = (): string => g('rev-parse', 'HEAD');
const tree = (): string => g('ls-files', '-s') + readdirSync(docs, { recursive: true } as never).join(',');
const triage_json = (...a: string[]) => JSON.parse(hewtd(['reconcile', ...a, '--json']).stdout);
const review_files = () => readdirSync(join(root, '.hewtd/reconcile')).filter((f) => /^review-.*\.md$/.test(f)).sort().map((f) => join(root, '.hewtd/reconcile', f));

/** Fake agent: set verdict/fields on the json block of every entry, then tick accept. */
function fill(file: string, fn: (path: string) => Record<string, unknown> | null): void {
  const out = readFileSync(file, 'utf-8').split(/^(?=## )/m).map((sec) => {
    const m = /```json\n([\s\S]*?)\n```/.exec(sec);
    if (!m) return sec;
    const e = JSON.parse(m[1]!);
    const patch = fn(e.path);
    if (!patch) return sec;
    return sec.replace(m[1]!, JSON.stringify({ ...e, ...patch }, null, 2)).replace('- [ ] accept', '- [x] accept');
  });
  writeFileSync(file, out.join(''));
}

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reconcile-cli-'));
  docs = join(root, '.documentation');
  put('src/real.ts', 'export const realThing = 1;\n');
  put('.documentation/backend/a.md', fm('a') + '\nSee `src/real.ts` and `src/gone.ts`.\n');
  put('.documentation/backend/b.md', fm('b') + '\nSee `src/real.ts`.\n');
  put('.documentation/backend/dead.md', fm('dead') + '\nSee `src/x1.ts`, `src/x2.ts`, `src/x3.ts`.\n');
  put('.gitignore', '.hewtd/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('hewtd reconcile (built CLI)', () => {
  it('triage + --write-review change nothing in the tree; missing refs are never clean', () => {
    const before = tree();
    const r = hewtd(['reconcile', 'backend', '--write-review']);
    expect(r.status).toBe(0);
    expect(tree()).toBe(before);
    expect(g('status', '--porcelain')).toBe('');
    expect(review_files()).toHaveLength(1);
    const lanes = Object.fromEntries(triage_json('backend').docs.map((d: { path: string; lane: string }) => [d.path, d.lane]));
    expect(lanes['backend/a.md']).toBe('check');
    expect(lanes['backend/dead.md']).toBe('archive-candidate');
    expect(Object.values(lanes)).not.toContain('clean');
  });

  it('unaccepted and unfilled entries change nothing on apply', () => {
    hewtd(['reconcile', 'backend', '--write-review']);
    const f = review_files()[0]!;
    const before = tree();
    fill(f, () => ({ verdict: 'verify', sources: ['src/real.ts'] }));
    writeFileSync(f, readFileSync(f, 'utf-8').replaceAll('- [x] accept', '- [ ] accept'));
    const r = hewtd(['reconcile', '--apply', f]);
    expect(r.status).toBe(0);
    expect(tree()).toBe(before);
    expect(g('status', '--porcelain')).toBe('');
  });

  it('full cycle: apply stamps today (never the git date), writes sources as listed, creates no folder, and a rerun changes nothing', () => {
    const dirs_before = readdirSync(docs, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    hewtd(['reconcile', 'backend', '--write-review']);
    const f = review_files()[0]!;
    fill(f, (p) => p === 'backend/a.md'
      ? { verdict: 'verify', sources: ['src/real.ts'], patch: [{ old: 'See `src/real.ts` and `src/gone.ts`.', new: 'See `src/real.ts`.' }] }
      : p === 'backend/dead.md' ? { verdict: 'archive', reason: 'code removed' }
      : p === 'backend/b.md' ? { verdict: 'fields', frontmatter: { purpose: 'Explains the b module for the backend service pipeline end to end', last_verified: '1999-01-01' } }
      : null);
    const r = hewtd(['reconcile', '--apply', f]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[applied\] backend\/a\.md/);

    const a = readFileSync(join(docs, 'backend/a.md'), 'utf-8');
    expect(a).toContain(`last_verified: '${today()}'`);
    expect(a).not.toMatch(/2001-02-03/); // the commit date of the fixture
    expect(a).toMatch(/sources:\n\s+- src\/real\.ts/);
    expect(a).not.toContain('src/gone.ts');
    expect(readFileSync(join(docs, 'backend/b.md'), 'utf-8')).not.toContain('last_verified'); // fields verdict never stamps
    expect(existsSync(join(docs, 'backend/dead.md'))).toBe(false);
    expect(existsSync(join(docs, 'archive'))).toBe(true); // the one allowed new folder is the archive
    const dirs_after = readdirSync(docs, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).filter((n) => n !== 'archive');
    expect(dirs_after.sort()).toEqual(dirs_before.sort());
    expect(g('status', '--porcelain')).toBe('');
    expect(g('log', '-1', '--format=%s')).toMatch(/^docs\(index\): refresh after reconcile/);
    expect(g('log', '-2', '--format=%s').split('\n')[1]).toMatch(/^docs\(reconcile\):/);

    // second identical run: nothing changes
    const head = sha();
    const again = hewtd(['reconcile', '--apply', f]);
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/already-applied/);
    expect(sha()).toBe(head);
    expect(g('status', '--porcelain')).toBe('');
  });

  it('--next resumes from the first unreviewed doc', () => {
    hewtd(['reconcile', 'backend', '--write-review']);
    const f = review_files()[0]!;
    fill(f, (p) => (p === 'backend/a.md' ? { verdict: 'verify', sources: ['src/real.ts'] } : null));
    hewtd(['reconcile', '--apply', f]);
    const paths = triage_json('--next', '1').docs.map((d: { path: string }) => d.path);
    expect(paths).toHaveLength(1);
    expect(paths[0]).not.toBe('backend/a.md');
    const st = hewtd(['reconcile', '--status']).stdout;
    expect(st).toMatch(/reviewed 1 of 3/);
  });

  it('--status hints `hewtd index` without a graph and says so when the graph is malformed (#90)', () => {
    hewtd(['reconcile', 'backend', '--write-review']);
    const f = review_files()[0]!;
    fill(f, (p) => (p === 'backend/a.md' ? { verdict: 'verify', sources: ['src/real.ts'] } : null));
    hewtd(['reconcile', '--apply', f]);
    rmSync(join(root, '.hewtd/graph.json'), { force: true });
    expect(hewtd(['reconcile', '--status']).stdout).toMatch(/no \.hewtd\/graph\.json yet \(run `hewtd index`/);
    // review: with the export off, `hewtd index` would never write it, so the hint says why instead
    put('.claude/hit-em-with-the-docs.json', JSON.stringify({ graph_export: false }));
    expect(hewtd(['reconcile', '--status']).stdout).toMatch(/graph_export is off/);
    rmSync(join(root, '.claude/hit-em-with-the-docs.json'));
    put('.hewtd/graph.json', '{"docs": 3}');
    expect(hewtd(['reconcile', '--status']).stdout).toMatch(/graph\.json is malformed/);
    put('.hewtd/graph.json', 'not json');
    expect(hewtd(['reconcile', '--status']).stdout).toMatch(/graph\.json is malformed/);
  });

  it('an error entry exits 1 with a summary line; an applied rewrite leaves --next (#103)', () => {
    hewtd(['reconcile', 'backend', '--write-review']);
    const f = review_files()[0]!;
    fill(f, (p) => (p === 'backend/a.md' ? { verdict: 'rewrite', draft: 'x' } : p === 'backend/b.md' ? { verdict: 'integrate' } : null));
    const r = hewtd(['reconcile', '--apply', f]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/applied 1, stale 0, rejected 1, error 1/);
    expect(triage_json('--next', '3').docs.map((d: { path: string }) => d.path)).not.toContain('backend/a.md');
  });

  it('a doc edited after the review is stale: skipped, nothing overwritten', () => {
    hewtd(['reconcile', 'backend', '--write-review']);
    const f = review_files()[0]!;
    fill(f, (p) => (p === 'backend/b.md' ? { verdict: 'verify', sources: ['src/real.ts'] } : null));
    put('.documentation/backend/b.md', fm('b') + '\nChanged by a human.\n');
    g('add', '-A'); g('commit', '-qm', 'human edit');
    const r = hewtd(['reconcile', '--apply', f]);
    expect(r.stdout).toMatch(/\[stale\] backend\/b\.md/);
    expect(readFileSync(join(docs, 'backend/b.md'), 'utf-8')).not.toContain('last_verified');
  });

  it('refuses to start on a dirty tree in scope', () => {
    writeFileSync(join(docs, 'backend/a.md'), fm('a') + 'dirty\n');
    const r = hewtd(['reconcile', 'backend']);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/uncommitted/);
  });

  it('refuses the whole tree by default', () => {
    const r = hewtd(['reconcile']);
    expect(r.status).not.toBe(0);
  });

  it('team mode: shards are disjoint and complete, serial applies the same docs, overlapping shards are rejected', () => {
    for (let i = 0; i < 14; i++) put(`.documentation/backend/n${i}.md`, fm(`n${i}`) + `\nSee \`src/real.ts\`.\n`);
    g('add', '-A'); g('commit', '-qm', 'more');
    const team = triage_json('backend');
    expect(team.mode).toBe('team'); // 16 judged docs >= min_docs 12
    const all = team.shards.flatMap((s: { docs: string[] }) => s.docs);
    expect(new Set(all).size).toBe(all.length);
    const serial = triage_json('backend', '--serial');
    expect(serial.mode).toBe('serial');
    const judged = (r: typeof team) => r.docs.filter((d: { lane: string }) => d.lane === 'check' || d.lane === 'fields-only').map((d: { path: string }) => d.path).sort();
    expect(all.slice().sort()).toEqual(judged(serial));

    hewtd(['reconcile', 'backend', '--write-review']);
    const files = review_files();
    expect(files.length).toBe(team.shards.length);
    const entry_paths = files.flatMap((f) => [...readFileSync(f, 'utf-8').matchAll(/^## (.*)$/gm)].map((m) => m[1]));
    expect(new Set(entry_paths).size).toBe(entry_paths.length);

    // forge an overlap: shard 2 also claims a doc from shard 1
    const dup = files[0]!.replace(/review-(\d+)-1\.md$/, 'review-$1-99.md');
    writeFileSync(dup, readFileSync(files[0]!, 'utf-8'));
    fill(files[0]!, () => ({ verdict: 'verify', sources: ['src/real.ts'] }));
    writeFileSync(dup, readFileSync(files[0]!, 'utf-8'));
    const before = tree();
    const r = hewtd(['reconcile', '--apply', files[0]!, dup]);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/appears in both/);
    expect(tree()).toBe(before);
  });

  it('outside lane from a subdirectory: keep_in_place, same-commit move with moved_from, no unaccepted deletion', () => {
    const words = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
    put('README.md', `# Readme\n\n${words}\n`);
    put('notes/design.md', `# Design of the cache layer\n\n${words}\n`);
    put('notes/stub.md', '# todo\n');
    g('add', '-A'); g('commit', '-qm', 'outside');
    const sub = join(root, 'src');
    const r = hewtd(['reconcile', '--outside', '--json', '-p', '../.documentation'], sub);
    expect(r.status).toBe(0);
    const cls = Object.fromEntries(JSON.parse(r.stdout).map((d: { path: string; cls: string }) => [d.path, d.cls]));
    expect(cls['README.md']).toBe('tool-read'); // keep_in_place wins
    expect(cls['notes/design.md']).toBe('misplaced');
    expect(cls['notes/stub.md']).toBe('not-a-doc');

    hewtd(['reconcile', '--outside', '--write-review', '-p', '../.documentation'], sub);
    expect(existsSync(join(sub, '.documentation'))).toBe(false); // no second docs tree under the subdirectory
    expect(existsSync(join(sub, '.hewtd'))).toBe(false);
    const f = review_files().find((x) => x.includes('outside'))!;
    const before = tree();
    // nothing accepted: nothing deleted or moved
    hewtd(['reconcile', '--apply', f], root);
    expect(tree()).toBe(before);
    expect(existsSync(join(root, 'notes/stub.md'))).toBe(true);

    fill(f, (p) => (p === 'notes/design.md' ? { verdict: 'integrate', domain: 'architecture' } : null));
    const head = g('rev-list', '--count', 'HEAD');
    const a = hewtd(['reconcile', '--apply', f], root);
    expect(a.status).toBe(0);
    expect(existsSync(join(root, 'notes/design.md'))).toBe(false);
    expect(g('rev-list', '--count', 'HEAD')).toBe(String(Number(head) + 2)); // move + removal in one docs commit, then the index refresh
    expect(g('status', '--porcelain')).toBe('');
    const moved = readdirSync(join(docs, 'architecture')).find((n) => /design/.test(n))!;
    expect(readFileSync(join(docs, 'architecture', moved), 'utf-8')).toMatch(/moved_from: notes\/design\.md/);
    expect(existsSync(join(root, 'notes/stub.md'))).toBe(true); // never accepted, never deleted
  });
});
