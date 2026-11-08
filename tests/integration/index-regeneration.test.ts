/**
 * Index regeneration integration tests (2.5.0).
 *
 * Regression coverage for issue #7 — `integrate` could only append a row to
 * an already-populated INDEX.md table, so the FIRST document into a freshly
 * scaffolded domain was never registered (and the failure was swallowed).
 *
 * Verifies the 2.5.0 fix end-to-end against temp trees:
 *   - integrate registers the first doc into a domain
 *   - regenerateIndexes() rebuilds domain + root indexes from disk
 *   - maintain self-heals stale indexes
 *   - audit flags INDEX.md drift, and the flag clears after regeneration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { create_scaffold } from '../../src/generators/scaffold.js';
import { integrate_document } from '../../src/core/integrate/integrator.js';
import {
  regenerate_indexes,
  list_domain_doc_files,
} from '../../src/generators/regenerate.js';
import { run_maintenance } from '../../src/core/maintain/orchestrator.js';
import { check_documentation } from '../../src/core/audit/auditor.js';
import { reset_registry } from '../../src/core/domains/registry.js';
import { check_links } from '../../src/core/links/checker.js';

/** A minimal, valid document body. */
function doc(title: string | null): string {
  const fm = title
    ? `---\ntitle: ${title}\ntier: guide\nstatus: active\nlast_updated: '2026-07-13'\n---\n`
    : `---\ntier: guide\nstatus: active\nlast_updated: '2026-07-13'\n---\n`;
  return `${fm}\n# Body\n\nSome content.\n`;
}

/** Write a file, creating parent directories as needed. */
async function write_doc(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf-8');
}

