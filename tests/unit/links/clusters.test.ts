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
  it('ignores a domain held together only by a generated INDEX', async () => {
    domainDocs('guides');
    put('guides/INDEX.md', names.map((n) => `${n}.md`), 'generated: true\n');
    expect(await findClusters(root, cfg)).toEqual([]);
  });

  it('flags a dense domain whose only full hub is a generated INDEX', async () => {
    names.forEach((n, i) => put(`guides/${n}.md`, [`${names[(i + 1) % 5]}.md`, `${names[(i + 2) % 5]}.md`], 'tags: [deploy, ops]\n'));
    put('guides/INDEX.md', names.map((n) => `${n}.md`), 'generated: true\n');
    const [c] = await findClusters(root, cfg);
    expect(c!.overview).toBeUndefined();
    expect(c!.generatedOnlyHub).toBe(true);
    expect(c!.sharedTags).toEqual(['deploy', 'ops']);
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
    put('guides/c.md', ['d.md']);
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

const clique = (dir: string, prefix: string, n = 5) => {
  const ids = Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  ids.forEach((a) => put(`${dir}/${a}.md`, ids.filter((b) => b !== a).map((b) => `${b}.md`)));
  return ids;
};

describe('findClusters communities', () => {
  it('two dense groups bridged by one link stay two clusters', async () => {
    clique('guides', 'x');
    clique('guides', 'y');
    put('guides/x0.md', ['x1.md', 'x2.md', 'x3.md', 'x4.md', 'y0.md']);
    const cl = await findClusters(root, cfg);
    const sets = cl.filter((c) => c.kind === 'component').map((c) => c.members.map((m) => m.slice(7, 9)).sort().join());
    expect(sets.sort()).toEqual(['x0,x1,x2,x3,x4', 'y0,y1,y2,y3,y4']);
  });

  it('a lone flow inside an already-reported domain is not reported twice (review fix)', async () => {
    clique('guides', 'x');
    names.forEach((n) => put(`guides/z${n}.md`));
    const cl = await findClusters(root, cfg);
    expect(cl.map((c) => [c.kind, c.id])).toEqual([['domain', 'guides']]);
  });

  it('a long chain is not a flow', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `n${i}`);
    ids.forEach((a, i) => put(`d${i % 4}/${a}.md`, i + 1 < ids.length ? [`../d${(i + 1) % 4}/${ids[i + 1]}.md`] : []));
    expect(await findClusters(root, cfg)).toEqual([]);
  });

  it('a README linking everything does not merge groups, and can be the overview', async () => {
    clique('a', 'p');
    clique('b', 'q');
    const all = [...Array.from({ length: 5 }, (_, i) => `a/p${i}.md`), ...Array.from({ length: 5 }, (_, i) => `b/q${i}.md`)];
    put('README.md', [...all, ...Array.from({ length: 20 }, (_, i) => `a/p0.md#${i}`).slice(0, 0)]);
    for (let i = 0; i < 12; i++) put(`misc/m${i}.md`, ['../README.md']);
    put('README.md', [...all, ...Array.from({ length: 12 }, (_, i) => `misc/m${i}.md`)]);
    const cl = (await findClusters(root, cfg)).filter((c) => c.members.some((m) => m.startsWith('a/')) || c.members.some((m) => m.startsWith('b/')));
    expect(cl.every((c) => !(c.members.some((m) => m.startsWith('a/')) && c.members.some((m) => m.startsWith('b/'))))).toBe(true);
    expect(cl.length).toBeGreaterThanOrEqual(2);
  });

  it('merges a domain flow and a cross-domain flow that share most members', async () => {
    const ids = clique('a', 'p');
    put('b/q0.md', ids.map((i) => `../a/${i}.md`));
    ids.forEach((i) => put(`a/${i}.md`, [...ids.filter((j) => j !== i).map((j) => `${j}.md`), '../b/q0.md']));
    const cl = await findClusters(root, cfg);
    expect(cl).toHaveLength(1);
    expect(cl[0]!.members).toHaveLength(6);
  });

  it('a root README linking 40 of 586 docs is not a member of any flow', async () => {
    clique('a', 'p');
    put('README.md', Array.from({ length: 40 }, (_, i) => `misc/m${i}.md`).concat(Array.from({ length: 5 }, (_, i) => `a/p${i}.md`)));
    for (let i = 0; i < 541; i++) put(`misc/m${i}.md`);
    const cl = await findClusters(root, cfg);
    expect(cl.flatMap((c) => c.members)).not.toContain('README.md');
    expect(cl.some((c) => c.id === 'a')).toBe(true);
  });

  it('is deterministic', async () => {
    clique('guides', 'x');
    clique('ref', 'y');
    put('guides/x0.md', ['../ref/y0.md', 'x1.md']);
    const first = JSON.stringify(await findClusters(root, cfg));
    expect(JSON.stringify(await findClusters(root, cfg))).toBe(first);
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
