import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { get_graph_block_state } from '../../src/core/reconcile/hooks';

// #108: the graph hook runs in the background (git returns at once), `hewtd graph` serialises itself with a lock and a
// pending marker, and hooks install / upgrade-check upgrade only hewtd's own older block, leaving a backgrounded custom one alone.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const OLD_BLOCK = '# >>> hewtd graph >>>\nif [ "${3:-1}" != "0" ]; then npx --no-install hewtd graph --quiet || true; fi\n# <<< hewtd graph <<<\n';
const USER_BLOCK = '# >>> hewtd graph >>>\nif [ "${3:-1}" != "0" ]; then (npx --no-install hewtd graph --quiet >/dev/null 2>&1 || true) & fi\n# <<< hewtd graph <<<\n';
const CUSTOM_FOREGROUND = '# >>> hewtd graph >>>\nnpx --no-install hewtd graph --quiet -p docs\n# <<< hewtd graph <<<\n';
let root: string;
let home: string;

const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf-8' }).trim();
const hewtd = (args: string[], cwd = root) => spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME: home } });
const put = (rel: string, text: string, base = root) => { mkdirSync(join(base, rel, '..'), { recursive: true }); writeFileSync(join(base, rel), text); };
const read = (rel: string, base = root): string => readFileSync(join(base, rel), 'utf8');
const source_commit = (base: string): string | undefined => { try { return JSON.parse(read('.hewtd/graph.json', base)).source_commit; } catch { return undefined; } };
const wait_for = async (check: () => boolean, ms = 30000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await new Promise((done) => setTimeout(done, 200)); } return check(); };
const upgrade_item = (id: string) => (JSON.parse(hewtd(['upgrade-check', '--json']).stdout).items as Array<{ id: string; status: string; fixable: boolean }>).find((item) => item.id === id)!;

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'graph-108-'));
  home = mkdtempSync(join(tmpdir(), 'graph-108-home-'));
  put('src/real.ts', 'export const realThing = 1;\n');
  put('.documentation/backend/a.md', '---\ntitle: a\ndomains:\n  - backend\n---\n\n# a\n\nSee `src/real.ts`.\n');
  put('.gitignore', 'node_modules/\n.hewtd/\n');
  g(root, 'init', '-q'); g(root, 'add', '-A'); g(root, 'commit', '-qm', 'init');
});
afterEach(() => { for (const dir of [root, home]) rmSync(dir, { recursive: true, force: true }); });

describe('the graph hook does not block git (#108)', () => {
  it('hooks install writes a backgrounded block', () => {
    expect(hewtd(['hooks', 'install']).status).toBe(0);
    const block = read('.git/hooks/post-merge');
    expect(block).toMatch(/hewtd graph --quiet[^\n]*\) >\/dev\/null 2>&1 <\/dev\/null &/);
    expect(block).toContain('>/dev/null 2>&1');
  });
  it('a pull returns at once even when the graph takes seconds, and graph.json reaches HEAD after', async () => {
    const clone = join(mkdtempSync(join(tmpdir(), 'graph-108-clone-')), 'c');
    try {
      execFileSync('git', ['clone', '-q', root, clone]);
      // a slow hewtd: the hook's `npx --no-install hewtd` takes the repo's node_modules/.bin first
      put('node_modules/.bin/hewtd', `#!/bin/sh\nsleep 4\nexec node ${CLI} "$@"\n`, clone); chmodSync(join(clone, 'node_modules/.bin/hewtd'), 0o755);
      expect(hewtd(['hooks', 'install'], clone).status).toBe(0);
      put('src/new.ts', 'export const added = 3;\n'); g(root, 'add', '-A'); g(root, 'commit', '-qm', 'upstream');
      const started = Date.now();
      const pulled = spawnSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', 'pull', '-q', '--no-rebase', 'origin'], { cwd: clone, encoding: 'utf8', env: { ...process.env, HOME: home } });
      const took = Date.now() - started;
      expect(pulled.status, pulled.stderr).toBe(0);
      expect(took).toBeLessThan(3000);
      const head = g(clone, 'rev-parse', 'HEAD');
      expect(await wait_for(() => source_commit(clone) === head)).toBe(true);
    } finally { rmSync(resolve(clone, '..'), { recursive: true, force: true }); }
  }, 60000);
});

