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

import { createScaffold } from '../../src/generators/scaffold.js';
import { integrateDocument } from '../../src/core/integrate/integrator.js';
import {
  regenerateIndexes,
  listDomainDocFiles,
} from '../../src/generators/regenerate.js';
import { runMaintenance } from '../../src/core/maintain/orchestrator.js';
import { auditDocumentation } from '../../src/core/audit/auditor.js';
import { resetRegistry } from '../../src/core/domains/registry.js';
import { checkLinks } from '../../src/core/links/checker.js';

/** A minimal, valid document body. */
function doc(title: string | null): string {
  const fm = title
    ? `---\ntitle: ${title}\ntier: guide\nstatus: active\nlast_updated: '2026-07-13'\n---\n`
    : `---\ntier: guide\nstatus: active\nlast_updated: '2026-07-13'\n---\n`;
  return `${fm}\n# Body\n\nSome content.\n`;
}

/** Write a file, creating parent directories as needed. */
async function writeDoc(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf-8');
}

describe('Index regeneration (2.5.0 — issue #7)', () => {
  let tmpProject: string;
  let docsPath: string;

  beforeEach(async () => {
    tmpProject = await mkdtemp(join(tmpdir(), 'hewtd-index-'));
    docsPath = join(tmpProject, '.documentation');
    await createScaffold({ rootPath: docsPath, overwrite: false, silent: true });
  });

  afterEach(async () => {
    await rm(tmpProject, { recursive: true, force: true });
  });

  it('registers the FIRST document integrated into a domain', async () => {
    // A freshly scaffolded domain INDEX.md has no table — the exact case the
    // old regex-append path silently no-op'd on.
    const srcPath = join(tmpProject, 'auth-setup.md');
    await writeFile(
      srcPath,
      `---
title: Authentication Setup Guide
---

# Authentication Setup Guide

How to configure authentication, authorization, OAuth, JWT tokens,
login security, and access control for the service.
`,
      'utf-8'
    );

    const result = await integrateDocument({
      filePath: srcPath,
      docsPath,
      auto: true,
      force: true,
      silent: true,
    });

    expect(result.success).toBe(true);
    expect(result.integrated).toBe(true);
    expect(result.domain).toBeDefined();

    // The resolved domain's INDEX.md must now list the integrated document.
    const indexPath = join(docsPath, result.domain!, 'INDEX.md');
    const indexContent = await readFile(indexPath, 'utf-8');
    expect(indexContent).toContain('auth-setup.md');
    expect(indexContent).toContain('Authentication Setup Guide');
    expect(indexContent).toContain('| Document |');
    expect(indexContent).not.toContain('*No documents in this domain yet.*');
  });

  describe('target domain (#39)', () => {
    // Keyword detection alone would send this to `security`.
    const securityProse = `# Login outage

Authentication, authorization, OAuth, JWT tokens, login security and access control.
`;
    const integrate = async (frontmatter: string, domain?: string) => {
      const srcPath = join(tmpProject, 'login-outage.md');
      await writeFile(srcPath, `---\ntitle: Login outage\n${frontmatter}---\n\n${securityProse}`, 'utf-8');
      return integrateDocument({ filePath: srcPath, docsPath, force: true, silent: true, dryRun: true, domain });
    };

    it('uses the first declared domain over keyword detection', async () => {
      const result = await integrate('domains: [troubleshooting]\ntier: reference\n');
      expect(result.domain).toBe('troubleshooting');
      expect(result.targetPath).toBe(join(docsPath, 'troubleshooting', 'login-outage.md'));
    });

    it('lets --domain override both, and puts it first in domains:', async () => {
      const result = await integrate('domains: [troubleshooting]\n', 'procedures');
      expect(result.targetPath).toBe(join(docsPath, 'procedures', 'login-outage.md'));
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
      join(docsPath, 'security', 'one.md'),
      `---\ntitle: Doc One\ntier: guide\nstatus: active\nlast_updated: '2026-05-16'\n---\n# One\n`,
      'utf-8'
    );
    await writeFile(
      join(docsPath, 'security', 'two.md'),
      `---\ntitle: Doc Two\ntier: reference\nstatus: active\nlast_updated: '2026-05-16'\n---\n# Two\n`,
      'utf-8'
    );

    const result = await regenerateIndexes({ docsPath, silent: true });

    expect(result.documentCounts.security).toBe(2);
    expect(result.totalDocuments).toBe(2);
    // 15 domains × INDEX+REGISTRY + root INDEX+REGISTRY.
    expect(result.filesWritten).toHaveLength(15 * 2 + 2);

    const domainIndex = await readFile(join(docsPath, 'security', 'INDEX.md'), 'utf-8');
    expect(domainIndex).toContain('Doc One');
    expect(domainIndex).toContain('Doc Two');
    expect(domainIndex).toContain('**Total Documents:** 2');

    const rootIndex = await readFile(join(docsPath, 'INDEX.md'), 'utf-8');
    expect(rootIndex).toMatch(/\[Security\]\(#security\) \| 2 /);
  });

  it('maintain self-heals stale domain indexes', async () => {
    await writeFile(
      join(docsPath, 'database', 'schema-notes.md'),
      `---\ntitle: Schema Notes\ntier: reference\nstatus: active\nlast_updated: '2026-05-16'\n---\n# Schema\n`,
      'utf-8'
    );

    // Scaffolded INDEX.md does not list the new doc yet.
    const before = await readFile(join(docsPath, 'database', 'INDEX.md'), 'utf-8');
    expect(before).not.toContain('schema-notes.md');

    await runMaintenance({ docsPath, quick: true, silent: true });

    const after = await readFile(join(docsPath, 'database', 'INDEX.md'), 'utf-8');
    expect(after).toContain('schema-notes.md');
    expect(after).toContain('Schema Notes');
  });

  it('audit flags INDEX.md drift and the flag clears after regeneration', async () => {
    await writeFile(
      join(docsPath, 'testing', 'e2e-strategy.md'),
      `---\ntitle: E2E Strategy\ntier: guide\nstatus: active\nlast_updated: '2026-05-16'\n---\n# E2E\n`,
      'utf-8'
    );

    const drifted = await auditDocumentation({ docsPath, silent: true });
    const driftIssue = drifted.issues.find(
      (i) => i.rule === 'index-drift' && i.file === 'testing/INDEX.md'
    );
    expect(driftIssue).toBeDefined();
    expect(driftIssue?.severity).toBe('error');
    expect(driftIssue?.fixable).toBe(true);

    await regenerateIndexes({ docsPath, silent: true });

    const clean = await auditDocumentation({ docsPath, silent: true });
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
  let tmpProject: string;
  let docsPath: string;

  beforeEach(async () => {
    tmpProject = await mkdtemp(join(tmpdir(), 'hewtd-nested-'));
    docsPath = join(tmpProject, '.documentation');
    await createScaffold({ rootPath: docsPath, overwrite: false, silent: true });
  });

  afterEach(async () => {
    await rm(tmpProject, { recursive: true, force: true });
  });

  it('indexes documents in subfolders', async () => {
    await writeDoc(
      join(docsPath, 'standards', 'backend', 'entity-schema-contract.md'),
      doc('Entity Schema Contract')
    );

    const result = await regenerateIndexes({ docsPath, silent: true });
    expect(result.documentCounts.standards).toBe(1);

    // Domain INDEX links it domain-relative...
    const domainIndex = await readFile(join(docsPath, 'standards', 'INDEX.md'), 'utf-8');
    expect(domainIndex).toContain('(backend/entity-schema-contract.md)');
    expect(domainIndex).toContain('Entity Schema Contract');

    // ...and the root INDEX links it root-relative.
    const rootIndex = await readFile(join(docsPath, 'INDEX.md'), 'utf-8');
    expect(rootIndex).toContain('(standards/backend/entity-schema-contract.md)');
  });

  it('regenerates without destroying nested entries', async () => {
    // THE test. Pre-fix, a nested doc was invisible to the scan, so the second
    // regeneration silently dropped it from the indexes — which is how a user
    // running `maintain` in good faith committed the deletion of eight curated
    // root-index rows.
    await writeDoc(
      join(docsPath, 'features', 'portfolio', 'property-form.md'),
      doc('Property Form')
    );

    await regenerateIndexes({ docsPath, silent: true });
    const afterFirst = await readFile(join(docsPath, 'INDEX.md'), 'utf-8');
    expect(afterFirst).toContain('(features/portfolio/property-form.md)');

    await regenerateIndexes({ docsPath, silent: true });
    const afterSecond = await readFile(join(docsPath, 'INDEX.md'), 'utf-8');
    expect(afterSecond).toContain('(features/portfolio/property-form.md)');

    // Idempotent: a second pass must not churn the file at all.
    expect(afterSecond).toBe(afterFirst);
  });

  it('excludes archive/, drafts/ and other reserved subfolders', async () => {
    await writeDoc(join(docsPath, 'features', 'live.md'), doc('Live Doc'));
    await writeDoc(join(docsPath, 'features', 'archive', 'old.md'), doc('Retired Doc'));
    await writeDoc(join(docsPath, 'features', 'drafts', 'wip.md'), doc('Draft Doc'));
    await writeDoc(
      join(docsPath, 'features', 'reports', 'q3.md'),
      doc('Generated Report')
    );
    await writeDoc(
      join(docsPath, 'features', '_templates', 'skeleton.md'),
      doc('Template')
    );
    // A doc tree vendored inside a doc tree.
    await writeDoc(
      join(docsPath, 'features', 'vendored', '.documentation', 'their-doc.md'),
      doc('Somebody Else Doc')
    );

    const result = await regenerateIndexes({ docsPath, silent: true });
    expect(result.documentCounts.features).toBe(1);

    const domainIndex = await readFile(join(docsPath, 'features', 'INDEX.md'), 'utf-8');
    const rootIndex = await readFile(join(docsPath, 'INDEX.md'), 'utf-8');
    for (const excluded of [
      'Retired Doc',
      'Draft Doc',
      'Generated Report',
      'Template',
      'Somebody Else Doc',
    ]) {
      expect(domainIndex).not.toContain(excluded);
      expect(rootIndex).not.toContain(excluded);
    }
    expect(domainIndex).toContain('Live Doc');
  });

  it('does not treat a nested INDEX.md / REGISTRY.md as a document', async () => {
    await writeDoc(join(docsPath, 'standards', 'backend', 'real-doc.md'), doc('Real Doc'));
    await writeDoc(join(docsPath, 'standards', 'backend', 'INDEX.md'), doc('Nested Index'));
    await writeDoc(
      join(docsPath, 'standards', 'backend', 'REGISTRY.md'),
      doc('Nested Registry')
    );

    const files = await listDomainDocFiles(docsPath, 'standards');
    expect(files).toEqual(['backend/real-doc.md']);

    const result = await regenerateIndexes({ docsPath, silent: true });
    expect(result.documentCounts.standards).toBe(1);
  });

  it('falls back to the basename for a nested doc with no frontmatter title', async () => {
    await writeDoc(join(docsPath, 'standards', 'backend', 'foo-bar.md'), doc(null));

    await regenerateIndexes({ docsPath, silent: true });

    const domainIndex = await readFile(join(docsPath, 'standards', 'INDEX.md'), 'utf-8');
    // "Foo Bar" — not "Backend/foo Bar".
    expect(domainIndex).toContain('[Foo Bar](backend/foo-bar.md)');
    expect(domainIndex).not.toContain('Backend/foo');
  });

  it('survives a nested doc with malformed frontmatter, and still indexes it', async () => {
    // Found by driving a real tree, not a fixture: gray-matter THROWS on bad
    // YAML, and pre-fix these files were never read. Once the walk goes deep,
    // one broken frontmatter block would abort the run for the whole project.
    await writeDoc(join(docsPath, 'features', 'ok', 'good.md'), doc('Good Doc'));
    await writeDoc(
      join(docsPath, 'features', 'ux-assist', 'broken.md'),
      `---\ntitle: Broken\nstatus: SUPERSEDED (lean: shared <Strip> + per-page: thing)\n---\n\n# Broken\n`
    );

    const result = await regenerateIndexes({ docsPath, silent: true });

    // Both docs indexed — the malformed one is NOT silently dropped, which
    // would recreate the very bug being fixed (a doc invisible to the index).
    expect(result.documentCounts.features).toBe(2);

    const domainIndex = await readFile(join(docsPath, 'features', 'INDEX.md'), 'utf-8');
    expect(domainIndex).toContain('(ok/good.md)');
    expect(domainIndex).toContain('(ux-assist/broken.md)');
    // It falls back to the filename-derived title, since its frontmatter is unreadable.
    expect(domainIndex).toContain('[Broken](ux-assist/broken.md)');
  });

  it('dryRun computes the full result but writes nothing', async () => {
    await writeDoc(join(docsPath, 'standards', 'backend', 'fastapi.md'), doc('FastAPI'));
    const before = await readFile(join(docsPath, 'standards', 'INDEX.md'), 'utf-8');

    const result = await regenerateIndexes({ docsPath, silent: true, dryRun: true });

    // Reports everything it WOULD do...
    expect(result.documentCounts.standards).toBe(1);
    expect(result.filesWritten.length).toBe(15 * 2 + 2);

    // ...and touches nothing.
    const after = await readFile(join(docsPath, 'standards', 'INDEX.md'), 'utf-8');
    expect(after).toBe(before);
    expect(after).not.toContain('FastAPI');
  });

  it('detects index drift on a nested document', async () => {
    // Pre-fix this was undetectable BY CONSTRUCTION: the drift rule compared
    // INDEX.md against a doc list that shared the same blind spot.
    await writeDoc(
      join(docsPath, 'testing', 'e2e', 'playwright-strategy.md'),
      doc('Playwright Strategy')
    );

    const drifted = await auditDocumentation({ docsPath, silent: true });
    const driftIssue = drifted.issues.find(
      (i) => i.rule === 'index-drift' && i.file === 'testing/INDEX.md'
    );
    expect(driftIssue).toBeDefined();

    await regenerateIndexes({ docsPath, silent: true });

    const clean = await auditDocumentation({ docsPath, silent: true });
    expect(clean.issues.some((i) => i.rule === 'index-drift')).toBe(false);
  });

  describe('vault exclusion (knowledge-base registered as a domain)', () => {
    const originalCwd = process.cwd();

    beforeEach(async () => {
      // The scenario that surfaced this: the vault root is ALSO a configured
      // domain, so a recursive walk would sweep every fact and incident
      // narrative into a generic domain INDEX — indexed a second time, and
      // rendered as if they were plain guides.
      await mkdir(join(tmpProject, '.claude'), { recursive: true });
      await writeFile(
        join(tmpProject, '.claude', 'hit-em-with-the-docs.json'),
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
      process.chdir(tmpProject);
      resetRegistry();
    });

    afterEach(() => {
      process.chdir(originalCwd);
      resetRegistry();
    });

    it('withholds the vault subtrees but still indexes its top-level docs', async () => {
      const vault = join(docsPath, 'knowledge-base');
      await writeDoc(join(vault, 'README.md'), doc('Knowledge Base README'));
      await writeDoc(join(vault, 'facts', 'alloy-env-only.md'), doc('Alloy Env Fact'));
      await writeDoc(
        join(vault, 'incidents', '2026-05-14-vault-alloy-stuck', 'narrative.md'),
        doc('Alloy Incident')
      );
      await writeDoc(
        join(vault, 'symptoms', 'grafana-alerts.md'),
        doc('Grafana Symptoms')
      );

      const files = await listDomainDocFiles(docsPath, 'knowledge-base');
      // The README is a normal doc and stays indexed, exactly as it was before
      // the walk went recursive. Everything the vault's own generators own is
      // withheld.
      expect(files).toEqual(['README.md']);

      const result = await regenerateIndexes({ docsPath, silent: true });
      expect(result.documentCounts['knowledge-base']).toBe(1);

      const domainIndex = await readFile(join(vault, 'INDEX.md'), 'utf-8');
      const rootIndex = await readFile(join(docsPath, 'INDEX.md'), 'utf-8');
      for (const content of [domainIndex, rootIndex]) {
        expect(content).not.toContain('Alloy Env Fact');
        expect(content).not.toContain('Alloy Incident');
        expect(content).not.toContain('Grafana Symptoms');
      }
      expect(domainIndex).toContain('Knowledge Base README');
    });
  });
});

describe('Generated indexes link only to domains that exist (#45)', () => {
  let tmpProject: string;
  let docsPath: string;
  const originalCwd = process.cwd();

  beforeEach(async () => {
    tmpProject = await mkdtemp(join(tmpdir(), 'hewtd-dead-links-'));
    docsPath = join(tmpProject, '.documentation');
    // One custom domain, so custom folders count as present too.
    await writeDoc(
      join(tmpProject, '.claude', 'hit-em-with-the-docs.json'),
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
    process.chdir(tmpProject);
    resetRegistry();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    resetRegistry();
    await rm(tmpProject, { recursive: true, force: true });
  });

  it('a tree with only some domains has no broken links after regeneration', async () => {
    for (const d of ['reference', 'troubleshooting', 'compliance']) {
      await writeDoc(join(docsPath, d, 'a.md'), doc(`${d} doc`));
    }
    await regenerateIndexes({ docsPath, silent: true });

    const result = await checkLinks({ docsPath, silent: true });
    expect(result.brokenLinks).toEqual([]);

    const registry = await readFile(join(docsPath, 'REGISTRY.md'), 'utf-8');
    expect(registry).toContain('[troubleshooting/](troubleshooting/)');
    expect(registry).toContain('(compliance/)');
    expect(registry).not.toMatch(/\]\((standards|api|devops)\//);
    // Related domains still render, limited to existing folders.
    const index = await readFile(join(docsPath, 'compliance', 'INDEX.md'), 'utf-8');
    expect(index).toContain('## Related Domains');
  });

  it('a partial scaffold links only the scaffolded domains', async () => {
    await createScaffold({
      rootPath: docsPath,
      domains: ['reference', 'troubleshooting'],
      overwrite: false,
      silent: true,
    });
    const result = await checkLinks({ docsPath, silent: true });
    expect(result.brokenLinks).toEqual([]);
  });
});
