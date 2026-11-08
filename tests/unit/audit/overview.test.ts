import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { check_overview } from '../../../src/core/audit/overview.js';
import { count_actionable_issues } from '../../../src/core/audit/auditor.js';

const cfg = { min_cluster_size: 5, min_link_coverage: 0.6, backlinks: true, disabled: [] as string[] };
let root: string;
const put = (rel: string, links: string[] = [], fm = '') => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `---\ntitle: t\n${fm}---\n\n${links.map((l) => `[x](${l})`).join('\n')}\n`);
};
const members = ['b', 'c', 'd', 'e', 'f'];
const setup = (overview_links: string[] | null) => {
  members.forEach((n, i) => put(`guides/${n}.md`, [`${members[(i + 1) % 5]}.md`, `${members[(i + 2) % 5]}.md`], 'tags: [deploy, rollback]\n'));
  put('guides/INDEX.md', ['a.md', ...members.map((n) => `${n}.md`)], 'generated: true\n');
  if (overview_links) put('guides/a.md', overview_links, 'kind: overview\n');
  else put('guides/a.md');
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'overview-audit-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('checkOverview', () => {
  it('warns OVERVIEW_MISSING when only a generated index links the domain', async () => {
    setup(null);
    const issues = await check_overview(root, cfg);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: 'OVERVIEW_MISSING', severity: 'warning', });
    expect(issues[0]!.code).toBeUndefined();
    expect(issues[0]!.file).toMatch(/^guides\//);
    expect(issues[0]!.message).toMatch(/^Flow: deploy, rollback — 6 docs \(guides\/a\.md, .*, \.\.\.\) have no overview/);
    expect(issues[0]!.message).toContain('generated index');
    expect(issues[0]!.suggestion).toContain('overview.template.md');
  });

  it('is clean once a kind: overview doc links most members', async () => {
    setup(members.map((n) => `${n}.md`));
    expect(await check_overview(root, cfg)).toEqual([]);
  });

  it('warns OVERVIEW_STALE_LINKS naming a member the overview misses', async () => {
    setup(['b.md', 'c.md', 'd.md', 'e.md']);
    const issues = await check_overview(root, cfg);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: 'OVERVIEW_STALE_LINKS', severity: 'warning', file: 'guides/a.md' });
    expect(issues[0]!.message).toContain('guides/f.md');
    expect(issues[0]!.message).not.toContain('guides/b.md');
  });

  it('honours overview.disabled', async () => {
    setup(null);
    expect(await check_overview(root, { ...cfg, disabled: ['OVERVIEW_MISSING'] })).toEqual([]);
  });

  it('OVERVIEW_* warnings never count toward CI failure', () => {
    expect(
      count_actionable_issues([{ rule: 'OVERVIEW_MISSING' }, { rule: 'OVERVIEW_STALE_LINKS' }, { rule: 'metadata-validation' }])
    ).toBe(1);
  });
});
