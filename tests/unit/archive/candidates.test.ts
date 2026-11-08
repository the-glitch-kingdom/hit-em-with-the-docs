import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { find_archive_candidates } from '../../../src/core/archive/candidates.js';
import type { ArchiveConfig } from '../../../src/utils/config.js';

const CONFIG: ArchiveConfig = {
  honor_status_deprecated: true,
  candidate_after_days: 365,
  require_orphaned: true,
  auto: false,
};

const TODAY = new Date('2026-06-09');

function doc(fields: Record<string, string>, body = '# Doc\n'): string {
  const fm = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return `---\n${fm}\n---\n${body}`;
}

describe('findArchiveCandidates', () => {
  let tmp_dir: string;
  let docs_path: string;

  beforeEach(async () => {
    tmp_dir = await mkdtemp(join(tmpdir(), 'hewtd-cand-'));
    docs_path = join(tmp_dir, '.documentation');
    await mkdir(join(docs_path, 'api'), { recursive: true });
  });
  afterEach(async () => {
    await rm(tmp_dir, { recursive: true, force: true });
  });

  const write = (rel: string, content: string) =>
    writeFile(join(docs_path, rel), content, 'utf-8');

  async function run(config = CONFIG) {
    return find_archive_candidates({ docsPath: docs_path, projectRoot: tmp_dir, config, today: TODAY });
  }

  it('flags a status: deprecated doc (strong signal, alone)', async () => {
    await write('api/dep.md', doc({ title: 'Dep', tier: 'reference', domains: '[api]', status: 'deprecated', last_updated: "'2026-06-01'", version: "'1.0.0'" }));
    const c = await run();
    expect(c.map((x) => x.file)).toContain('api/dep.md');
    expect(c[0]!.signals.deprecated).toBe(true);
  });

  it('flags a superseded_by doc', async () => {
    await write('api/sup.md', doc({ title: 'Sup', tier: 'reference', domains: '[api]', status: 'active', last_updated: "'2026-06-01'", version: "'1.0.0'", superseded_by: 'api/new.md' }));
    const c = await run();
    expect(c.map((x) => x.file)).toContain('api/sup.md');
  });

  it('does NOT flag an active, recent, linked doc', async () => {
    await write('api/a.md', doc({ title: 'A', tier: 'reference', domains: '[api]', status: 'active', last_updated: "'2026-06-01'", version: "'1.0.0'" }, '# A\nlink to [b](b.md)\n'));
    await write('api/b.md', doc({ title: 'B', tier: 'reference', domains: '[api]', status: 'active', last_updated: "'2026-06-01'", version: "'1.0.0'" }));
    const c = await run();
    expect(c).toHaveLength(0);
  });

  it('flags an orphaned + stale doc (age via last_updated fallback, no git)', async () => {
    // Old last_updated, no inbound links → orphaned + stale → candidate.
    await write('api/old.md', doc({ title: 'Old', tier: 'reference', domains: '[api]', status: 'active', last_updated: "'2020-01-01'", version: "'1.0.0'" }));
    const c = await run();
    expect(c.map((x) => x.file)).toContain('api/old.md');
    const old = c.find((x) => x.file === 'api/old.md')!;
    expect(old.signals.orphaned).toBe(true);
    expect(old.signals.stale).toBe(true);
    expect(old.signals.staleSignalDegraded).toBe(true); // used last_updated
  });

  it('does NOT flag old-but-linked when require_orphaned is true', async () => {
    await write('api/old.md', doc({ title: 'Old', tier: 'reference', domains: '[api]', status: 'active', last_updated: "'2020-01-01'", version: "'1.0.0'" }));
    await write('api/ref.md', doc({ title: 'Ref', tier: 'reference', domains: '[api]', status: 'active', last_updated: "'2026-06-01'", version: "'1.0.0'" }, '# Ref\n[old](old.md)\n'));
    const c = await run();
    // old.md is stale but has an inbound link → not a candidate under require_orphaned.
    expect(c.map((x) => x.file)).not.toContain('api/old.md');
  });

  it('respects honor_status_deprecated = false', async () => {
    await write('api/dep.md', doc({ title: 'Dep', tier: 'reference', domains: '[api]', status: 'deprecated', last_updated: "'2026-06-01'", version: "'1.0.0'" }));
    const c = await run({ ...CONFIG, honor_status_deprecated: false });
    // deprecated ignored; recent + orphaned but not stale → not a candidate.
    expect(c.map((x) => x.file)).not.toContain('api/dep.md');
  });
});
