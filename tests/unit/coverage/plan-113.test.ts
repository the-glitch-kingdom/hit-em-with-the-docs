import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan_coverage_misses } from '../../../src/core/coverage/plan.js';
import { load_plugin_config } from '../../../src/utils/config.js';

let repo: string;
const w = (p: string, t: string): void => { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), t); };
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'plan-'));
  w('src/cache.ts', 'export const cache_ttl = 1;\nexport function purge_cache() {}\n');
  w('.documentation/ops/cache.md', '---\ntitle: Cache\nsources:\n  - src/cache.ts\n---\n# Cache\n\nThe cache_ttl exists.\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('plan_coverage_misses (#113)', () => {
  it('locates, decides, merges and drafts; two misses for one doc become one patch entry', async () => {
    const config = await load_plugin_config(repo);
    const gaps = [
      { query: 'how long does the cache live', used_doc: null, id: 'a', facets: ['cache_ttl', 'purge_cache'] },
      { query: 'how is the cache purged', used_doc: null, id: 'b', facets: ['purge_cache'] },
    ];
    const r = await plan_coverage_misses({ repo_root: repo, docs_root: join(repo, '.documentation'), config, gaps, today: '2026-11-14' });
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]).toMatchObject({ kind: 'extend', doc: 'ops/cache.md' });
    expect(r.proposals[0]!.closes.map((c) => c.key)).toEqual(['a', 'b']);
    expect(r.drafts.entries).toHaveLength(1);
    // #115: purge_cache is a function, not a simple constant: nothing is stated, the judge gets facet + file:line
    expect(r.drafts.entries[0]).toMatchObject({ verdict: null, path: 'ops/cache.md', for_judge: [{ facet: 'purge_cache', at: ['src/cache.ts:2'] }] });
  });
});
