import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Graph export (#65) through the built CLI: index writes it, apply updates it.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const GRAPH = () => join(root, '.hewtd/graph.json');
const verdict = (p: string) => JSON.parse(readFileSync(GRAPH(), 'utf-8')).docs[p]?.verdict;
const reviewFile = () => join(root, '.hewtd/reconcile', readdirSync(join(root, '.hewtd/reconcile')).find((f) => /^review-.*\.md$/.test(f))!);
function fill(file: string, fn: (path: string) => Record<string, unknown> | null): void {
  const out = readFileSync(file, 'utf-8').split(/^(?=## )/m).map((sec) => {
    const m = /```json\n([\s\S]*?)\n```/.exec(sec);
    if (!m) return sec;
    const e = JSON.parse(m[1]!);
    const patch = fn(e.path);
    return patch ? sec.replace(m[1]!, JSON.stringify({ ...e, ...patch }, null, 2)).replace('- [ ] accept', '- [x] accept') : sec;
  });
  writeFileSync(file, out.join(''));
}

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'graph-cli-'));
  put('src/real.ts', 'export const realThing = 1;\n');
  put('.documentation/backend/a.md', '---\ntitle: a\ndomains:\n  - backend\n---\n\n# a\n\nSee `src/real.ts` and `src/gone.ts`.\n');
  put('.gitignore', '.hewtd/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('graph export on index and apply', () => {
  it('index writes the graph; an unchanged tree leaves it untouched', async () => {
    expect(hewtd(['index']).status).toBe(0);
    expect(JSON.parse(readFileSync(GRAPH(), 'utf-8')).version).toBe(1);
    const m = statSync(GRAPH()).mtimeMs;
    const bytes = readFileSync(GRAPH(), 'utf-8');
    await new Promise((r) => setTimeout(r, 30));
    hewtd(['index']);
    expect(readFileSync(GRAPH(), 'utf-8')).toBe(bytes);
    expect(statSync(GRAPH()).mtimeMs).toBe(m);
  });

  it('--dry-run writes nothing; graph_export:false writes nothing', () => {
    expect(hewtd(['index', '--dry-run']).stdout).toMatch(/Would update \.hewtd\/graph\.json/);
    expect(existsSync(GRAPH())).toBe(false);
    put('.claude/hit-em-with-the-docs.json', '{"graph_export": false}');
    hewtd(['index']);
    expect(existsSync(GRAPH())).toBe(false);
  });

  it('hints once when the file is not git-ignored', () => {
    put('.gitignore', '');
    expect(hewtd(['index']).stdout).toMatch(/not git-ignored/);
    expect(hewtd(['index']).stdout).not.toMatch(/not git-ignored/);
  });

  it('outside git: skips and does not fail', () => {
    rmSync(join(root, '.git'), { recursive: true });
    const r = hewtd(['index']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/not a git checkout/);
  });

  it('apply updates the touched entry; a batch with no applied entry leaves the file', () => {
    hewtd(['index']);
    expect(verdict('backend/a.md')).not.toBe('verified');
    hewtd(['reconcile', 'backend', '--write-review']);
    const f = reviewFile();
    fill(f, () => ({ verdict: 'integrate' })); // invalid for in-tree docs: error, nothing applied
    const before = readFileSync(GRAPH(), 'utf-8');
    expect(hewtd(['reconcile', '--apply', f]).status).toBe(1);
    expect(readFileSync(GRAPH(), 'utf-8')).toBe(before);
    fill(f, () => ({ verdict: 'verify', sources: ['src/real.ts'] }));
    expect(hewtd(['reconcile', '--apply', f]).status).toBe(0);
    expect(verdict('backend/a.md')).toBe('verified');
  });
});
