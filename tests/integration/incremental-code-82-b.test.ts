import { describe, it, expect } from 'vitest';
import { use_incremental_fixture } from './incremental-82-fixture';

// Issue #82 acceptance checks through the built CLI (part 2); fixture in incremental-82-fixture.ts.
const { g, put, commit_all, index_ok, cold } = use_incremental_fixture();

describe('code changes are incremental (#82)', () => {
  it('a commit adding a file a bare name or a directory ref now resolves to equals cold', () => {
    index_ok();
    put('lib/extra2.ts', 'export const y = 1;\n');
    put('newdir/a.ts', 'export const z = 1;\n');
    commit_all('add files');
    expect(index_ok()).toBe(cold());
  });

  it('a commit defining a previously unresolved symbol equals cold', () => {
    index_ok();
    put('src/ghost.ts', 'export function GhostFn() { return 1; }\n');
    commit_all('define');
    expect(index_ok()).toBe(cold());
  });

  it('a commit moving the winning definition of a symbol equals cold', () => {
    index_ok();
    put('src/c0.ts', 'export function unitFn0() { return 0; }\n');
    commit_all('move');
    expect(index_ok()).toBe(cold());
  });

  it('a package.json script added in a commit equals cold', () => {
    index_ok();
    put('package.json', JSON.stringify({ name: 'fixture', scripts: { build: 'tsc' } }));
    commit_all('script');
    expect(index_ok()).toBe(cold());
  });

  it('an amended commit (history rewritten) equals cold', () => {
    index_ok();
    put('src/c3.ts', 'export function unitFn3() { return 33; }\n');
    commit_all('code');
    index_ok();
    put('src/c3.ts', 'export function unitFn3() { return 34; }\nexport function GhostFn() {}\n');
    g('add', '-A');
    g('commit', '-q', '--amend', '-m', 'code amended');
    expect(index_ok()).toBe(cold());
  });

  it('a dirty code edit, then its revert, equals cold each time', () => {
    index_ok();
    put('src/c3.ts', 'export function unitFn3() { return 33; }\nexport function GhostFn() {}\n');
    expect(index_ok()).toBe(cold());
    index_ok();
    g('checkout', '--', 'src/c3.ts');
    expect(index_ok()).toBe(cold());
  });

  // #84 made refs depend on .gitignore, a doc-relative location, the secret/ folder and settings files: each must invalidate like code.
});
