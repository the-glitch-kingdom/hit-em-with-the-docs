import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Graph export (#65) is a side product: no other command may depend on it.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const GRAPH = () => join(root, '.hewtd/graph.json');
const norm = (s: string) => s.split(root).join('<root>').replace(/\d{4}-\d{2}-\d{2}[T ]?[\d:.]*Z?/g, '<date>').replace(/\d+(\.\d+)?\s?ms/g, '<t>').replace(/<date>-\d+-\d+/g, '<date>');

const COMMANDS: string[][] = [
  ['audit'],
  ['link-check'],
  ['maintain', '--quick'],
  ['metadata-sync', '--dry-run'],
  ['reconcile', 'backend', '--json'],
  ['integrate', 'incoming.md', '--auto', '--dry-run'],
];
const run = () => COMMANDS.map((c) => { const r = hewtd(c); return { c: c.join(' '), status: r.status, out: norm(r.stdout), err: norm(r.stderr) }; });

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'graph-indep-'));
  put('src/real.ts', 'export const realThing = 1;\n');
  put('.documentation/backend/a.md', '---\ntitle: a\ndomains:\n  - backend\n---\n\n# a\n\nSee `src/real.ts` and [b](b.md).\n');
  put('.documentation/backend/b.md', '---\ntitle: b\ndomains:\n  - backend\n---\n\n# b\n\nBody.\n');
  put('incoming.md', '---\ntitle: incoming\ndomains:\n  - backend\n---\n\n# incoming\n\nNew words here.\n');
  put('.gitignore', '.hewtd/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('graph independence', () => {
  it('other commands behave the same with the graph absent, present or corrupt', () => {
    expect(hewtd(['index']).status).toBe(0); // INDEX/REGISTRY are index's own output, not the graph
    expect(existsSync(GRAPH())).toBe(true);
    g('add', '-A'); g('commit', '-qm', 'indexes');
    const present = run();
    rmSync(GRAPH());
    const absent = run();
    writeFileSync(GRAPH(), '{ not json');
    const corrupt = run();
    expect(present).toEqual(absent);
    expect(corrupt).toEqual(absent);
  });

  it('graph_export:false writes no graph from any command', () => {
    put('.claude/hit-em-with-the-docs.json', '{"graph_export": false}');
    hewtd(['index']);
    run();
    expect(existsSync(GRAPH())).toBe(false);
    expect(existsSync(join(root, '.hewtd')) ? readdirSync(join(root, '.hewtd')).filter((f) => f.startsWith('graph')) : []).toEqual([]);
  });

  it('index leaves the committed docs tree clean', () => {
    hewtd(['index']);
    g('add', '-A'); g('commit', '-qm', 'indexes');
    hewtd(['index']);
    expect(g('status', '--porcelain', '--', '.documentation')).toBe('');
  });
});
