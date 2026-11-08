/**
 * `reports/` scan exclusion (#27).
 *
 * `audit`, `report`, and `maintain` write their output into `<docs>/reports/`.
 * Scanning it made the tool grade its own artifacts: every generated report
 * carries `domains: [root]` and an ISO timestamp in its filename, so each one
 * raised a `metadata-domain` and a `naming-convention` warning. The headline
 * health score therefore fell as reports accumulated rather than as
 * documentation quality changed — a team running `maintain` weekly watched its
 * score drop for doing maintenance.
 *
 * Excluded at the docs root ONLY. A `features/reports/` folder is somebody's
 * documentation ABOUT reports and stays in the corpus; assuming the name
 * implied the artifact is the mistake #19 was about.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';

import { find_markdown_files } from '../../../src/utils/glob.js';
import { check_documentation } from '../../../src/core/audit/auditor.js';

const DOC = (title: string, domain: string) =>
  [
    '---',
    `title: ${title}`,
    'tier: guide',
    'domains:',
    `  - ${domain}`,
    'status: active',
    "last_updated: '2026-08-22'",
    "version: '1.0.0'",
    '---',
    '',
    `# ${title}`,
    '',
    'Body.',
    '',
  ].join('\n');

/** Shaped like what `maintain` actually writes. */
const GENERATED_REPORT = [
  '---',
  'title: Documentation Audit Report',
  'tier: reference',
  'domains: [root]',
  'status: active',
  '---',
  '',
  '# Audit Report',
  '',
].join('\n');

describe('reports/ is excluded from documentation scans', () => {
  let tmp_project: string;
  let docs_path: string;

  beforeEach(async () => {
    tmp_project = await mkdtemp(join(tmpdir(), 'hewtd-reports-'));
    docs_path = join(tmp_project, '.documentation');
    await mkdir(join(docs_path, 'procedures'), { recursive: true });
    await mkdir(join(docs_path, 'reports'), { recursive: true });
    await mkdir(join(docs_path, 'features', 'reports'), { recursive: true });

    await writeFile(join(docs_path, 'procedures', 'sample.md'), DOC('Sample', 'procedures'), 'utf-8');
    await writeFile(
      join(docs_path, 'reports', 'maintenance-2026-08-31T06-26-21.md'),
      GENERATED_REPORT,
      'utf-8'
    );
    await writeFile(
      join(docs_path, 'reports', 'audit-2026-08-31T06-26-22.md'),
      GENERATED_REPORT,
      'utf-8'
    );
    await writeFile(
      join(docs_path, 'features', 'reports', 'about-reports.md'),
      DOC('About Reports', 'features'),
      'utf-8'
    );
  });

  afterEach(async () => {
    await rm(tmp_project, { recursive: true, force: true });
  });

  const scanned = async () =>
    (await find_markdown_files(docs_path)).map((f) => relative(docs_path, f).replace(/\\/g, '/'));

  it('does not scan generated reports at the docs root', async () => {
    const files = await scanned();
    expect(files.some((f) => f.startsWith('reports/'))).toBe(false);
  });

  it('still scans a nested features/reports/ document', async () => {
    // Somebody's documentation ABOUT reports is not a generated artifact.
    expect(await scanned()).toContain('features/reports/about-reports.md');
  });

  it('still scans ordinary documentation', async () => {
    expect(await scanned()).toContain('procedures/sample.md');
  });

  it('raises no audit issues against generated reports', async () => {
    const result = await check_documentation({ docs_path });
    const from_reports = result.issues.filter((i) =>
      i.file.replace(/\\/g, '/').startsWith('reports/')
    );
    expect(from_reports).toEqual([]);
  });

  it('does not degrade as more reports accumulate', async () => {
    // The point of the fix: the score must track documentation quality, not how
    // often maintenance has been run.
    const before = await check_documentation({ docs_path });

    for (let i = 0; i < 8; i++) {
      await writeFile(
        join(docs_path, 'reports', `maintenance-2026-09-0${i}T00-00-00.md`),
        GENERATED_REPORT,
        'utf-8'
      );
    }

    const after = await check_documentation({ docs_path });
    expect(after.issues.length).toBe(before.issues.length);
    expect(after.total_files).toBe(before.total_files);
  });
});