describe('Index regeneration (2.5.0 — issue #7)', () => {
  let tmp_project: string;
  let docs_root: string;

  beforeEach(async () => {
    tmp_project = await mkdtemp(join(tmpdir(), 'hewtd-index-'));
    docs_root = join(tmp_project, '.documentation');
    await create_scaffold({ root_path: docs_root, overwrite: false, silent: true });
  });

  afterEach(async () => {
    await rm(tmp_project, { recursive: true, force: true });
  });

  it('registers the FIRST document integrated into a domain', async () => {
    // A freshly scaffolded domain INDEX.md has no table — the exact case the
    // old regex-append path silently no-op'd on.
    const src_path = join(tmp_project, 'auth-setup.md');
    await writeFile(
      src_path,
      `---
title: Authentication Setup Guide
---

# Authentication Setup Guide

How to configure authentication, authorization, OAuth, JWT tokens,
login security, and access control for the service.
`,
      'utf-8'
    );

    const result = await integrate_document({
      file_path: src_path,
      docs_root: docs_root,
      auto: true,
      force: true,
      silent: true,
    });

    expect(result.success).toBe(true);
    expect(result.integrated).toBe(true);
    expect(result.domain).toBeDefined();

    // The resolved domain's INDEX.md must now list the integrated document.
    const index_path = join(docs_root, result.domain!, 'INDEX.md');
    const index_content = await readFile(index_path, 'utf-8');
    expect(index_content).toContain('auth-setup.md');
    expect(index_content).toContain('Authentication Setup Guide');
    expect(index_content).toContain('| Document |');
    expect(index_content).not.toContain('*No documents in this domain yet.*');
  });

  describe('target domain (#39)', () => {
    // Keyword detection alone would send this to `security`.
    const security_prose = `# Login outage

Authentication, authorization, OAuth, JWT tokens, login security and access control.
`;
    const integrate = async (frontmatter: string, domain?: string) => {
      const src_path = join(tmp_project, 'login-outage.md');
      await writeFile(src_path, `---\ntitle: Login outage\n${frontmatter}---\n\n${security_prose}`, 'utf-8');
      return integrate_document({ file_path: src_path, docs_root: docs_root, force: true, silent: true, dry_run: true, domain });
    };

    it('uses the first declared domain over keyword detection', async () => {
      const result = await integrate('domains: [troubleshooting]\ntier: reference\n');
      expect(result.domain).toBe('troubleshooting');
      expect(result.target_path).toBe(join(docs_root, 'troubleshooting', 'login-outage.md'));
    });

    it('lets --domain override both, and puts it first in domains:', async () => {
      const result = await integrate('domains: [troubleshooting]\n', 'procedures');
      expect(result.target_path).toBe(join(docs_root, 'procedures', 'login-outage.md'));
      expect(result.metadata?.domains?.[0]).toBe('procedures');
    });

    it('still detects when nothing is declared, and rejects an unknown --domain', async () => {
      expect((await integrate('')).domain).toBe('security');
      const bad = await integrate('', 'not-a-domain');
      expect(bad.success).toBe(false);
      expect(bad.error).toMatch(/Unknown domain: not-a-domain/);
    });
  });

  it('regenerateIndexes() rebuilds domain + root indexes from disk', async () => {
    // Drop two documents straight into a domain — no integrate, no reindex.
    await writeFile(
      join(docs_root, 'security', 'one.md'),
      `---\ntitle: Doc One\ntier: guide\nstatus: active\nlast_updated: '2026-05-16'\n---\n# One\n`,
      'utf-8'
    );
    await writeFile(
      join(docs_root, 'security', 'two.md'),
      `---\ntitle: Doc Two\ntier: reference\nstatus: active\nlast_updated: '2026-05-16'\n---\n# Two\n`,
      'utf-8'
    );

    const result = await regenerate_indexes({ docs_root: docs_root, silent: true });

    expect(result.document_counts.security).toBe(2);
    expect(result.total_documents).toBe(2);
    // 15 domains × INDEX+REGISTRY + root INDEX+REGISTRY.
    expect(result.files_written).toHaveLength(15 * 2 + 2);

    const domain_index = await readFile(join(docs_root, 'security', 'INDEX.md'), 'utf-8');
    expect(domain_index).toContain('Doc One');
    expect(domain_index).toContain('Doc Two');
    expect(domain_index).toContain('**Total Documents:** 2');

    const root_index = await readFile(join(docs_root, 'INDEX.md'), 'utf-8');
    expect(root_index).toMatch(/\[Security\]\(#security\) \| 2 /);
  });

  it('maintain self-heals stale domain indexes', async () => {
    await writeFile(
      join(docs_root, 'database', 'schema-notes.md'),
      `---\ntitle: Schema Notes\ntier: reference\nstatus: active\nlast_updated: '2026-05-16'\n---\n# Schema\n`,
      'utf-8'
    );

    // Scaffolded INDEX.md does not list the new doc yet.
    const before = await readFile(join(docs_root, 'database', 'INDEX.md'), 'utf-8');
    expect(before).not.toContain('schema-notes.md');

    await run_maintenance({ docs_root: docs_root, quick: true, silent: true });

    const after = await readFile(join(docs_root, 'database', 'INDEX.md'), 'utf-8');
    expect(after).toContain('schema-notes.md');
    expect(after).toContain('Schema Notes');
  });

  it('audit flags INDEX.md drift and the flag clears after regeneration', async () => {
    await writeFile(
      join(docs_root, 'testing', 'e2e-strategy.md'),
      `---\ntitle: E2E Strategy\ntier: guide\nstatus: active\nlast_updated: '2026-05-16'\n---\n# E2E\n`,
      'utf-8'
    );

    const drifted = await check_documentation({ docs_root: docs_root, silent: true });
    const drift_issue = drifted.issues.find(
      (i) => i.rule === 'index-drift' && i.file === 'testing/INDEX.md'
    );
    expect(drift_issue).toBeDefined();
    expect(drift_issue?.severity).toBe('error');
    expect(drift_issue?.fixable).toBe(true);

    await regenerate_indexes({ docs_root: docs_root, silent: true });

    const clean = await check_documentation({ docs_root: docs_root, silent: true });
    expect(clean.issues.some((i) => i.rule === 'index-drift')).toBe(false);
  });
});

/**
 * Recursive domain indexing (2.7.1 — issue #12).
 *
 * `listDomainDocFiles()` did a flat readdir, so every document in a subfolder
 * was invisible to the whole system — and because `regenerateIndexes()` rebuilds
 * the root INDEX from disk, regeneration actively DELETED hand-curated root-index
 * entries pointing into subfolders. `regenerates without destroying nested entries`
 * is the test that would have caught that.
 *
 * The exclusion cases are the other half. A flat scan could not physically reach
 * `archive/`, `drafts/`, or the vault's subtrees, so they were excluded by
 * accident; the moment the walk goes deep that accident stops holding. Over-
 * inclusion here would be a worse bug than the one being fixed — publishing
 * retired docs, or every fact and incident narrative, into a live index.
 */
describe('Recursive domain indexing (2.7.1 — issue #12)', () => {
  let tmp_project: string;
  let docs_root: string;

  beforeEach(async () => {
    tmp_project = await mkdtemp(join(tmpdir(), 'hewtd-nested-'));
    docs_root = join(tmp_project, '.documentation');
    await create_scaffold({ root_path: docs_root, overwrite: false, silent: true });
  });

  afterEach(async () => {
    await rm(tmp_project, { recursive: true, force: true });
  });

  it('indexes documents in subfolders', async () => {
    await write_doc(
      join(docs_root, 'standards', 'backend', 'entity-schema-contract.md'),
      doc('Entity Schema Contract')
    );

    const result = await regenerate_indexes({ docs_root: docs_root, silent: true });
    expect(result.document_counts.standards).toBe(1);

    // Domain INDEX links it domain-relative...
    const domain_index = await readFile(join(docs_root, 'standards', 'INDEX.md'), 'utf-8');
    expect(domain_index).toContain('(backend/entity-schema-contract.md)');
    expect(domain_index).toContain('Entity Schema Contract');

    // ...and the root INDEX links it root-relative.
    const root_index = await readFile(join(docs_root, 'INDEX.md'), 'utf-8');
    expect(root_index).toContain('(standards/backend/entity-schema-contract.md)');
  });

  it('regenerates without destroying nested entries', async () => {
    // THE test. Pre-fix, a nested doc was invisible to the scan, so the second
    // regeneration silently dropped it from the indexes — which is how a user
    // running `maintain` in good faith committed the deletion of eight curated
    // root-index rows.
    await write_doc(
      join(docs_root, 'features', 'portfolio', 'property-form.md'),
      doc('Property Form')
    );

    await regenerate_indexes({ docs_root: docs_root, silent: true });
    const after_first = await readFile(join(docs_root, 'INDEX.md'), 'utf-8');
    expect(after_first).toContain('(features/portfolio/property-form.md)');

    await regenerate_indexes({ docs_root: docs_root, silent: true });
    const after_second = await readFile(join(docs_root, 'INDEX.md'), 'utf-8');
    expect(after_second).toContain('(features/portfolio/property-form.md)');

    // Idempotent: a second pass must not churn the file at all.
    expect(after_second).toBe(after_first);
  });

  it('excludes archive/, drafts/ and other reserved subfolders', async () => {
    await write_doc(join(docs_root, 'features', 'live.md'), doc('Live Doc'));
    await write_doc(join(docs_root, 'features', 'archive', 'old.md'), doc('Retired Doc'));
    await write_doc(join(docs_root, 'features', 'drafts', 'wip.md'), doc('Draft Doc'));
    await write_doc(
      join(docs_root, 'features', 'reports', 'q3.md'),
      doc('Generated Report')
    );
    await write_doc(
      join(docs_root, 'features', '_templates', 'skeleton.md'),
      doc('Template')
    );
    // A doc tree vendored inside a doc tree.
    await write_doc(
      join(docs_root, 'features', 'vendored', '.documentation', 'their-doc.md'),
      doc('Somebody Else Doc')
    );

    const result = await regenerate_indexes({ docs_root: docs_root, silent: true });
    expect(result.document_counts.features).toBe(1);

    const domain_index = await readFile(join(docs_root, 'features', 'INDEX.md'), 'utf-8');
    const root_index = await readFile(join(docs_root, 'INDEX.md'), 'utf-8');
    for (const excluded of [
      'Retired Doc',
      'Draft Doc',
      'Generated Report',
      'Template',
      'Somebody Else Doc',
    ]) {
      expect(domain_index).not.toContain(excluded);
      expect(root_index).not.toContain(excluded);
    }
    expect(domain_index).toContain('Live Doc');
  });

  it('does not treat a nested INDEX.md / REGISTRY.md as a document', async () => {
    await write_doc(join(docs_root, 'standards', 'backend', 'real-doc.md'), doc('Real Doc'));
    await write_doc(join(docs_root, 'standards', 'backend', 'INDEX.md'), doc('Nested Index'));
    await write_doc(
      join(docs_root, 'standards', 'backend', 'REGISTRY.md'),
      doc('Nested Registry')
    );

    const files = await list_domain_doc_files(docs_root, 'standards');
    expect(files).toEqual(['backend/real-doc.md']);

    const result = await regenerate_indexes({ docs_root: docs_root, silent: true });
    expect(result.document_counts.standards).toBe(1);
  });

  it('falls back to the basename for a nested doc with no frontmatter title', async () => {
    await write_doc(join(docs_root, 'standards', 'backend', 'foo-bar.md'), doc(null));

    await regenerate_indexes({ docs_root: docs_root, silent: true });

    const domain_index = await readFile(join(docs_root, 'standards', 'INDEX.md'), 'utf-8');
    // "Foo Bar" — not "Backend/foo Bar".
    expect(domain_index).toContain('[Foo Bar](backend/foo-bar.md)');
    expect(domain_index).not.toContain('Backend/foo');
  });

  it('survives a nested doc with malformed frontmatter, and still indexes it', async () => {
    // Found by driving a real tree, not a fixture: gray-matter THROWS on bad
    // YAML, and pre-fix these files were never read. Once the walk goes deep,
    // one broken frontmatter block would abort the run for the whole project.
    await write_doc(join(docs_root, 'features', 'ok', 'good.md'), doc('Good Doc'));
    await write_doc(
      join(docs_root, 'features', 'ux-assist', 'broken.md'),
      `---\ntitle: Broken\nstatus: SUPERSEDED (lean: shared <Strip> + per-page: thing)\n---\n\n# Broken\n`
    );

    const result = await regenerate_indexes({ docs_root: docs_root, silent: true });

    // Both docs indexed — the malformed one is NOT silently dropped, which
    // would recreate the very bug being fixed (a doc invisible to the index).
    expect(result.document_counts.features).toBe(2);

    const domain_index = await readFile(join(docs_root, 'features', 'INDEX.md'), 'utf-8');
    expect(domain_index).toContain('(ok/good.md)');
    expect(domain_index).toContain('(ux-assist/broken.md)');
    // It falls back to the filename-derived title, since its frontmatter is unreadable.
    expect(domain_index).toContain('[Broken](ux-assist/broken.md)');
  });

  it('dryRun computes the full result but writes nothing', async () => {
    await write_doc(join(docs_root, 'standards', 'backend', 'fastapi.md'), doc('FastAPI'));
    const before = await readFile(join(docs_root, 'standards', 'INDEX.md'), 'utf-8');

    const result = await regenerate_indexes({ docs_root: docs_root, silent: true, dry_run: true });

    // Reports everything it WOULD do...
    expect(result.document_counts.standards).toBe(1);
    expect(result.files_written.length).toBe(15 * 2 + 2);

    // ...and touches nothing.
    const after = await readFile(join(docs_root, 'standards', 'INDEX.md'), 'utf-8');
    expect(after).toBe(before);
    expect(after).not.toContain('FastAPI');
  });

  it('detects index drift on a nested document', async () => {
    // Pre-fix this was undetectable BY CONSTRUCTION: the drift rule compared
    // INDEX.md against a doc list that shared the same blind spot.
    await write_doc(
      join(docs_root, 'testing', 'e2e', 'playwright-strategy.md'),
      doc('Playwright Strategy')
    );

    const drifted = await check_documentation({ docs_root: docs_root, silent: true });
    const drift_issue = drifted.issues.find(
      (i) => i.rule === 'index-drift' && i.file === 'testing/INDEX.md'
    );
    expect(drift_issue).toBeDefined();

    await regenerate_indexes({ docs_root: docs_root, silent: true });

    const clean = await check_documentation({ docs_root: docs_root, silent: true });
    expect(clean.issues.some((i) => i.rule === 'index-drift')).toBe(false);
  });

  describe('vault exclusion (knowledge-base registered as a domain)', () => {
    const original_cwd = process.cwd();

    beforeEach(async () => {
      // The scenario that surfaced this: the vault root is ALSO a configured
      // domain, so a recursive walk would sweep every fact and incident
      // narrative into a generic domain INDEX — indexed a second time, and
      // rendered as if they were plain guides.
      await mkdir(join(tmp_project, '.claude'), { recursive: true });
      await writeFile(
        join(tmp_project, '.claude', 'hit-em-with-the-docs.json'),
        JSON.stringify({
          domains: [
            {
              id: 'knowledge-base',
              name: 'Knowledge Base',
              description: 'Atomic facts, incident narratives, postmortems',
              keywords: ['fact', 'incident', 'postmortem'],
              loadPriority: 5,
              category: 'advanced',
            },
          ],
        }),
        'utf-8'
      );
      process.chdir(tmp_project);
      reset_registry();
    });

    afterEach(() => {
      process.chdir(original_cwd);
      reset_registry();
    });

    it('withholds the vault subtrees but still indexes its top-level docs', async () => {
      const vault = join(docs_root, 'knowledge-base');
      await write_doc(join(vault, 'README.md'), doc('Knowledge Base README'));
      await write_doc(join(vault, 'facts', 'alloy-env-only.md'), doc('Alloy Env Fact'));
      await write_doc(
        join(vault, 'incidents', '2026-05-14-vault-alloy-stuck', 'narrative.md'),
        doc('Alloy Incident')
      );
      await write_doc(
        join(vault, 'symptoms', 'grafana-alerts.md'),
        doc('Grafana Symptoms')
      );

      const files = await list_domain_doc_files(docs_root, 'knowledge-base');
      // The README is a normal doc and stays indexed, exactly as it was before
      // the walk went recursive. Everything the vault's own generators own is
      // withheld.
      expect(files).toEqual(['README.md']);

      const result = await regenerate_indexes({ docs_root: docs_root, silent: true });
      expect(result.document_counts['knowledge-base']).toBe(1);

      const domain_index = await readFile(join(vault, 'INDEX.md'), 'utf-8');
      const root_index = await readFile(join(docs_root, 'INDEX.md'), 'utf-8');
      for (const content of [domain_index, root_index]) {
        expect(content).not.toContain('Alloy Env Fact');
        expect(content).not.toContain('Alloy Incident');
        expect(content).not.toContain('Grafana Symptoms');
      }
      expect(domain_index).toContain('Knowledge Base README');
    });
  });
});

describe('Generated indexes link only to domains that exist (#45)', () => {
  let tmp_project: string;
  let docs_root: string;
  const original_cwd = process.cwd();

  beforeEach(async () => {
    tmp_project = await mkdtemp(join(tmpdir(), 'hewtd-dead-links-'));
    docs_root = join(tmp_project, '.documentation');
    // One custom domain, so custom folders count as present too.
    await write_doc(
      join(tmp_project, '.claude', 'hit-em-with-the-docs.json'),
      JSON.stringify({
        domains: [
          {
            id: 'compliance',
            name: 'Compliance',
            description: 'Regulatory compliance docs',
            keywords: ['gdpr', 'troubleshooting', 'reference'],
            loadPriority: 7,
            category: 'core',
          },
        ],
      })
    );
    process.chdir(tmp_project);
    reset_registry();
  });

  afterEach(async () => {
    process.chdir(original_cwd);
    reset_registry();
    await rm(tmp_project, { recursive: true, force: true });
  });

  it('a tree with only some domains has no broken links after regeneration', async () => {
    for (const d of ['reference', 'troubleshooting', 'compliance']) {
      await write_doc(join(docs_root, d, 'a.md'), doc(`${d} doc`));
    }
    await regenerate_indexes({ docs_root: docs_root, silent: true });

    const result = await check_links({ docs_root: docs_root, silent: true });
    expect(result.broken_links).toEqual([]);

    const registry = await readFile(join(docs_root, 'REGISTRY.md'), 'utf-8');
    expect(registry).toContain('[troubleshooting/](troubleshooting/)');
    expect(registry).toContain('(compliance/)');
    expect(registry).not.toMatch(/\]\((standards|api|devops)\//);
    // Related domains still render, limited to existing folders.
    const index = await readFile(join(docs_root, 'compliance', 'INDEX.md'), 'utf-8');
    expect(index).toContain('## Related Domains');
  });

  it('a partial scaffold links only the scaffolded domains', async () => {
    await create_scaffold({
      root_path: docs_root,
      domains: ['reference', 'troubleshooting'],
      overwrite: false,
      silent: true,
    });
    const result = await check_links({ docs_root: docs_root, silent: true });
    expect(result.broken_links).toEqual([]);
  });
});
