import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { type Domain } from '../core/domains/constants.js';
import { getAllDomains, getDomainDefinition } from '../core/domains/registry.js';
import { getStatusValues } from '../core/metadata/status-registry.js';
import { generateRootIndex } from './index-generator.js';
import { generateRootRegistry } from './registry-generator.js';
import { generateDomainIndex } from './templates/domain-index.js';
import { generateDomainRegistry } from './templates/domain-registry.js';
import { logger } from '../utils/logger.js';
import { pathExists, ARCHIVE_DIR } from '../utils/glob.js';

export interface ScaffoldOptions {
  rootPath: string;
  overwrite?: boolean;
  domains?: Domain[];
  silent?: boolean;
}

export interface ScaffoldResult {
  success: boolean;
  created: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Create the complete documentation scaffold
 */
export async function createScaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const {
    rootPath,
    overwrite = false,
    domains = getAllDomains(),
    silent = false,
  } = options;

  const result: ScaffoldResult = {
    success: true,
    created: [],
    skipped: [],
    errors: [],
  };

  if (!silent) {
    logger.header('Creating Documentation Scaffold');
    logger.info(`Root path: ${rootPath}`);
    logger.info(`Domains: ${domains.length}`);
  }

  try {
    // Create root directory
    await createDirectory(rootPath, result, overwrite);

    // Create root files
    await createRootFiles(rootPath, domains, result, overwrite);

    // Create domain directories and files
    for (const domain of domains) {
      await createDomainStructure(rootPath, domain, result, overwrite);
    }

    // Create special directories
    await createSpecialDirectories(rootPath, result, overwrite);

    if (!silent) {
      logger.newline();
      logger.success(`Scaffold created successfully!`);
      logger.info(`Created: ${result.created.length} files/directories`);
      if (result.skipped.length > 0) {
        logger.warn(`Skipped: ${result.skipped.length} (already exist)`);
      }
    }
  } catch (error) {
    result.success = false;
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(message);
    if (!silent) {
      logger.error(`Failed to create scaffold: ${message}`);
    }
  }

  return result;
}

/**
 * Create a directory if it doesn't exist
 */
async function createDirectory(
  path: string,
  result: ScaffoldResult,
  overwrite: boolean
): Promise<void> {
  const exists = await pathExists(path);

  if (exists && !overwrite) {
    result.skipped.push(path);
    return;
  }

  await mkdir(path, { recursive: true });
  result.created.push(path);
}

/**
 * Create a file if it doesn't exist
 */
async function createFile(
  path: string,
  content: string,
  result: ScaffoldResult,
  overwrite: boolean
): Promise<void> {
  const exists = await pathExists(path);

  if (exists && !overwrite) {
    result.skipped.push(path);
    return;
  }

  await writeFile(path, content, 'utf-8');
  result.created.push(path);
}

/**
 * Create root-level files
 */
async function createRootFiles(
  rootPath: string,
  domains: Domain[],
  result: ScaffoldResult,
  overwrite: boolean
): Promise<void> {
  // INDEX.md
  const indexContent = generateRootIndex();
  await createFile(join(rootPath, 'INDEX.md'), indexContent, result, overwrite);

  // REGISTRY.md
  const registryContent = generateRootRegistry(domains);
  await createFile(join(rootPath, 'REGISTRY.md'), registryContent, result, overwrite);

  // README.md
  const readmeContent = generateRootReadme(domains);
  await createFile(join(rootPath, 'README.md'), readmeContent, result, overwrite);
}

/**
 * Create domain directory structure
 */
async function createDomainStructure(
  rootPath: string,
  domain: Domain,
  result: ScaffoldResult,
  overwrite: boolean
): Promise<void> {
  const domainPath = join(rootPath, domain);
  const def = getDomainDefinition(domain);

  // Create domain directory
  await createDirectory(domainPath, result, overwrite);

  // Create INDEX.md
  const indexContent = generateDomainIndex(domain, def);
  await createFile(join(domainPath, 'INDEX.md'), indexContent, result, overwrite);

  // Create REGISTRY.md
  const registryContent = generateDomainRegistry(domain, def);
  await createFile(join(domainPath, 'REGISTRY.md'), registryContent, result, overwrite);
}

/**
 * Create special directories (drafts, reports, archive)
 */
