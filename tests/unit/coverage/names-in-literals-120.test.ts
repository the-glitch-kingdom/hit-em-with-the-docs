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
  repo = mkdtempSync(join(tmpdir(), 'names120-'));
  w('scripts/audit.sh', '#!/bin/sh\n# fall back to npm audit fix --package-lock-only when the gate fails, then npm ci --omit=dev\nnpm audit --omit=dev\nnpm audit fix --package-lock-only\n');
  w('tests/helper.py', 'data = load(Path(__file__).parent / "fixtures" / "orders_sample.json")\n');
  w('src/cfg.py', 'conf = {"password": "swordfish", "mode": "strictmode"}\n');
  w('src/login.sh', 'mysql -pHunter2Hunter2 --password=hunter2 --token abc123xyz\nHOST="db-1.example.com"\nregister("a_plain_word", handler)\nPAGE = "https://example.com/x"\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const run = async (facets: string[]) => {
  const r = await plan_coverage_misses({ repo_root: repo, docs_root: join(repo, '.documentation'), config: await load_plugin_config(repo), gaps: [{ query: 'q', used_doc: null, id: 'q', facets }], today: '2026-11-15' });
  return r.proposals.flatMap((proposal) => proposal.missing_facets);
};

describe('a name inside a literal or comment is not a value (#120 section 4)', () => {
  it('flag names in a comment or script line are kept', async () => {
    expect(await run(['npm audit fix --package-lock-only', '--omit=dev'])).toEqual(['npm audit fix --package-lock-only', '--omit=dev']);
  });
  it('a fixture file name in a path expression is kept', async () => {
    expect(await run(['orders_sample.json'])).toEqual(['orders_sample.json']);
  });
  it('a plain word in quotes is withheld (only the five name shapes are names; main withheld it too)', async () => {
    expect(await run(['a_plain_word'])).toEqual(['[redacted facet]']);
  });
  it('option arguments and host, url, key-shaped literals stay withheld', async () => {
    const out = await run(['Hunter2Hunter2', 'hunter2', 'abc123xyz', 'db-1.example.com', 'https://example.com/x']);
    expect(out).toEqual(['[redacted facet]']); // one redacted entry: the facets collapse
  });
  it('a literal under a value name stays withheld, and so does a single bare token (only clearly name-shaped literals are names)', async () => {
    expect(await run(['swordfish'])).toEqual(['[redacted facet]']);
    expect(await run(['strictmode'])).toEqual(['[redacted facet]']); // one bare token is not clearly a name
  });
});
