import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMaintenance } from '../../../src/core/maintain/orchestrator.js';
import { generateHealthReport } from '../../../src/reports/health-report.js';
import { addOverviewBacklinks } from '../../../src/core/links/backlinks.js';

const FM = (title: string, extra = '') => `---\ntitle: ${title}\ntier: guide\ndomains: [api]\naudience: [developers]\ntags: []\nstatus: active\nlast_updated: '2026-01-01'\nversion: 1.0.0\nestimated_read_time: 1 minute\nword_count: 3\nlast_validated: '2026-01-01'\nbacklinks: []\n${extra}---\n`;
const names = ['a', 'b', 'c', 'd', 'e'];
let root: string;
let docs: string;
const put = (rel: string, text: string) => mkdir(join(docs, rel, '..'), { recursive: true }).then(() => writeFile(join(docs, rel), text));
const setup = async (nested = false) => {
  for (const n of names) await put(`api/${n}.md`, `${FM(n)}\n# Doc ${n}\n\nText.\n`);
  await put('api/sub/f.md', `${FM('f')}\nNo heading here.\n`);
  const links = names.map((n) => `[${n}](${n}.md)`).join('\n') + (nested ? '\n[f](sub/f.md)' : '');
  await put('api/ov.md', `${FM('The Overview', 'kind: overview\n')}\n# Ov\n\n${links}\n`);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hewtd-ov-'));
  docs = join(root, '.documentation');
  await mkdir(join(root, '.claude'), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('addOverviewBacklinks', () => {
  it('skips draft-status members and drafts/ overviews (review fix)', async () => {
    await setup();
    await put('api/a.md', `${FM('a').replace('status: active', 'status: draft')}\n# Doc a\n\nText.\n`);
    await put('drafts/ov2.md', `${FM('Draft Ov', 'kind: overview\n')}\n# D\n\n[b](../api/b.md)\n`);
    const changes = await addOverviewBacklinks(docs);
    expect(changes.map((c) => c.file)).not.toContain('api/a.md');
    expect(changes.flatMap((c) => c.overviews)).not.toContain('drafts/ov2.md');
  });

  it('does not re-insert a back-link the link parser cannot read (review fix)', async () => {
    for (const n of names) await put(`api/${n}.md`, `${FM(n)}\n# Doc ${n}\n\nText.\n`);
    const links = names.map((n) => `[${n}](${n}.md)`).join('\n');
    await put('api/Deploy Flow.md', `${FM('Deploy [v2] Flow', 'kind: overview\n')}\n# Ov\n\n${links}\n`);
    await addOverviewBacklinks(docs);
    const once = await readFile(join(docs, 'api/a.md'), 'utf-8');
    expect(once).toContain('Part of: [Deploy \\[v2\\] Flow](Deploy Flow.md)');
    expect(await addOverviewBacklinks(docs)).toEqual([]);
    expect(await readFile(join(docs, 'api/a.md'), 'utf-8')).toBe(once);
  });

  it('adds the line after the H1, keeps frontmatter, and is idempotent', async () => {
    await setup(true);
    const before = await readFile(join(docs, 'api/a.md'), 'utf-8');
    const changes = await addOverviewBacklinks(docs);
    expect(changes.map((c) => c.file)).toContain('api/a.md');
    const after = await readFile(join(docs, 'api/a.md'), 'utf-8');
    expect(after).toBe(before.replace('# Doc a\n', '# Doc a\n\nPart of: [The Overview](ov.md)\n'));
    // nested member without H1: relative path, top of body
    const f = await readFile(join(docs, 'api/sub/f.md'), 'utf-8');
    expect(f).toMatch(/---\nPart of: \[The Overview\]\(\.\.\/ov\.md\)\n\n\nNo heading here\./);
    expect(await addOverviewBacklinks(docs)).toEqual([]);
    expect(await readFile(join(docs, 'api/a.md'), 'utf-8')).toBe(after);
  });

  it('counts an existing link anywhere in the body', async () => {
    await setup();
    await put('api/a.md', `${FM('a')}\n# A\n\nsee [overview](ov.md)\n`);
    const changes = await addOverviewBacklinks(docs);
    expect(changes.map((c) => c.file)).not.toContain('api/a.md');
  });

  it('dry run writes nothing; two overviews give sorted lines', async () => {
    await setup();
    await put('api/ov2.md', `${FM('Second', 'kind: overview\n')}\n# O2\n\n[a](a.md)\n`);
    const before = await readFile(join(docs, 'api/a.md'), 'utf-8');
    const changes = await addOverviewBacklinks(docs, { dryRun: true });
    expect(changes.find((c) => c.file === 'api/a.md')!.overviews).toEqual(['api/ov.md', 'api/ov2.md']);
    expect(await readFile(join(docs, 'api/a.md'), 'utf-8')).toBe(before);
    await addOverviewBacklinks(docs);
    const a = await readFile(join(docs, 'api/a.md'), 'utf-8');
    expect(a.indexOf('(ov.md)')).toBeLessThan(a.indexOf('(ov2.md)'));
  });
});

describe('maintain overview integration', () => {
  it('--fix writes back-links; without it only lists; backlinks:false does nothing', async () => {
    await setup();
    let r = await runMaintenance({ docsPath: docs, quick: true, silent: true });
    expect(r.overviewBacklinks!.length).toBe(5);
    expect(await readFile(join(docs, 'api/a.md'), 'utf-8')).not.toContain('Part of:');
    await runMaintenance({ docsPath: docs, quick: true, silent: true, fix: true });
    expect(await readFile(join(docs, 'api/a.md'), 'utf-8')).toContain('Part of:');
    r = await runMaintenance({ docsPath: docs, quick: true, silent: true, fix: true });
    expect(r.overviewBacklinks).toEqual([]);

    await writeFile(join(root, '.claude/hit-em-with-the-docs.json'), JSON.stringify({ overview: { backlinks: false } }));
    await put('api/z.md', `${FM('z')}\n# Z\n`);
    await put('api/ov.md', (await readFile(join(docs, 'api/ov.md'), 'utf-8')) + '[z](z.md)\n');
    r = await runMaintenance({ docsPath: docs, quick: true, silent: true, fix: true });
    expect(r.overviewBacklinks).toBeUndefined();
    expect(await readFile(join(docs, 'api/z.md'), 'utf-8')).not.toContain('Part of:');
  });
});

describe('health report overview coverage', () => {
  it('counts clusters with and without an overview', async () => {
    for (const n of names) await put(`ops/${n}.md`, `${FM(n)}\nText\n`);
    await setup();
    const result = await runMaintenance({ docsPath: docs, quick: true, silent: true });
    expect(result.overviewCoverage!.withOverview).toBe(1);
    expect(result.overviewCoverage!.withoutOverview).toBe(1);
    expect(result.overviewCoverage!.missing[0]).toMatchObject({ id: 'ops', size: 5 });
    const md = await generateHealthReport({ docsPath: docs, result, format: 'markdown' });
    expect(md).toContain('1 cluster(s) with an overview, 1 without');
    expect(md).toContain('| ops | 5 |');
    const json = JSON.parse(await generateHealthReport({ docsPath: docs, result, format: 'json' }));
    expect(json.overviewCoverage.withoutOverview).toBe(1);
  });

  it('renders on an empty tree', async () => {
    await mkdir(docs, { recursive: true });
    const result = await runMaintenance({ docsPath: docs, quick: true, silent: true });
    expect(result.overviewCoverage).toEqual({ withOverview: 0, withoutOverview: 0, missing: [] });
    const md = await generateHealthReport({ docsPath: docs, result, format: 'markdown' });
    expect(md).toContain('0 cluster(s) with an overview, 0 without');
  });
});
