import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as child_process from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Issue #77: a docs-only commit or a one-doc edit reuses the cached symbol table (no code `git grep`).
vi.mock('child_process', async (original) => {
  const real = await original<typeof import('child_process')>();
  return { ...real, execFileSync: vi.fn(real.execFileSync) };
});

const { write_graph } = await import('../../src/core/graph/export.js');
const { find_md_mentions } = await import('../../src/core/reconcile/references.js');
const { load_plugin_config } = await import('../../src/utils/config.js');

let root: string;
const git = (...args: string[]) => child_process.execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf-8' }).trim();
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const doc = (body: string) => `---\ntitle: t\ndomains:\n  - backend\n---\n\n# t\n\n${body}\n`;
const greps = (): string[][] => vi.mocked(child_process.execFileSync).mock.calls.filter((call) => (call[1] as string[])[0] === 'grep').map((call) => call[1] as string[]);
const index = async () => { await write_graph({ root, docs_root: join(root, '.documentation'), config: await load_plugin_config(root) }); return readFileSync(join(root, '.hewtd/graph.json'), 'utf-8'); };
const cold = async () => { rmSync(join(root, '.hewtd'), { recursive: true, force: true }); return index(); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'st77-'));
  git('init', '-q');
  put('.gitignore', '.hewtd/\n');
  put('src/a.ts', 'export function alphaUnit() { return 1; }\nexport const betaValue = () => 2;\n');
  put('.documentation/backend/one.md', doc('See `alphaUnit()` and `GhostName` here.'));
  put('.documentation/backend/two.md', doc('See `betaValue()`.'));
  git('add', '-A'); git('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('symbol table reuse (#77)', () => {
  it('runs no git grep after a docs-only commit or an edit that adds no new name, and equals a cold build', async () => {
    await index();
    expect(greps().length).toBeGreaterThan(0); // the first build scans
    put('.documentation/backend/two.md', doc('Edited; still `betaValue()` and `GhostName`.'));
    git('add', '-A'); git('commit', '-qm', 'docs');
    vi.mocked(child_process.execFileSync).mockClear();
    const warm = await index();
    expect(greps()).toEqual([]);
    put('.documentation/backend/one.md', doc('Edited again: `alphaUnit()`, `GhostName`.'));
    vi.mocked(child_process.execFileSync).mockClear();
    const edited = await index();
    expect(greps()).toEqual([]);
    expect(edited).toBe(await cold());
    expect(JSON.parse(warm).docs['backend/two.md']).toBeDefined();
  });

  it('a new name runs a code grep for that name only, and equals a cold build', async () => {
    await index();
    put('.documentation/backend/one.md', doc('See `alphaUnit()` and `FreshName`.'));
    vi.mocked(child_process.execFileSync).mockClear();
    const warm = await index();
    const patterns = greps().filter((args) => args.includes('-f'));
    expect(patterns.length).toBeGreaterThan(0);
    expect(greps().some((args) => args.includes('*.md'))).toBe(false); // mentions are read in Node
    expect(warm).toBe(await cold());
  });

  it('a code commit moving a definition rebuilds the table', async () => {
    await index();
    put('src/b.ts', 'export function alphaUnit() { return 3; }\n');
    git('rm', '-q', '--cached', 'src/a.ts'); rmSync(join(root, 'src/a.ts'));
    put('src/a.ts', 'export const betaValue = () => 2;\n');
    git('add', '-A'); git('commit', '-qm', 'move');
    const warm = await index();
    expect(JSON.parse(warm).symbols.alphaUnit.file).toBe('src/b.ts');
    expect(warm).toBe(await cold());
  });

  it('a name only a doc mentions becomes known to docs, and find_md_mentions gives the first two files', async () => {
    put('docs-extra/x.md', 'GhostName appears\n');
    put('docs-extra/y.md', 'and GhostName again; also \x00binary\n');
    put('docs-extra/z.md', 'GhostName third\n');
    git('add', '-A'); git('commit', '-qm', 'more');
    const found = find_md_mentions(root, ['GhostName', 'Nowhere1']);
    expect([...found.get('GhostName')!]).toEqual(['.documentation/backend/one.md', 'docs-extra/x.md']);
    expect(found.has('Nowhere1')).toBe(false);
  });
});