async function createSpecialDirectories(
  rootPath: string,
  result: ScaffoldResult,
  overwrite: boolean
): Promise<void> {
  // Drafts directory
  await createDirectory(join(rootPath, 'drafts'), result, overwrite);

  // Reports directory
  await createDirectory(join(rootPath, 'reports'), result, overwrite);

  // Archive directory — deprecated docs live here and are NOT scanned.
  await createDirectory(join(rootPath, ARCHIVE_DIR), result, overwrite);

  // Create .gitkeep files to preserve empty directories
  await createFile(
    join(rootPath, 'drafts', '.gitkeep'),
    '# This file ensures the drafts directory is tracked by git\n',
    result,
    overwrite
  );

  await createFile(
    join(rootPath, 'reports', '.gitkeep'),
    '# This file ensures the reports directory is tracked by git\n',
    result,
    overwrite
  );

  // Archive README documents the convention (and keeps the dir tracked).
  await createFile(
    join(rootPath, ARCHIVE_DIR, 'README.md'),
    generateArchiveReadme(),
    result,
    overwrite
  );
}

/**
 * Generate the archive/ README — the user-facing instruction for the
 * deprecated-docs convention.
 */
function generateArchiveReadme(): string {
  return `# Archive

This folder holds **deprecated documentation** — docs that are retired but
worth keeping (historical reference, superseded guides, old runbooks).

## Don't move files here by hand — use the command

\`\`\`bash
hewtd archive <file> --reason "why"     # e.g. hewtd archive api/old-webhooks.md
\`\`\`

\`hewtd archive\` does it properly: it moves the doc into
\`archive/<same-domain-path>/\`, preserves git history (\`git mv\`), stamps
lifecycle metadata (\`status: archived\`, \`archived_on\`, \`archived_from\`), and
regenerates the indexes so the doc cleanly leaves the active set. It also
**refuses if other active docs still link to the doc** (so you don't create
dead links) — pass \`--force\` to override after you've reviewed them.

## Reversible

\`\`\`bash
hewtd unarchive <file>                  # restores to its original path, status: active
\`\`\`

The \`archived_from\` field records the exact restore path, so un-archiving is
lossless.

## Finding what to archive

\`\`\`bash
hewtd archive-candidates                # advisory list — never moves anything
\`\`\`

Suggests docs worth retiring, ranked by signal: \`status: deprecated\` (strongest),
\`superseded_by:\`, orphaned (no inbound links), and age (only when also orphaned).
Age alone never qualifies a doc — an unchanged doc is often your most important one.

## hewtd ignores this folder

Everything under \`archive/\` is **excluded from every hewtd scan** — \`audit\`,
\`link-check\`, \`metadata-sync\`, \`integrate\` duplicate-detection, the link
graph, and \`search\`. Archived docs are not validated, never appear in any
INDEX.md / REGISTRY.md, and can't break audit/link-check with stale frontmatter.

> Note: \`archive/\` is a reserved name. You cannot create a custom domain
> called \`archive\`.
`;
}

/**
 * Generate root README content
 */
function generateRootReadme(domains: Domain[]): string {
  return `# Documentation

This documentation system uses a hierarchical, domain-based structure for optimal organization and discoverability.

## Quick Navigation

- **[INDEX.md](INDEX.md)** - Complete document listing with metadata
- **[REGISTRY.md](REGISTRY.md)** - Quick reference tables

## Domains

| Domain | Description |
|--------|-------------|
${domains.map((d) => `| [${d}](${d}/) | ${getDomainDefinition(d).description} |`).join('\n')}

## Adding New Documentation

1. Identify the correct domain for your document
2. Create the file in the domain directory
3. Add YAML frontmatter with required metadata
4. Run \`npx hit-em-with-the-docs integrate <file>\` to register

## Metadata Schema

Every document should include:

\`\`\`yaml
---
title: "Document Title"
tier: guide|standard|example|reference|admin
domains: [primary-domain]
status: ${getStatusValues().join('|')}
last_updated: 'YYYY-MM-DD'
version: '1.0.0'
---
\`\`\`

## Maintenance

Run weekly maintenance with:

\`\`\`bash
npx hit-em-with-the-docs maintain
\`\`\`

This will:
- Sync metadata across all documents
- Check for broken links
- Audit compliance
- Generate health reports
`;
}

/**
 * Check if scaffold already exists
 */
export async function scaffoldExists(rootPath: string): Promise<boolean> {
  const indexPath = join(rootPath, 'INDEX.md');
  return pathExists(indexPath);
}

/**
 * Get scaffold status
 */
export async function getScaffoldStatus(rootPath: string): Promise<{
  exists: boolean;
  domains: Domain[];
  missingDomains: Domain[];
}> {
  const exists = await scaffoldExists(rootPath);

  if (!exists) {
    return {
      exists: false,
      domains: [],
      missingDomains: getAllDomains(),
    };
  }

  const presentDomains: Domain[] = [];
  const missingDomains: Domain[] = [];

  for (const domain of getAllDomains()) {
    const domainPath = join(rootPath, domain);
    if (await pathExists(domainPath)) {
      presentDomains.push(domain);
    } else {
      missingDomains.push(domain);
    }
  }

  return {
    exists: true,
    domains: presentDomains,
    missingDomains,
  };
}
