import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { findClusters } from '../../../src/core/links/clusters.js';

const cfg = { min_cluster_size: 5, min_link_coverage: 0.6 };
let root: string;
const put = (rel: string, links: string[] = [], fm = '') => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  const body = links.map((l) => `[x](${l})`).join('\n');
  writeFileSync(p, `---\ntitle: t\n${fm}---\n\n${body}\n`);
};
const names = ['a', 'b', 'c', 'd', 'e'];
const domainDocs = (dir: string) => names.forEach((n) => put(`${dir}/${n}.md`));

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'clusters-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('findClusters', () => {
  it('flags a domain linked only by a generated INDEX', async () => {
    domainDocs('guides');
    put('guides/INDEX.md', names.map((n) => `${n}.md`), 'generated: true\n');
    const [c] = await findClusters(root, cfg);
    expect(c!.members).toHaveLength(5);
    expect(c!.overview).toBeUndefined();
    expect(c!.generatedOnlyHub).toBe(true);
  });

  it('finds a kind: overview doc linking 4 of 5 (duplicates do not inflate)', async () => {
    names.slice(1).forEach((n) => put(`guides/${n}.md`));
    put('guides/a.md', ['b.md', 'b.md', 'b.md', 'c.md', 'd.md'], 'kind: overview\n');
    const [c] = await findClusters(root, cfg);
    expect(c!.overview).toBe('guides/a.md');
    expect(c!.kindOverview).toBe(true);
    expect(c!.coverage).toBe(0.75);
    expect(c!.generatedOnlyHub).toBe(false);
  });

  it('does not count repeated links to one doc as coverage', async () => {
    names.slice(1).forEach((n) => put(`guides/${n}.md`));
    put('guides/a.md', ['b.md', 'b.md', 'b.md', 'b.md']);
    const [c] = await findClusters(root, cfg);
    expect(c!.overview).toBeUndefined();
    expect(c!.coverage).toBe(0.25);
  });

  it('groups a cross-domain chain into one component cluster', async () => {
    put('guides/a.md', ['../reference/b.md']);
    put('reference/b.md', ['../guides/c.md']);
    put('guides/c.md', ['../reference/d.md']);
    put('reference/d.md', ['../guides/e.md']);
    put('guides/e.md');
    const cl = await findClusters(root, cfg);
    expect(cl.map((c) => c.kind)).toEqual(['component']);
    expect(cl[0]!.members).toHaveLength(5);
  });

  it('returns nothing below the size threshold or for archived docs', async () => {
    names.slice(0, 4).forEach((n) => put(`guides/${n}.md`));
    put('guides/e.md', [], 'status: archived\n');
    expect(await findClusters(root, cfg)).toEqual([]);
  });
});

describe('overview config', () => {
  it('defaults leniently', async () => {
    const { loadPluginConfig } = await import('../../../src/utils/config.js');
    writeFileSync(join(root, 'x'), '');
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude/hit-em-with-the-docs.json'), JSON.stringify({ overview: { min_cluster_size: 'x', backlinks: false } }));
    const c = await loadPluginConfig(root);
    expect(c.overview).toEqual({ min_cluster_size: 5, min_link_coverage: 0.6, backlinks: false, disabled: [] });
  });
});
