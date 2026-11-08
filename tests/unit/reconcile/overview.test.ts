import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { load_plugin_config } from '../../../src/utils/config';
import { hash_content } from '../../../src/core/reconcile/ledger';
import { seed_overview, write_members_file } from '../../../src/core/reconcile/overview';

let root: string;
let docs: string;
const put = (rel: string, body: string) => {
  mkdirSync(join(docs, rel, '..'), { recursive: true });
  writeFileSync(join(docs, rel), body);
};
const ledger = (entries: Record<string, object>) => ({ version: 1 as const, entries: entries as any });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'overview-'));
  docs = join(root, '.documentation');
  put('deploy/build.md', '---\ntitle: Build the release\n---\nBuild artifacts for the release deploy flow.\n');
  put('infra/rollout.md', '---\ntitle: Rollout\n---\nHow the release deploy flow rolls out.\n');
  put('misc/unrelated.md', '---\ntitle: Lunch\n---\nSandwiches.\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('seedOverview', () => {
  it('finds an unlinked two-domain flow from a question and marks ledger state', async () => {
    const config = await load_plugin_config(root);
    const h = hash_content(readFileSync(join(docs, 'deploy/build.md'), 'utf-8'));
    const seed = await seed_overview({
      docsPath: docs, config, question: 'release deploy flow',
      ledger: ledger({ 'deploy/build.md': { path: 'deploy/build.md', lane: 'check', verdict: 'verify', content_hash: h } }),
    });
    expect(seed.members.map((m) => [m.path, m.state])).toEqual([['deploy/build.md', 'reconciled'], ['infra/rollout.md', 'unreviewed']]);
  });
  it('marks a changed doc stale and a secret-lane doc secret', async () => {
    const config = await load_plugin_config(root);
    const seed = await seed_overview({
      docsPath: docs, config, question: 'release deploy flow',
      ledger: ledger({
        'deploy/build.md': { path: 'deploy/build.md', lane: 'check', verdict: 'verify', content_hash: 'old' },
        'infra/rollout.md': { path: 'infra/rollout.md', lane: 'secret', content_hash: 'x' },
      }),
    });
    expect(seed.members.map((m) => m.state)).toEqual(['stale', 'secret']);
  });
  it('reports an existing overview and caps members; writes only the members file', async () => {
    put('flows/release.md', '---\ntitle: Release overview\nkind: overview\n---\n[b](../deploy/build.md) [r](../infra/rollout.md)\n');
    const config = await load_plugin_config(root);
    const seed = await seed_overview({ docsPath: docs, config, question: 'release deploy flow', ledger: ledger({}), limit: 2 });
    expect(seed.members).toHaveLength(2);
    expect(seed.existingOverview?.path).toBe('flows/release.md');
    const before = readdirSync(docs, { recursive: true }).sort();
    const file = await write_members_file(root, seed);
    expect(file).toContain(join('.hewtd', 'reconcile', 'overview-release-deploy-flow.json'));
    expect(JSON.parse(readFileSync(file, 'utf-8')).question).toBe('release deploy flow');
    expect(readdirSync(docs, { recursive: true }).sort()).toEqual(before);
  });
});
