/**
 * Archive scan exclusion (2.8.0).
 *
 * The policy: archived content is **referenceable but never concrete**. A link
 * into the archive still resolves — history stays reachable — but nothing under
 * an `archive/` folder is part of the active corpus. It is not indexed, not
 * audited, not metadata-validated, not dup-checked, and never counted.
 *
 * Before 2.8.0 the ignore glob was anchored at the docs root (`archive/**`), so
 * a NESTED archive folder was still scanned and validated, while 2.7.1's indexer
 * correctly skipped it. Retired docs could raise audit errors for content nobody
 * was supposed to be reading.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';

import { find_markdown_files } from '../../../src/utils/glob.js';
import { check_documentation } from '../../../src/core/audit/auditor.js';
import { check_links } from '../../../src/core/links/checker.js';

describe('archive/ is excluded from every scan, at any depth', () => {
  let tmp_project: string;
  let docs_root: string;

  beforeEach(async () => {
    tmp_project = await mkdtemp(join(tmpdir(), 'hewtd-archive-'));
    docs_root = join(tmp_project, '.documentation');

    const doc = (title: string, body = '') =>
      `---\ntitle: ${title}\ntier: guide\ndomains:\n  - api\nstatus: active\n` +
      `last_updated: '2026-07-14'\nversion: 1.0.0\n---\n\n# ${title}\n\n${body}\n`;

    await mkdir(join(docs_root, 'api'), { recursive: true });
    await mkdir(join(docs_root, 'archive', 'api'), { recursive: true });
    await mkdir(join(docs_root, 'features', 'archive'), { recursive: true });

    // An active doc that LINKS INTO the archive — history must stay reachable.
    await writeFile(
      join(docs_root, 'api', 'current.md'),
      doc('Current Guide', 'Superseded the [old approach](../archive/api/old.md).'),
      'utf-8'
    );
    // Top-level archive (excluded before 2.8.0 too).
    await writeFile(join(docs_root, 'archive', 'api', 'old.md'), doc('Old Guide'), 'utf-8');
    // NESTED archive — this is the one that used to leak into scans.
    await writeFile(
      join(docs_root, 'features', 'archive', 'retired.md'),
      doc('Retired Feature'),
      'utf-8'
    );
  });

  afterEach(async () => {
    await rm(tmp_project, { recursive: true, force: true });
  });

  it('the corpus scanner skips archived docs at every depth', async () => {
    const files = (await find_markdown_files(docs_root)).map((f) => relative(docs_root, f));

    expect(files).toContain(join('api', 'current.md'));
    expect(files.some((f) => f.includes('archive'))).toBe(false);
  });

  it('audit never validates archived content', async () => {
    const result = await check_documentation({ docs_root: docs_root, silent: true });

    // No issue may be attributed to a file under an archive/ folder — an
    // archived doc's stale frontmatter is not a problem to be reported.
    const archive_issues = result.issues.filter((i) => i.file?.includes('archive'));
    expect(archive_issues).toEqual([]);
  });

  it('a link INTO the archive still resolves — referenceable, just not concrete', async () => {
    const result = await check_links({ docs_root: docs_root, silent: true });

    const broken_into_archive = result.broken_links.filter((b) =>
      b.targetPath.includes('archive')
    );
    expect(broken_into_archive).toEqual([]);
  });
});
