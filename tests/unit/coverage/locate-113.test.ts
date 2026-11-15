import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locate_facets, is_instruction_file } from '../../../src/core/coverage/locate.js';

let repo: string;
const w = (p: string, t: string): void => { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), t); };
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'locate-'));
  w('src/cache.ts', 'export const a = 1;\nexport const CACHE_TTL = 3600;\nconst b = 2;\n');
  w('src/queue.ts', 'const retry_limit = 5;\nconst CACHE_TTL_ALIAS = 1;\n');
  w('.documentation/ops/cache.md', '# cache\nCACHE_TTL is documented here\n');
  w('CLAUDE.md', 'Remember: nightly_vacuum runs at night\n');
  w('.claude/rules/x.md', 'also nightly_vacuum\n');
  w('reports/r.txt', 'CACHE_TTL in a report\n');
  w('docs-cold/old.ts', 'CACHE_TTL = 1\n');
  w('node_modules/pkg/i.js', 'CACHE_TTL\n');
  w('src/blob.bin', 'CACHE_TTL\0\0\0');
  w('untracked-later.ts', 'x');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('locate_facets (#113)', () => {
  it('finds files and lines in tracked code only; docs, reports, cold root, binaries and instruction files are excluded', async () => {
    const r = await locate_facets({ repo_root: repo, docs_root: join(repo, '.documentation'), cold_root: 'docs-cold', facets: ['CACHE_TTL\\b', 'retry_limit', 'nightly_vacuum', 'nowhere_at_all'] });
    expect(r.code.get('CACHE_TTL\\b')).toEqual([{ file: 'src/cache.ts', line: 2 }]);
    expect(r.code.get('retry_limit')).toEqual([{ file: 'src/queue.ts', line: 1 }]);
    expect(r.code.get('nightly_vacuum')).toEqual([]);
    expect(r.instructions.get('nightly_vacuum')).toEqual([{ file: '.claude/rules/x.md', line: 1 }, { file: 'CLAUDE.md', line: 1 }]);
    expect(r.code.get('nowhere_at_all')).toEqual([]);
    expect(r.instructions.get('CACHE_TTL\\b')).toEqual([]);
  });
  it('returns no line text (a value never leaves the located file)', async () => {
    const r = await locate_facets({ repo_root: repo, docs_root: join(repo, '.documentation'), facets: ['CACHE_TTL\\b'] });
    expect(JSON.stringify([...r.code])).not.toContain('3600');
  });
  it('skips invalid facets instead of throwing', async () => {
    const r = await locate_facets({ repo_root: repo, docs_root: join(repo, '.documentation'), facets: ['(oops', 'retry_limit'] });
    expect(r.code.has('(oops')).toBe(false);
    expect(r.code.get('retry_limit')).toHaveLength(1);
  });
  it('recognises instruction files', () => {
    expect(['CLAUDE.md', 'a/AGENTS.md', '.claude/rules/x.md', 'sub/.claude/rules/y.md'].every(is_instruction_file)).toBe(true);
    expect(['README.md', 'src/a.ts'].some(is_instruction_file)).toBe(false);
  });
});
