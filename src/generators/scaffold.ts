import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { type Domain } from '../core/domains/constants.js';
import { get_all_domains, get_domain_definition } from '../core/domains/registry.js';
import { get_status_values } from '../core/metadata/status-registry.js';
import { generate_root_index } from './index-generator.js';
import { generate_root_registry } from './registry-generator.js';
import { generate_domain_index } from './templates/domain-index.js';
import { generate_domain_registry } from './templates/domain-registry.js';
import { logger } from '../utils/logger.js';
import { path_exists, ARCHIVE_DIR } from '../utils/glob.js';

export interface ScaffoldOptions {
  root_path: string;
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
export async function create_scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const {
    root_path,
    overwrite = false,
    domains = get_all_domains(),
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
    logger.info(`Root path: ${root_path}`);
    logger.info(`Domains: ${domains.length}`);
  }

  try {
    // Create root directory
    await create_directory(root_path, result, overwrite);

    // Create root files
    await create_root_files(root_path, domains, result, overwrite);

    // Create domain directories and files
    for (const domain of domains) {
      await create_domain_structure(root_path, domain, result, overwrite);
    }

    // Create special directories
    await create_special_directories(root_path, result, overwrite);

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
async function create_directory(
  path: string,
  result: ScaffoldResult,
  overwrite: boolean
): Promise<void> {
  const exists = await path_exists(path);

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
async function create_file(
  path: string,
  content: string,
  result: ScaffoldResult,
  overwrite: boolean
): Promise<void> {
  const exists = await path_exists(path);

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
async function create_root_files(
  root_path: string,
  domains: Domain[],
  result: ScaffoldResult,
  overwrite: boolean
): Promise<void> {
  // INDEX.md
  const index_content = generate_root_index();
  await create_file(join(root_path, 'INDEX.md'), index_content, result, overwrite);

  // REGISTRY.md
  const registry_content = generate_root_registry(domains);
  await create_file(join(root_path, 'REGISTRY.md'), registry_content, result, overwrite);

  // README.md
  const readme_content = generate_root_readme(domains);
  await create_file(join(root_path, 'README.md'), readme_content, result, overwrite);
}

/**
 * Create domain directory structure
 */
async function create_domain_structure(
  root_path: string,
  domain: Domain,
  result: ScaffoldResult,
  overwrite: boolean
): Promise<void> {
  const domain_path = join(root_path, domain);
  const def = get_domain_definition(domain);

  // Create domain directory
  await create_directory(domain_path, result, overwrite);

  // Create INDEX.md
  const index_content = generate_domain_index(domain, def);
  await create_file(join(domain_path, 'INDEX.md'), index_content, result, overwrite);

  // Create REGISTRY.md
  const registry_content = generate_domain_registry(domain, def);
  await create_file(join(domain_path, 'REGISTRY.md'), registry_content, result, overwrite);
}

/**
 * Create special directories (drafts, reports, archive)
 */
async function create_special_directories(
  root_path: string,
  result: ScaffoldResult,
  overwrite: boolean
): Promise<void> {
  // Drafts directory
  await create_directory(join(root_path, 'drafts'), result, overwrite);

  // Reports directory
  await create_directory(join(root_path, 'reports'), result, overwrite);

  // Archive directory — deprecated docs live here and are NOT scanned.
  await create_directory(join(root_path, ARCHIVE_DIR), result, overwrite);

  // Create .gitkeep files to preserve empty directories
  await create_file(
    join(root_path, 'drafts', '.gitkeep'),
    '# This file ensures the drafts directory is tracked by git\n',
    result,
    overwrite
  );

  await create_file(
    join(root_path, 'reports', '.gitkeep'),
    '# This file ensures the reports directory is tracked by git\n',
    result,
    overwrite
  );

  // Archive README documents the convention (and keeps the dir tracked).
  await create_file(
    join(root_path, ARCHIVE_DIR, 'README.md'),
    generate_archive_readme(),
    result,
    overwrite
  );
}

/**
 * Generate the archive/ README — the user-facing instruction for the
 * deprecated-docs convention.
 */
function generate_archive_readme(): string {
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
function generate_root_readme(domains: Domain[]): string {
  return `# Documentation

This documentation system uses a hierarchical, domain-based structure for optimal organization and discoverability.

## Quick Navigation

- **[INDEX.md](INDEX.md)** - Complete document listing with metadata
- **[REGISTRY.md](REGISTRY.md)** - Quick reference tables

## Domains

| Domain | Description |
|--------|-------------|
${domains.map((d) => `| [${d}](${d}/) | ${get_domain_definition(d).description} |`).join('\n')}

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
status: ${get_status_values().join('|')}
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
export async function scaffold_exists(root_path: string): Promise<boolean> {
  const index_path = join(root_path, 'INDEX.md');
  return path_exists(index_path);
}

/**
 * Get scaffold status
 */
export async function get_scaffold_status(root_path: string): Promise<{
  exists: boolean;
  domains: Domain[];
  missing_domains: Domain[];
}> {
  const exists = await scaffold_exists(root_path);

  if (!exists) {
    return {
      exists: false,
      domains: [],
      missing_domains: get_all_domains(),
    };
  }

  const present_domains: Domain[] = [];
  const missing_domains: Domain[] = [];

  for (const domain of get_all_domains()) {
    const domain_path = join(root_path, domain);
    if (await path_exists(domain_path)) {
      present_domains.push(domain);
    } else {
      missing_domains.push(domain);
    }
  }

  return {
    exists: true,
    domains: present_domains,
    missing_domains,
  };
}
