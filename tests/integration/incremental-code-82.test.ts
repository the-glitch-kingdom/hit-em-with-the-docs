import { describe, it, expect } from 'vitest';
import { use_incremental_fixture } from './incremental-82-fixture';

// Issue #82 acceptance checks through the built CLI (part 1); fixture in incremental-82-fixture.ts.
const { g, put, fm, reset_calls, commit_all, index_ok, cold, resolved_docs } = use_incremental_fixture();

describe('code changes are incremental (#82)', () => {
  it('a code commit resolves again only the docs citing the changed file', () => {
    index_ok();
    put('src/c2.ts', 'export function unitFn2() { return 22; }\n');
    commit_all('code');
    reset_calls();
    const incremental = index_ok();
    expect(resolved_docs()).toBe(1);
    expect(incremental).toBe(cold());
  });

  it('a commit touching a script resolves nothing again', () => {
    index_ok();
    put('scripts/run.sh', '#!/bin/sh\n# a comment\necho hi\n');
    commit_all('sh');
    reset_calls();
    const incremental = index_ok();
    expect(resolved_docs()).toBe(0);
    expect(incremental).toBe(cold());
  });

  it('a change and its revert still resolve the citing doc again (its commit count moved)', () => {
    index_ok();
    put('src/c2.ts', 'export function unitFn2() { return 22; }\n');
    commit_all('change');
    put('src/c2.ts', 'export function unitFn2() { return 2; }\n');
    commit_all('revert');
    reset_calls();
    const incremental = index_ok();
    expect(resolved_docs()).toBe(1);
    expect(incremental).toBe(cold());
  });

  it('a docs-only commit equals cold', () => {
    index_ok();
    put('.documentation/backend/d2.md', fm('d2', 'Changed; see `unitFn2()`.', 'src/c2.ts'));
    commit_all('docs');
    expect(index_ok()).toBe(cold());
  });

  it('a commit deleting a cited file equals cold', () => {
    index_ok();
    g('rm', '-q', 'src/c1.ts');
    g('commit', '-qm', 'delete');
    expect(index_ok()).toBe(cold());
  });

  it('a commit adding the file a missing path ref names equals cold', () => {
    index_ok();
    put('lib/extra.ts', 'export const x = 1;\n');
    commit_all('add file');
    expect(index_ok()).toBe(cold());
  });
});