describe('hewtd graph serialises itself (#108)', () => {
  it('a run that finds the lock held by a live process leaves a pending marker and exits at once', () => {
    put('.hewtd/graph.lock', String(process.pid));
    const result = hewtd(['graph', '--quiet']);
    expect(result.status).toBe(0);
    expect(existsSync(join(root, '.hewtd/graph.pending'))).toBe(true);
    expect(existsSync(join(root, '.hewtd/graph.json'))).toBe(false);
  });
  it('a stale lock (dead pid) is taken over, and no lock or marker is left', () => {
    put('.hewtd/graph.lock', '999999999');
    expect(hewtd(['graph', '--quiet']).status).toBe(0);
    expect(source_commit(root)).toBe(g(root, 'rev-parse', 'HEAD'));
    expect(existsSync(join(root, '.hewtd/graph.lock'))).toBe(false);
    expect(existsSync(join(root, '.hewtd/graph.pending'))).toBe(false);
  });
  it('concurrent runs do not race: graph.json is valid and at HEAD, nothing left behind', async () => {
    const runs = Array.from({ length: 4 }, () => new Promise<number>((done) => spawn('node', [CLI, 'graph', '--quiet'], { cwd: root, env: { ...process.env, HOME: home } }).on('exit', (code) => done(code ?? 1))));
    expect(await Promise.all(runs)).toEqual([0, 0, 0, 0]);
    expect(source_commit(root)).toBe(g(root, 'rev-parse', 'HEAD'));
    expect(existsSync(join(root, '.hewtd/graph.lock'))).toBe(false);
    expect(existsSync(join(root, '.hewtd/graph.pending'))).toBe(false);
  });
});

describe('only hewtd\'s own older block is upgraded (#108)', () => {
  it('the 3.3.0 foreground block is out of date; hooks install and upgrade-check --fix upgrade it to the backgrounded one', () => {
    put('.git/hooks/post-merge', `#!/bin/sh\n${OLD_BLOCK}`);
    expect(upgrade_item('hook:post-merge')).toMatchObject({ status: 'action', fixable: true });
    hewtd(['upgrade-check', '--fix']);
    expect(read('.git/hooks/post-merge')).toMatch(/<\/dev\/null & fi/);
    expect(upgrade_item('hook:post-merge').status).toBe('ok');
  });
  it('a backgrounded block the user wrote is ok, and neither --fix nor hooks install rewrites it', () => {
    put('.git/hooks/post-merge', `#!/bin/sh\n${USER_BLOCK}`);
    expect(upgrade_item('hook:post-merge')).toMatchObject({ status: 'ok', fixable: false });
    hewtd(['upgrade-check', '--fix']); hewtd(['hooks', 'install']);
    expect(read('.git/hooks/post-merge')).toBe(`#!/bin/sh\n${USER_BLOCK}`);
  });
  it('a custom foreground block is reported (it blocks git) but left alone', () => {
    put('.git/hooks/post-checkout', `#!/bin/sh\n${CUSTOM_FOREGROUND}`);
    expect(upgrade_item('hook:post-checkout')).toMatchObject({ status: 'action', fixable: false });
    hewtd(['upgrade-check', '--fix']); hewtd(['hooks', 'install']);
    expect(read('.git/hooks/post-checkout')).toBe(`#!/bin/sh\n${CUSTOM_FOREGROUND}`);
  });
});

describe('background detection (#108 review)', () => {
  const wrap = (body: string) => `# >>> hewtd graph >>>\n${body}\n# <<< hewtd graph <<<\n`;
  it('a line ending in && or a comment holding & is foreground; a lone & (or & fi, nohup, setsid) is background', () => {
    expect(get_graph_block_state(wrap('npx --no-install hewtd graph --quiet &&\necho done'))).toBe('custom-foreground');
    expect(get_graph_block_state(wrap('npx --no-install hewtd graph --quiet # runs in fg, not &'))).toBe('custom-foreground');
    expect(get_graph_block_state(wrap('npx --no-install hewtd graph --quiet >/dev/null 2>&1'))).toBe('custom-foreground');
    expect(get_graph_block_state(wrap('npx --no-install hewtd graph --quiet -p docs &'))).toBe('custom-background');
    expect(get_graph_block_state(wrap('if true; then (npx --no-install hewtd graph -p docs || true) >/dev/null 2>&1 & fi'))).toBe('custom-background');
    expect(get_graph_block_state(wrap('nohup npx --no-install hewtd graph -p docs >/dev/null 2>&1'))).toBe('custom-background');
  });
});

describe('graph tip (#108 review)', () => {
  it('the not-ignored tip names the whole .hewtd/ folder (lock files too)', () => {
    put('.gitignore', 'node_modules/\n'); g(root, 'add', '-A'); g(root, 'commit', '-qm', 'no ignore');
    const first = hewtd(['graph']).stdout; // the tip prints when graph.json is first created
    expect(first).toMatch(/Tip: \.hewtd\/ is not git-ignored/);
    expect(first).not.toMatch(/\.hewtd\/graph\.json is not git-ignored/);
  });
});
