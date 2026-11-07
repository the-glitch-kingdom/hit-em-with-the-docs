#!/usr/bin/env node

import { Command } from 'commander';
import { dirname, join, relative, resolve } from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createRequire } from 'node:module';
import { registerUpdateCommands } from '@theglitchking/claude-plugin-runtime';
import { logger } from '../utils/logger.js';

const require_ = createRequire(import.meta.url);
const pkg = require_('../../package.json') as { version: string };
import { createScaffold, scaffoldExists } from '../generators/scaffold.js';
import { syncMetadata } from '../core/metadata/sync.js';
import { checkLinks } from '../core/links/checker.js';
import { auditDocumentation } from '../core/audit/auditor.js';
import { integrateDocument } from '../core/integrate/integrator.js';
import { runMaintenance } from '../core/maintain/orchestrator.js';
import { discoverPatterns } from '../core/discover/patterns.js';
import { discoverAntiPatterns } from '../core/discover/antipatterns.js';
import { discoverStandards } from '../core/discover/standards.js';
import { analyzeDependencies } from '../core/discover/dependencies.js';
import { saveHealthReport } from '../reports/health-report.js';
import { saveAuditReport } from '../reports/audit-report.js';
import { saveLinkReport } from '../reports/link-report.js';
import { type Domain } from '../core/domains/constants.js';
import {
  getAllDomains,
  getRegistry,
  getDomainDefinition,
  isValidDomain,
} from '../core/domains/registry.js';
import { regenerateIndexes, generateKbIndexes } from '../generators/regenerate.js';
import { stampReports } from '../generators/stamp-reports.js';
import { writeRawConfig } from '../utils/config.js';
import { getStatusValues } from '../core/metadata/status-registry.js';
import { resolveDocsPath } from '../utils/docs-root.js';

const program = new Command();

program
  .name('hit-em-with-the-docs')
  .description('Self-managing documentation system with hierarchical structure and intelligent automation')
  .version(pkg.version);

// Project root of the resolved docs path: the git root holding it, else its parent.
let projectRootDir = process.cwd();
function findProjectRoot(docsPath: string): string {
  let dir = dirname(docsPath);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(docsPath);
    dir = parent;
  }
}

// Every command except `init` finds the docs tree from a subdirectory when -p is the default,
// and loads the project's config (domains, statuses) from that project, not from the cwd.
program.hook('preAction', (_this, action) => {
  if (action.name() === 'init') return;
  let docsPath: string | undefined;
  for (const key of ['path', 'docsPath']) {
    if (action.getOptionValueSource(key) === undefined) continue;
    if (action.getOptionValueSource(key) === 'default') {
      action.setOptionValue(key, resolveDocsPath(process.cwd(), String(action.getOptionValue(key)), false));
    }
    docsPath = resolve(process.cwd(), String(action.getOptionValue(key)));
  }
  docsPath ??= resolveDocsPath(process.cwd(), '.documentation', false);
  projectRootDir = findProjectRoot(docsPath);
  getRegistry(projectRootDir);
  getStatusValues(projectRootDir);
});

registerUpdateCommands(program, {
  packageName: '@theglitchking/hit-em-with-the-docs',
  pluginName: 'hit-em-with-the-docs',
  configFile: 'hit-em-with-the-docs.json',
});

// Init command
program
  .command('init')
  .description('Initialize documentation structure')
  .option('-p, --path <path>', 'Path to create documentation', '.documentation')
  .option('-f, --force', 'Overwrite existing files', false)
  .action(async (options) => {
    const docsPath = resolve(process.cwd(), options.path);

    const existed = await scaffoldExists(docsPath);
    if (existed && !options.force) {
      logger.warn('Documentation structure already exists. Use --force to overwrite.');
      process.exit(1);
    }

    const result = await createScaffold({
      rootPath: docsPath,
      overwrite: options.force,
    });

    if (!result.success) {
      logger.error('Failed to initialize documentation');
      process.exit(1);
    }

    // New installs only: keep reports out of the searched docs tree. A re-init (--force) keeps
    // where reports already go, and an unreadable config is never overwritten.
    if (!existed) {
      const projectRoot = dirname(docsPath);
      let raw: Record<string, unknown> | null = {};
      try {
        raw = JSON.parse(await readFile(join(projectRoot, '.claude/hit-em-with-the-docs.json'), 'utf-8'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') raw = null;
      }
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        logger.warn('Could not parse .claude/hit-em-with-the-docs.json; left it alone (reports_dir not set).');
      } else if (raw.reports_dir === undefined) {
        await writeRawConfig(projectRoot, { ...raw, reports_dir: '.hewtd/reports' });
      }
    }
  });

// Maintain command
program
  .command('maintain')
  .description('Run full documentation maintenance')
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .option('-q, --quick', 'Quick mode (skip link checking)', false)
  .option('-f, --fix', 'Auto-fix issues', false)
  .action(async (options) => {
    const docsPath = resolve(process.cwd(), options.path);

    const result = await runMaintenance({
      docsPath,
      quick: options.quick,
      fix: options.fix,
    });

    process.exit(result.success ? 0 : 1);
  });

// Index command
program
  .command('index')
  .alias('reindex')
  .description('Regenerate all domain + root INDEX.md / REGISTRY.md from documents on disk')
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .option(
    '-d, --domain <domain>',
    'Restrict domain INDEX/REGISTRY writes to one domain (root indexes still refreshed)'
  )
  .option('--dry-run', 'Preview what would change without writing anything', false)
  .action(async (options) => {
    const docsPath = resolve(process.cwd(), options.path);

    let domains: Domain[] | undefined;
    if (options.domain) {
      if (!isValidDomain(options.domain)) {
        logger.error(`Unknown domain: ${options.domain}`);
        logger.info(`Valid domains: ${getAllDomains().join(', ')}`);
        process.exit(1);
      }
      domains = [options.domain];
    }

    logger.header(options.dryRun ? 'Index Regeneration (dry run)' : 'Index Regeneration');

    // Count what each domain's INDEX.md lists TODAY, so a dry run can show the
    // delta rather than just the new totals. The 2.7.1 recursive walk can add
    // hundreds of rows on first run; users deserve to see that before it lands.
    const listedBefore: Record<string, number> = {};
    if (options.dryRun) {
      for (const domain of getAllDomains()) {
        listedBefore[domain] = await countIndexedDocRows(
          join(docsPath, domain, 'INDEX.md')
        );
      }
    }

    const result = await regenerateIndexes({
      docsPath,
      ...(domains ? { domains } : {}),
      silent: true,
      dryRun: options.dryRun,
    });

    let added = 0;
    for (const domain of getAllDomains()) {
      const count = result.documentCounts[domain] ?? 0;
      let suffix = '';
      if (options.dryRun) {
        const delta = count - (listedBefore[domain] ?? 0);
        added += Math.max(0, delta);
        suffix = delta > 0 ? `  (+${delta} not currently listed)` : '';
      }
      logger.info(
        `  ${domain.padEnd(16)} ${count} document${count === 1 ? '' : 's'}${suffix}`
      );
    }
    logger.newline();

    // Upgrade step: KB indexes and pre-2.13 reports also get rebuilt/stamped here.
    const kb = await generateKbIndexes(docsPath, options.dryRun);
    const stamped = await stampReports(docsPath, options.dryRun);
    if (kb) {
      logger.info(
        `Knowledge base: ${kb.facts} facts, ${kb.incidents} incidents${options.dryRun ? ' (would rebuild indexes)' : ' (indexes rebuilt)'}`
      );
    }
    if (stamped.length > 0) {
      logger.info(`${options.dryRun ? 'Would stamp' : 'Stamped'} generated: true on ${stamped.length} report file(s)`);
      if (options.dryRun) for (const f of stamped) logger.info(`  ${f}`);
    }

    if (!options.dryRun) {
      logger.success(
        `${result.filesWritten.length} index files written · ${result.totalDocuments} documents total`
      );
      return;
    }

    logger.success(
      `Would write ${result.filesWritten.length} index files · ${result.totalDocuments} documents total`
    );
    if (added > 0) {
      logger.info(
        `${added} document(s) would be added to the indexes. If you are upgrading ` +
          `to 2.7.1, this is expected and one-time: documents in subfolders were ` +
          `previously invisible to the indexer. See docs/indexing.md.`
      );
    }
    logger.info('Nothing was written. Re-run without --dry-run to apply.');
  });

/** How many document rows a generated INDEX.md currently lists (0 if absent). */
async function countIndexedDocRows(indexPath: string): Promise<number> {
  try {
    const content = await readFile(indexPath, 'utf-8');
    return content
      .split('\n')
      .filter((line) => /^\|\s*\[[^\]]*\]\([^)]+\.md\)/.test(line)).length;
  } catch {
    return 0;
  }
}

// Metadata sync command
program
  .command('metadata-sync')
  .description('Sync metadata across all documentation')
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .option('-d, --domain <domain>', 'Specific domain to sync')
  .option('--dry-run', 'Preview changes without writing', false)
  .option('-f, --fix', 'Auto-fix missing metadata', false)
  .action(async (options) => {
    const docsPath = resolve(process.cwd(), options.path);

    const result = await syncMetadata({
      docsPath,
      domain: options.domain,
      dryRun: options.dryRun,
      fix: options.fix,
    });

    if (result.errors.length > 0) {
      process.exit(1);
    }
  });

// Link check command
program
  .command('link-check')
  .description('Check all internal documentation links')
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .option('-d, --domain <domain>', 'Specific domain to check')
  .option('-r, --report', 'Generate detailed report', false)
  .action(async (options) => {
    const docsPath = resolve(process.cwd(), options.path);

    const result = await checkLinks({
      docsPath,
      domain: options.domain,
    });

    if (options.report) {
      const reportPath = await saveLinkReport(docsPath, result);
      logger.success(`Report saved: ${reportPath}`);
    }

    if (result.brokenLinks.length > 0) {
      process.exit(1);
    }
  });

// Audit command
program
  .command('audit')
  .description('Audit documentation for compliance')
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .option('-d, --domain <domain>', 'Specific domain to audit')
  .option('-i, --issues-only', 'Show only issues', false)
  .option('-r, --report', 'Generate detailed report', false)
  .option(
    '--strict',
    'Exit non-zero on ANY violation (including knowledge-base warnings); suitable for CI',
    false
  )
  .action(async (options) => {
    const docsPath = resolve(process.cwd(), options.path);

    const result = await auditDocumentation({
      docsPath,
      domain: options.domain,
      issuesOnly: options.issuesOnly,
      strict: options.strict,
    });

    if (options.report) {
      const reportPath = await saveAuditReport(docsPath, result);
      logger.success(`Report saved: ${reportPath}`);
    }

    // Strict mode escalates: exit non-zero on any error-severity issue OR any
    // KB-coded issue (including warning-severity ones like
    // FACT_VERIFY_COMMAND_MULTILINE_SHEBANG). Non-KB warnings (naming
    // convention, placement) do NOT fail strict mode — those are stylistic
    // and don't represent knowledge-base integrity violations.
    //
    // Normal mode: exit non-zero only on per-file errors (existing behavior
    // preserved from pre-2.3.0).
    if (options.strict) {
      const hasViolation = result.issues.some(
        (i) => i.severity === 'error' || i.code !== undefined
      );
      if (hasViolation) {
        logger.error('Strict mode: violations detected, exiting non-zero');
        process.exit(1);
      }
    } else if (result.failedFiles > 0) {
      process.exit(1);
    }
  });

// Integrate command
program
  .command('integrate <file>')
  .description('Integrate a document into the documentation system')
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .option('-a, --auto', 'Auto mode (no prompts)', false)
  .option('--dry-run', 'Preview without writing', false)
  .option('-f, --force', 'Force integration even with duplicates', false)
  .option('-d, --domain <domain>', "Target domain (default: the doc's first declared domain, else detected)")
  .action(async (file, options) => {
    const docsPath = resolve(process.cwd(), options.path);
    const filePath = resolve(process.cwd(), file);

    const result = await integrateDocument({
      filePath,
      docsPath,
      auto: options.auto,
      dryRun: options.dryRun,
      force: options.force,
      domain: options.domain,
    });

    if (!result.success) {
      logger.error(result.error ?? 'Integration failed');
      process.exit(1);
    }
  });

// Discover command with subcommands
const discover = program
  .command('discover')
  .description('Discover patterns and standards from codebase');

discover
  .command('patterns')
  .description('Discover coding patterns')
  .option('-r, --root <path>', 'Root path to scan', '.')
  .option('-l, --language <lang>', 'Filter by language')
  .option('-c, --category <cat>', 'Filter by category')
  .action(async (options) => {
    const rootPath = resolve(process.cwd(), options.root);

    await discoverPatterns({
      rootPath,
      language: options.language,
      category: options.category,
    });
  });

discover
  .command('anti-patterns')
  .description('Detect anti-patterns in codebase')
  .option('-r, --root <path>', 'Root path to scan', '.')
  .action(async (options) => {
    const rootPath = resolve(process.cwd(), options.root);

    await discoverAntiPatterns({
      rootPath,
    });
  });

discover
  .command('standards')
  .description('Extract implicit standards from codebase')
  .option('-r, --root <path>', 'Root path to scan', '.')
  .action(async (options) => {
    const rootPath = resolve(process.cwd(), options.root);

    await discoverStandards({
      rootPath,
    });
  });

discover
  .command('dependencies')
  .description('Analyze project dependencies')
  .option('-r, --root <path>', 'Root path to scan', '.')
  .action(async (options) => {
    const rootPath = resolve(process.cwd(), options.root);

    await analyzeDependencies({
      rootPath,
    });
  });

// Report command
program
  .command('report <type>')
  .description('Generate a report (health, audit, links)')
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .option('-f, --format <format>', 'Output format (markdown, json)', 'markdown')
  .action(async (type, options) => {
    const docsPath = resolve(process.cwd(), options.path);

    switch (type) {
      case 'health': {
        const result = await runMaintenance({ docsPath, quick: true, silent: true });
        const reportPath = await saveHealthReport(docsPath, result, options.format);
        logger.success(`Health report saved: ${reportPath}`);
        break;
      }
      case 'audit': {
        const result = await auditDocumentation({ docsPath, silent: true });
        const reportPath = await saveAuditReport(docsPath, result, options.format);
        logger.success(`Audit report saved: ${reportPath}`);
        break;
      }
      case 'links': {
        const result = await checkLinks({ docsPath, silent: true });
        const reportPath = await saveLinkReport(docsPath, result, options.format);
        logger.success(`Link report saved: ${reportPath}`);
        break;
      }
      default:
        logger.error(`Unknown report type: ${type}`);
        logger.info('Available types: health, audit, links');
        process.exit(1);
    }
  });

// List command
program
  .command('list')
  .description('List all documentation domains')
  .action(() => {
    logger.header('Documentation Domains');

    const headers = ['Domain', 'Category', 'Priority', 'Description'];
    const rows = getAllDomains().map((d) => {
      const def = getDomainDefinition(d);
      return [d, def.category, `${def.loadPriority}/10`, def.description];
    });

    logger.table(headers, rows);
  });

// --- Custom domains: add / remove / list ---

const domain = program
  .command('domain')
  .description('Manage custom documentation domains (add | remove | list)');

domain
  .command('list')
  .description('List built-in and custom domains')
  .option('--json', 'Output as JSON', false)
  .action(async (options) => {
    const { listDomains } = await import('../core/domains/manage.js');
    const result = listDomains(projectRootDir);

    if (options.json) {
      logger.info(JSON.stringify(result, null, 2));
      return;
    }

    logger.header('Documentation Domains');
    const headers = ['Domain', 'Kind', 'Category', 'Priority', 'Description'];
    const rows = [
      ...result.builtin.map((d) => [
        d.id,
        'built-in',
        d.category,
        `${d.loadPriority}/10`,
        d.description,
      ]),
      ...result.custom.map((d) => [
        d.id,
        'custom',
        d.category,
        `${d.loadPriority}/10`,
        d.description,
      ]),
    ];
    logger.table(headers, rows);
    logger.newline();
    logger.info(
      `${result.builtin.length} built-in · ${result.custom.length} custom`
    );
  });

domain
  .command('add <id>')
  .description('Add a custom domain (writes config + scaffolds the folder)')
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .option('-n, --name <name>', 'Human-readable name (defaults to a title-cased id)')
  .option('-d, --description <desc>', 'One-line description')
  .option(
    '-k, --keywords <csv>',
    'Comma-separated keywords used for auto-classification (required)'
  )
  .option(
    '-c, --category <category>',
    'core | development | features | advanced',
    'features'
  )
  .option('--load-priority <n>', 'Load priority 1-10', '5')
  .option('--dry-run', 'Preview without writing', false)
  .action(async (id, options) => {
    const { addDomain } = await import('../core/domains/manage.js');
    const docsPath = resolve(process.cwd(), options.path);

    const titleCase = (s: string) =>
      s.replace(/[-_]/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

    const spec = {
      id,
      name: options.name ?? titleCase(id),
      description: options.description ?? `${titleCase(id)} documentation`,
      keywords: options.keywords
        ? String(options.keywords)
            .split(',')
            .map((k: string) => k.trim())
            .filter(Boolean)
        : [],
      loadPriority: parseInt(options.loadPriority, 10),
      category: options.category,
    };

    const result = await addDomain({
      projectRoot: dirname(docsPath),
      docsPath,
      spec,
      dryRun: options.dryRun,
    });

    logger.header(`hewtd domain add: ${id}`);
    if (!result.ok) {
      for (const e of result.errors) logger.error(e);
      process.exit(1);
    }
    logger.info(`Config:  ${result.configPath}`);
    logger.info(`Folder:  ${result.domainFolder}`);
    if (result.action === 'dry_run') {
      logger.info('');
      logger.info('--- proposed config entry ---');
      logger.info(JSON.stringify(result.spec, null, 2));
      logger.info('');
      logger.info('Dry-run — nothing written. Re-run without --dry-run to apply.');
      return;
    }
    logger.success(`Added custom domain "${id}".`);
    logger.info(`Wrote ${result.filesWritten?.length ?? 0} file(s).`);
    logger.info('Run `hewtd maintain` any time to refresh indexes.');
  });

domain
  .command('remove <id>')
  .alias('rm')
  .description('Remove a custom domain from config (never deletes docs)')
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .option('--dry-run', 'Preview without writing', false)
  .action(async (id, options) => {
    const { removeDomain } = await import('../core/domains/manage.js');
    const docsPath = resolve(process.cwd(), options.path);

    const result = await removeDomain({
      projectRoot: dirname(docsPath),
      docsPath,
      id,
      dryRun: options.dryRun,
    });

    logger.header(`hewtd domain remove: ${id}`);
    if (!result.ok) {
      for (const e of result.errors) logger.error(e);
      process.exit(1);
    }
    if (result.orphanedDocs > 0) {
      logger.warn(
        `${result.orphanedDocs} document(s) in ${result.domainFolder} will be ORPHANED (left on disk, no longer a recognized domain).`
      );
    }
    if (result.action === 'dry_run') {
      logger.info('');
      logger.info('Dry-run — nothing written. Re-run without --dry-run to apply.');
      return;
    }
    logger.success(`Removed custom domain "${id}" from config.`);
    logger.info(`Folder left intact: ${result.domainFolder}`);
  });

// --- Archival process: archive / unarchive / archive-candidates ---

program
  .command('archive <file>')
  .description(
    'Archive (deprecate) a doc: move it into archive/, stamp lifecycle metadata, reindex. Non-destructive + reversible.'
  )
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .option('-r, --reason <reason>', 'Why this doc is being archived')
  .option('--force', 'Archive even if active docs still link to it', false)
  .option('--dry-run', 'Preview without moving anything', false)
  .action(async (file, options) => {
    const { archiveDoc } = await import('../core/archive/manage.js');
    const docsPath = resolve(process.cwd(), options.path);
    const result = await archiveDoc({
      projectRoot: dirname(docsPath),
      docsPath,
      file,
      reason: options.reason,
      force: options.force,
      dryRun: options.dryRun,
    });

    logger.header(`hewtd archive: ${file}`);
    if (!result.ok) {
      for (const e of result.errors) logger.error(e);
      if (result.action === 'blocked' && result.inboundLinks.length > 0) {
        logger.info('');
        logger.info('Active docs linking here (fix these or use --force):');
        for (const l of result.inboundLinks) {
          logger.info(`  ${l.source}:${l.lineNumber}  "${l.linkText}"`);
        }
      }
      process.exit(1);
    }
    logger.info(`From: ${result.from}`);
    logger.info(`To:   ${result.to}`);
    if (result.inboundLinks.length > 0) {
      logger.warn(
        `${result.inboundLinks.length} active doc(s) link here — these become dangling:`
      );
      for (const l of result.inboundLinks) logger.info(`  ${l.source}:${l.lineNumber}`);
    }
    if (result.action === 'dry_run') {
      logger.info('');
      logger.info('Dry-run — nothing moved. Re-run without --dry-run to apply.');
      return;
    }
    logger.success(`Archived via ${result.moveMethod}. Run \`hewtd maintain\` any time to refresh.`);
  });

program
  .command('unarchive <file>')
  .description('Restore an archived doc back to its domain folder (reverse of archive).')
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .option('--dry-run', 'Preview without moving anything', false)
  .action(async (file, options) => {
    const { unarchiveDoc } = await import('../core/archive/manage.js');
    const docsPath = resolve(process.cwd(), options.path);
    const result = await unarchiveDoc({
      projectRoot: dirname(docsPath),
      docsPath,
      file,
      dryRun: options.dryRun,
    });

    logger.header(`hewtd unarchive: ${file}`);
    if (!result.ok) {
      for (const e of result.errors) logger.error(e);
      process.exit(1);
    }
    logger.info(`From: ${result.from}`);
    logger.info(`To:   ${result.to}`);
    if (result.action === 'dry_run') {
      logger.info('');
      logger.info('Dry-run — nothing moved. Re-run without --dry-run to apply.');
      return;
    }
    logger.success(`Restored via ${result.moveMethod}.`);
  });

program
  .command('archive-candidates')
  .description('List docs that may warrant archiving (advisory — never moves anything).')
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .option('--json', 'Output as JSON', false)
  .action(async (options) => {
    const { loadPluginConfig } = await import('../utils/config.js');
    const { findArchiveCandidates } = await import('../core/archive/candidates.js');
    const docsPath = resolve(process.cwd(), options.path);
    const config = await loadPluginConfig(dirname(docsPath));

    const candidates = await findArchiveCandidates({
      docsPath,
      projectRoot: dirname(docsPath),
      config: config.archive,
    });

    if (options.json) {
      logger.info(JSON.stringify(candidates, null, 2));
      return;
    }

    logger.header('Archive candidates');
    if (candidates.length === 0) {
      logger.success('No archival candidates. Nothing flagged.');
      return;
    }
    for (const c of candidates) {
      logger.info(`  ${c.file}  (score ${c.score})`);
      for (const r of c.reasons) logger.info(`      - ${r}`);
    }
    logger.info('');
    logger.info('These are suggestions only. Archive one with:');
    logger.info('  hewtd archive <file> --dry-run    # preview, then drop --dry-run');
  });

// --- 2.3.0: knowledge-base commands ---

program
  .command('find-citers <fact-id>')
  .description('Find all playbooks and incidents that cite a fact')
  .option('--json', 'Output as JSON', false)
  .action(async (factId, options) => {
    const projectRoot = projectRootDir;
    const { loadPluginConfig, resolveVaultRoot, resolvePlaybookGlobs } = await import(
      '../utils/config.js'
    );
    const { buildCiterIndex, findCitersInIndex } = await import(
      '../core/knowledge-base/citers.js'
    );

    const config = await loadPluginConfig(projectRoot);
    const vaultRoot = resolveVaultRoot(projectRoot, config);
    const playbookGlobs = resolvePlaybookGlobs(projectRoot, config);

    const index = await buildCiterIndex({ projectRoot, vaultRoot, playbookGlobs });
    const result = findCitersInIndex(index, factId);

    if (options.json) {
      logger.info(JSON.stringify(result, null, 2));
      if (!result.fact_exists) process.exit(1);
      return;
    }

    logger.header(`Citers for fact: ${factId}`);
    if (!result.fact_exists) {
      logger.error(`Fact not found in vault.`);
      logger.info('Did you mean another fact id? Run `hewtd audit-facts` to see all known facts.');
      process.exit(1);
    }
    logger.info('');
    logger.info(`Citers (${result.citers.length}):`);
    for (const c of result.citers) logger.info(`  - ${c}`);
    logger.info('');
    logger.info(`Incidents (produced): ${result.incidents_produced_in.join(', ') || '(none)'}`);
    logger.info(`Incidents (strengthened): ${result.incidents_strengthened_by.join(', ') || '(none)'}`);
    logger.info(`Incidents (weakened): ${result.incidents_weakened_by.join(', ') || '(none)'}`);
  });

program
  .command('audit-facts')
  .description('Report facts past last_verified + audit_window_days')
  .option('--run-verify <fact-id>', 'Execute the fact\'s verify_command and update last_verified on success')
  .option('--run-verify-all', 'Run --run-verify for every fact that has a verify_command; exit 1 if any fail', false)
  .option('--window <days>', 'Override audit_window_days', undefined)
  .option('--json', 'Output as JSON', false)
  .action(async (options) => {
    const projectRoot = projectRootDir;
    const { loadPluginConfig, resolveVaultRoot, resolvePlaybookGlobs } = await import(
      '../utils/config.js'
    );
    const { buildCiterIndex } = await import('../core/knowledge-base/citers.js');
    const { auditFacts, runFactVerify } = await import('../core/knowledge-base/audit.js');

    const config = await loadPluginConfig(projectRoot);
    const vaultRoot = resolveVaultRoot(projectRoot, config);
    const playbookGlobs = resolvePlaybookGlobs(projectRoot, config);
    const window = options.window
      ? parseInt(options.window, 10)
      : config.vault.audit_window_days;

    const index = await buildCiterIndex({ projectRoot, vaultRoot, playbookGlobs });

    // --run-verify-all path (#39): one command for a periodic re-check.
    if (options.runVerifyAll) {
      const results = [];
      for (const fact of [...index.facts.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        const r = await runFactVerify({ fact, vaultRoot });
        if (r.executed) results.push(r);
      }
      const failed = results.filter((r) => !r.updated);
      if (options.json) {
        logger.info(JSON.stringify(results, null, 2));
      } else {
        logger.header(`Verified ${results.length} fact(s) with a verify_command:`);
        for (const r of results) {
          logger.info(`  ${r.updated ? '✓' : '✗'} ${r.factId}  (exit ${r.exitCode})`);
        }
        if (failed.length > 0) {
          logger.error(`${failed.length} failed; last_verified not updated for those.`);
        }
      }
      process.exit(failed.length > 0 ? 1 : 0);
    }

    // --run-verify path
    if (options.runVerify) {
      const factId = options.runVerify;
      const fact = index.facts.get(factId);
      if (!fact) {
        logger.error(`Fact not found: ${factId}`);
        process.exit(1);
      }
      logger.header(`Running verify command for: ${factId}`);
      const result = await runFactVerify({ fact: fact!, vaultRoot });
      if (options.json) {
        logger.info(JSON.stringify(result, null, 2));
      } else {
        logger.info(`exit code: ${result.exitCode}`);
        if (result.stdout) logger.info(`stdout: ${result.stdout.trim()}`);
        if (result.stderr) logger.info(`stderr: ${result.stderr.trim()}`);
        if (result.updated) {
          logger.success(`Updated last_verified to ${result.newLastVerified}`);
        } else if (result.executed) {
          logger.error('Verify command failed; last_verified not updated.');
        }
      }
      process.exit(result.updated ? 0 : 1);
    }

    // List stale path
    const audit = auditFacts({ index, auditWindowDays: window });

    if (options.json) {
      logger.info(JSON.stringify(audit, null, 2));
      if (audit.stale.length > 0) process.exit(1);
      return;
    }

    logger.header(`Stale facts (verified > ${window}d ago):`);
    if (audit.stale.length === 0) {
      logger.success('No stale facts.');
    } else {
      for (const s of audit.stale) {
        logger.info(
          `  ${s.id}    ${s.lastVerified}  (${s.daysSinceVerified}d)  confidence:${s.confidence ?? '?'}`
        );
      }
      logger.info('');
      logger.info('Run verify commands:');
      logger.info(`  hewtd audit-facts --run-verify <fact-id>`);
    }

    if (audit.unverifiable.length > 0) {
      logger.warn(`Unverifiable facts (malformed/missing last_verified): ${audit.unverifiable.length}`);
      for (const u of audit.unverifiable) {
        logger.info(`  ${u.id}    ${u.relPath}`);
      }
    }

    if (audit.stale.length > 0) process.exit(1);
  });

program
  .command('cite <fact-id>')
  .description('Insert a cites: entry for the named fact into a playbook')
  .option('-f, --file <path>', 'Path to the playbook to modify (required)')
  .option('--alert-name <name>', 'Target the symptom entry with this exact alert_name')
  .option('--user-phrase <phrase>', 'Target the symptom entry with this user_phrase')
  .option('--error-pattern <pattern>', 'Target the symptom entry with this error_pattern')
  .option('--dry-run', 'Preview the change without writing', false)
  .action(async (factId, options) => {
    if (!options.file) {
      logger.error('--file <path> is required');
      process.exit(1);
    }
    const playbookPath = resolve(process.cwd(), options.file);
    const { cite } = await import('../core/knowledge-base/cite.js');

    const symptomMatch: NonNullable<Parameters<typeof cite>[0]['symptomMatch']> = {};
    if (options.alertName) symptomMatch.alert_name = options.alertName;
    if (options.userPhrase) symptomMatch.user_phrase = options.userPhrase;
    if (options.errorPattern) symptomMatch.error_pattern = options.errorPattern;

    const citeOpts: Parameters<typeof cite>[0] = {
      playbookPath,
      factId,
      dryRun: options.dryRun,
    };
    if (Object.keys(symptomMatch).length > 0) {
      citeOpts.symptomMatch = symptomMatch;
    }
    const result = await cite(citeOpts);

    logger.header(`hewtd cite: ${factId}`);
    logger.info(`Playbook: ${result.playbookPath}`);
    logger.info(`Action:   ${result.action}`);
    logger.info(`Symptom:  index ${result.symptomIndex}`);
    if (options.dryRun) {
      logger.info('');
      logger.info('--- proposed content ---');
      logger.info(result.newContent);
    }
  });

program
  .command('migrate-incident <flat-file>')
  .description('Convert a legacy flat-file incident into the folder form (narrative.md + facts.md). Always writes to <vault-root>/incidents/<slug>/.')
  .option('--dry-run', 'Preview the migration without writing', false)
  .option('--force', 'Migrate even if a folder already exists at the canonical or legacy location (overwrites)', false)
  .action(async (flatFile, options) => {
    const projectRoot = projectRootDir;
    const flatFilePath = resolve(process.cwd(), flatFile);
    const { migrateIncident } = await import('../core/knowledge-base/migrate.js');
    const { loadPluginConfig, resolveVaultRoot } = await import('../utils/config.js');

    const config = await loadPluginConfig(projectRoot);
    const vaultRoot = resolveVaultRoot(projectRoot, config);

    const result = await migrateIncident({
      flatFilePath,
      vaultRoot,
      dryRun: options.dryRun,
      force: options.force,
    });

    logger.header(`hewtd migrate-incident`);
    logger.info(`Source:        ${result.flatFilePath}`);
    logger.info(`Target folder: ${result.targetFolder}`);
    logger.info(`Action:        ${result.action}`);
    if (result.action === 'dry_run') {
      logger.info('');
      logger.info('--- narrative.md ---');
      logger.info(result.narrativeContent);
      logger.info('--- facts.md ---');
      logger.info(result.factsContent);
    } else if (result.action === 'migrated') {
      logger.success(`Migrated to ${result.targetFolder}`);
      logger.info(`  narrative: ${result.narrativePath}`);
      logger.info(`  facts:     ${result.factsPath}`);
      logger.info(`  evidence:  ${result.evidencePath} (empty)`);
      logger.info(`  original:  ${result.flatFilePath}.migrated (renamed for rollback)`);
    } else if (result.action === 'already_migrated') {
      logger.warn(`Already migrated.`);
      if (result.existingLocation === 'legacy') {
        logger.warn(`  Existing folder is at the 2.3.0 legacy location: ${result.narrativePath}`);
        logger.warn(`  Run \`hewtd fix-legacy-layout\` to relocate it under incidents/.`);
      } else {
        logger.info(`  Existing folder: ${result.narrativePath}`);
      }
      logger.info(`  Use --force to re-migrate (overwrites).`);
    }
  });

program
  .command('fix-legacy-layout')
  .description('Relocate incident folders written by buggy 2.3.0 migrate-incident into the canonical <vault>/incidents/ parent, and rewrite any provenance: refs in fact files. Idempotent.')
  .option('--dry-run', 'Report what would be moved without writing', false)
  .action(async (options) => {
    const projectRoot = projectRootDir;
    const { fixLegacyLayout } = await import(
      '../core/knowledge-base/fix-legacy-layout.js'
    );
    const { loadPluginConfig, resolveVaultRoot } = await import(
      '../utils/config.js'
    );

    const config = await loadPluginConfig(projectRoot);
    const vaultRoot = resolveVaultRoot(projectRoot, config);

    const result = await fixLegacyLayout({
      vaultRoot,
      projectRoot,
      dryRun: options.dryRun,
    });

    logger.header(`hewtd fix-legacy-layout`);
    logger.info(`Vault root: ${result.vaultRoot}`);
    logger.info(`Action:     ${result.action}`);

    if (result.action === 'no_op') {
      logger.success('No legacy-layout incident folders found. Nothing to do.');
      return;
    }

    if (result.moved.length > 0) {
      logger.info('');
      logger.info(`Moved ${result.moved.length} folder${result.moved.length === 1 ? '' : 's'}:`);
      for (const m of result.moved) {
        logger.info(`  ${m.from} → ${m.to}`);
      }
    }

    if (result.rewrittenProvenance.length > 0) {
      logger.info('');
      logger.info(`Rewrote ${result.rewrittenProvenance.length} provenance reference${result.rewrittenProvenance.length === 1 ? '' : 's'}:`);
      for (const r of result.rewrittenProvenance) {
        logger.info(`  ${r.factPath}: ${r.oldRef} → ${r.newRef}`);
      }
    }

    if (result.skipped.length > 0) {
      logger.warn('');
      logger.warn(`Skipped ${result.skipped.length}:`);
      for (const s of result.skipped) {
        logger.warn(`  ${s.path} — ${s.reason}`);
      }
    }

    if (result.action === 'dry_run') {
      logger.info('');
      logger.info('Dry-run — no files were moved. Re-run without --dry-run to apply.');
    } else {
      logger.success('');
      logger.success('Done. Run `hewtd maintain` to regenerate indexes.');
    }
  });

program
  .command('fix-retrieval-fields')
  .description('Move summary/description into purpose and fold keywords into tags (dry run unless --apply).')
  .option('-p, --docs-path <path>', 'Documentation path', '.documentation')
  .option('--apply', 'Write the changes', false)
  .action(async (options) => {
    const { fixRetrievalFields } = await import('../core/metadata/fix-retrieval-fields.js');
    const result = await fixRetrievalFields({
      docsPath: resolve(process.cwd(), options.docsPath),
      apply: options.apply,
    });
    logger.header('hewtd fix-retrieval-fields');
    for (const c of result.changed) logger.info(`  ${c.file}: ${c.actions.join(', ')}`);
    for (const f of result.conflicts) logger.warn(`  ${f}: purpose and summary/description both set, left alone`);
    for (const e of result.errors) logger.error(`  ${e.file}: could not parse frontmatter, skipped (${e.message})`);
    if (result.dropped + result.cleared > 0) {
      logger.info(`  ${result.dropped} filler value(s) dropped, ${result.cleared} generator purpose(s) cleared`);
    }
    if (result.changed.length === 0) logger.success('Nothing to do.');
    else if (options.apply) logger.success(`Updated ${result.changed.length} file(s).`);
    else logger.info('Dry run, nothing written. Re-run with --apply.');
  });

program
  .command('extract-facts <incident-folder>')
  .description('Write accepted fact specs to <vault>/facts/. Specs come from the /hit-em-with-the-docs:extract-facts slash command.')
  .option(
    '--accept <json>',
    'JSON-encoded FactSpec array. Use single-quoted JSON: --accept \'[{"id":"...","title":"...","confidence":"high","claim":"..."}]\'',
    undefined
  )
  .option('--dry-run', 'Preview without writing', false)
  .action(async (incidentFolderArg, options) => {
    if (!options.accept) {
      logger.error(
        '--accept <json> is required. This CLI is the WRITER; use the /hit-em-with-the-docs:extract-facts slash command for the LLM-driven proposer.'
      );
      process.exit(1);
    }
    let accept: unknown;
    try {
      accept = JSON.parse(options.accept);
    } catch (err) {
      logger.error(`--accept must be valid JSON: ${(err as Error).message}`);
      process.exit(1);
    }
    if (!Array.isArray(accept)) {
      logger.error('--accept must be a JSON array of FactSpec objects');
      process.exit(1);
    }

    const projectRoot = projectRootDir;
    const incidentFolder = resolve(process.cwd(), incidentFolderArg);
    const { loadPluginConfig, resolveVaultRoot } = await import('../utils/config.js');
    const { extractFacts } = await import('../core/knowledge-base/extract.js');

    const config = await loadPluginConfig(projectRoot);
    const vaultRoot = resolveVaultRoot(projectRoot, config);

    // Trust the caller's JSON shape — the slash command produced it after
    // the user accepted proposals. Runtime errors surface naturally.
    const result = await extractFacts({
      incidentFolder,
      vaultRoot,
      projectRoot,
      accept: accept as Parameters<typeof extractFacts>[0]['accept'],
      dryRun: options.dryRun,
    });

    logger.header(`hewtd extract-facts: ${result.incidentId}`);
    for (const f of result.extractedFacts) {
      const tag = f.action === 'created' ? '✓ created' : '· skipped (exists)';
      logger.info(`  ${tag}  ${f.factPath}`);
    }
    if (result.factsMdUpdated) {
      logger.success(`Updated ${result.factsMdPath} (produced: list)`);
    }
  });

// Reconcile command
program
  .command('reconcile')
  .description('Scoped, resumable doc-vs-code reconciliation (deterministic; the judgment pass is the /reconcile slash command).')
  .option('-p, --docs-path <path>', 'Documentation path', '.documentation')
  .option('--status', 'Show ledger progress: counts per lane/verdict, reviewed vs total, next unreviewed', false)
  .argument('[scope...]', 'Domain, folder or doc files to reconcile (required unless --next)')
  .option('--next <n>', 'With --status: how many unreviewed docs to list. Otherwise: reconcile the next N unreviewed docs')
  .option('--json', 'Machine-readable triage output (for the slash command)', false)
  .option('--serial', 'Force a serial plan regardless of job size', false)
  .option('--team', 'Force an agent-team plan regardless of job size', false)
  .option('--write-review', 'Write an empty review-file skeleton per shard under .hewtd/reconcile/', false)
  .option('--batch <id>', 'Batch id for --write-review (default: next number)')
  .option('--outside', 'List markdown files outside the docs root by class (tool-read, junk, not-a-doc, misplaced); with --write-review, write an outside review file', false)
  .option('--secrets', 'Masked secret scan (no scope: whole docs root incl. archive/, the outside lane and .hewtd/); never prints a value', false)
  .option('--overview <question>', 'Propose a cross-domain member list for a flow or question; writes only .hewtd/reconcile/overview-<slug>.json. With --write-review: the members file to turn into an overview review skeleton', undefined)
  .option('--limit <n>', 'With --overview: member cap (default 12)')
  .option('--apply <files...>', 'Apply the accepted entries of review files (serial, one commit per batch)')
  .action(async (scope: string[], options) => {
    const { loadPluginConfig } = await import('../utils/config.js');
    const { loadLedger, ledgerStatus, hashContent } = await import('../core/reconcile/ledger.js');
    const { glob } = await import('../utils/glob.js');
    const { projectRootOf } = await import('../core/reconcile/outside.js');
    const docsPath = resolve(process.cwd(), options.docsPath);
    // State (ledger, review files, config) lives at the project root, so a run from a subdirectory shares it.
    const root = projectRootOf(docsPath);
    const config = await loadPluginConfig(root);
    const ledgerFile = resolve(root, config.reconcile.ledger_path);
    if (options.apply) {
      try {
        const { applyReviews } = await import('../core/reconcile/apply.js');
        const res = await applyReviews({
          root, docsPath, ledger: await loadLedger(ledgerFile), ledgerFile,
          files: (options.apply as string[]).map((f) => resolve(root, f)),
        });
        logger.header('hewtd reconcile --apply');
        for (const o of res.outcomes) logger.info(`  [${o.status}] ${o.path}${o.detail ? ` - ${o.detail}` : ''}`);
        if (res.commit) logger.info(`  committed ${res.commit}`);
        const n = (st: string) => res.outcomes.filter((o) => o.status === st).length;
        logger.info(`applied ${n('applied')}, stale ${n('stale')}, rejected ${n('rejected')}, error ${n('error')}`);
        if (n('error')) process.exitCode = 1;
        const after = await loadLedger(ledgerFile);
        if (res.outcomes.some((o) => o.status === 'applied' && after.entries[o.path]?.env_names?.length)) {
          const { buildSecretsReport, writeSecretsReport } = await import('../core/reconcile/secrets-report.js');
          // Re-scan, so findings still pending stay in the report instead of being overwritten by the moved ones.
          const { scanSecrets } = await import('../core/reconcile/triage.js');
          const pending = await scanSecrets({ root, docsPath, config });
          const rep = await buildSecretsReport({ root, docsPath, findings: pending, ledger: after, cfg: config.reconcile.secrets });
          logger.info(`  secrets report with next steps (rotate, then purge): ${relative(root, await writeSecretsReport(root, rep.text))}`);
        }
      } catch (e) {
        logger.error((e as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    if (options.secrets) {
      try {
        const { scanSecrets } = await import('../core/reconcile/triage.js');
        const found = await scanSecrets({ root, docsPath, config, scope });
        const { buildSecretsReport, writeSecretsReport } = await import('../core/reconcile/secrets-report.js');
        const report = await buildSecretsReport({ root, docsPath, findings: found, ledger: await loadLedger(ledgerFile), cfg: config.reconcile.secrets });
        const reportFile = relative(root, await writeSecretsReport(root, report.text));
        if (options.json) { console.log(JSON.stringify(found, null, 2)); return; }
        logger.header('hewtd reconcile --secrets');
        for (const f of found) logger.info(`  [${f.kind}] ${f.rule} ${f.file}:${f.line} ${f.masked} (${f.fingerprint.slice(0, 12)})`);
        logger.info(`  ${found.length} finding(s)`);
        logger.info(`  report with next steps: ${reportFile}`);
      } catch (e) {
        logger.error((e as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    if (options.overview && options.writeReview) {
      try {
        const { writeOverviewReview } = await import('../core/reconcile/overview.js');
        logger.info(`  wrote ${relative(root, await writeOverviewReview({ root, docsPath, membersFile: resolve(root, options.overview), batch: options.batch }))}`);
      } catch (e) {
        logger.error((e as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    if (options.overview) {
      try {
        const { seedOverview, writeMembersFile } = await import('../core/reconcile/overview.js');
        const seed = await seedOverview({
          docsPath, config, ledger: await loadLedger(ledgerFile), question: options.overview,
          limit: options.limit ? parseInt(options.limit, 10) || undefined : undefined,
        });
        const file = relative(root, await writeMembersFile(root, seed));
        if (options.json) { console.log(JSON.stringify({ ...seed, file }, null, 2)); return; }
        logger.header('hewtd reconcile --overview');
        for (const m of seed.members) logger.info(`  [${m.state}] ${m.path} (${m.via})`);
        if (seed.existingOverview) logger.info(`  existing overview covers ${Math.round(seed.existingOverview.coverage * 100)}% of these: ${seed.existingOverview.path} (update it instead of adding one)`);
        if (seed.members.some((m) => m.state !== 'reconciled')) logger.warn('  reconcile the non-reconciled members first, or mark them in the overview');
        logger.info(`  members file (confirm before drafting): ${file}`);
      } catch (e) {
        logger.error((e as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    if (options.outside) {
      try {
        const { discoverOutside, writeOutsideReview } = await import('../core/reconcile/outside.js');
        const docs = await discoverOutside(docsPath, (await loadPluginConfig(projectRootOf(docsPath))).reconcile.keep_in_place);
        if (options.writeReview) logger.info(`  wrote ${relative(root, await writeOutsideReview({ docsPath, root, docs, batch: options.batch }))}`);
        if (options.json) { console.log(JSON.stringify(docs, null, 2)); return; }
        logger.header('hewtd reconcile --outside');
        for (const d of docs) logger.info(`  [${d.cls}] ${d.path} - ${d.reason}`);
      } catch (e) {
        logger.error((e as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    if (!options.status) {
      const { resolveScope, dirtyInScope, triage } = await import('../core/reconcile/triage.js');
      const { saveLedger } = await import('../core/reconcile/ledger.js');
      try {
        if (options.serial && options.team) throw new Error('--serial and --team are mutually exclusive');
        const ledger = await loadLedger(ledgerFile);
        const next = options.next ? parseInt(options.next, 10) || undefined : undefined;
        const rels = await resolveScope(docsPath, scope, { ...(next && { next }), ledger });
        const dirty = dirtyInScope(docsPath, rels);
        if (dirty.length) {
          throw new Error(`Refusing to start: uncommitted changes in scope (commit or stash first):\n${dirty.map((d) => `  ${d}`).join('\n')}`);
        }
        const result = await triage({
          root, docsPath, rels, config, ledger,
          ...((options.serial && { mode: 'serial' }) || (options.team && { mode: 'team' }) || {}),
        });
        await saveLedger(ledgerFile, ledger);
        if (options.writeReview) {
          const { writeReviewSkeletons } = await import('../core/reconcile/review.js');
          const files = await writeReviewSkeletons({ root, docsPath, triage: result, scope: scope.join(' ') || `next ${options.next}`, batch: options.batch });
          files.forEach((f) => logger.info(`  wrote ${relative(root, f)}`));
        }
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        logger.header('hewtd reconcile');
        const t = result.totals;
        logger.info(`  ${t.docs} docs, ${t.bytes} bytes to read; judgment needed on ${t.judgmentDocs} (${t.judgmentBytes} bytes)`);
        for (const [k, v] of Object.entries(t.byLane)) logger.info(`  ${k}: ${v}`);
        for (const d of result.docs) logger.info(`  [${d.lane}] ${d.path}${d.reasons.length ? ` - ${d.reasons.join('; ')}` : ''}`);
        for (const w of result.warnings) logger.warn(w);
        if (result.peripheral.length) logger.warn(`${result.peripheral.length} secret finding(s) in archive/, the outside lane or .hewtd/ (run: hewtd reconcile --secrets)`);
        logger.info(`  schema files: ${result.schemaFiles.length ? result.schemaFiles.join(', ') : 'none (set reconcile.schema_sources to check tables)'}`);
        logger.info(`  mode: ${result.mode}`);
        for (const s of result.shards) logger.info(`    shard ${s.id}: ${s.docs.length} docs, ${s.bytes} bytes`);
      } catch (e) {
        logger.error((e as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    const files = (await glob('**/*.md', { cwd: docsPath, ignore: ['archive/**', '**/INDEX.md', '**/REGISTRY.md'] })).sort();
    const docs = await Promise.all(
      files.map(async (f) => ({ path: f, hash: hashContent(await readFile(join(docsPath, f), 'utf-8')) }))
    );
    const ledger = await loadLedger(ledgerFile);
    const st = ledgerStatus(ledger, docs, parseInt(options.next ?? '10', 10) || 10);
    logger.header('hewtd reconcile --status');
    logger.info(`  reviewed ${st.reviewed} of ${st.total}`);
    for (const [k, v] of Object.entries(st.byLane)) logger.info(`  lane ${k}: ${v}`);
    for (const [k, v] of Object.entries(st.byVerdict)) logger.info(`  verdict ${k}: ${v}`);
    if (st.nextUnreviewed.length) logger.info(`  next unreviewed:\n${st.nextUnreviewed.map((p) => `    ${p}`).join('\n')}`);
  });

// Secrets command: baseline management (later: --staged)
program
  .command('secrets')
  .description('Secret-scan baseline: --baseline-add <file:line> --reason "..." | --baseline-prune. Never prints a value.')
  .option('-p, --docs-path <path>', 'Documentation path', '.documentation')
  .option('--baseline-add <file:line>', 'Baseline the finding(s) on that line (a known false positive)')
  .option('--reason <text>', 'Why it is a false positive (required with --baseline-add)')
  .option('--baseline-prune', 'Drop baseline entries whose value no longer occurs in anything scanned', false)
  .option('--staged', 'Scan only the lines the staged diff adds under the docs root (exit 1 on a secret); used by the pre-commit hook', false)
  .action(async (options) => {
    try {
      const { loadPluginConfig } = await import('../utils/config.js');
      const { projectRootOf } = await import('../core/reconcile/outside.js');
      const { addBaseline, loadBaseline, saveBaseline, scanFile, BASELINE_PATH } = await import('../core/reconcile/secrets.js');
      const docsPath = resolve(process.cwd(), options.docsPath);
      const root = projectRootOf(docsPath);
      const config = await loadPluginConfig(root);
      const cfg = config.reconcile.secrets;
      if (options.staged) {
        const { scanStaged } = await import('../core/reconcile/hooks.js');
        const hits = scanStaged(root, docsPath, cfg);
        if (!hits.length) return;
        logger.error(`commit refused: ${hits.length} added line(s) contain a secret (masked, first4…length):`);
        for (const f of hits.slice(0, 20)) logger.info(`  ${f.file}:${f.line} ${f.rule} ${f.masked} (${f.fingerprint.slice(0, 12)})`);
        logger.info('  rotate it, then move the value to .env.hewtd and leave a pointer (hewtd reconcile --secrets); a false positive: hewtd secrets --baseline-add <file:line> --reason "..."');
        process.exitCode = 1;
        return;
      }
      if (!options.baselineAdd && !options.baselinePrune) throw new Error('nothing to do: pass --baseline-add <file:line> --reason "..." or --baseline-prune');
      if (options.baselineAdd) {
        const m = /^(.+):(\d+)$/.exec(options.baselineAdd);
        if (!m) throw new Error('--baseline-add expects <file:line>');
        const file = relative(root, resolve(process.cwd(), m[1]!)).split('\\').join('/');
        const text = await readFile(join(root, file), 'utf-8');
        const added = await addBaseline(root, file, text, parseInt(m[2]!, 10), options.reason ?? '', cfg);
        logger.header('hewtd secrets --baseline-add');
        for (const a of added) logger.info(`  baselined ${a.rule} ${a.file} ${a.masked} (${a.fingerprint.slice(0, 12)})`);
        if (!added.length) logger.info('  already baselined');
        // Hint only: .gitignore is the user's call.
        const { spawnSync } = await import('child_process');
        if (spawnSync('git', ['check-ignore', '-q', BASELINE_PATH], { cwd: root }).status === 0) {
          logger.warn(`  ${BASELINE_PATH} is gitignored; to share it: git add -f ${BASELINE_PATH} (or add "!${BASELINE_PATH}" to .gitignore)`);
        }
      }
      if (options.baselinePrune) {
        const { scanSecrets } = await import('../core/reconcile/triage.js');
        const entries = await loadBaseline(root);
        // Scan with the baseline off, so a still-present value shows up.
        const bare = { ...config, reconcile: { ...config.reconcile, secrets: { ...cfg, allow: cfg.allow.filter((a) => !entries.some((e) => e.fingerprint === a.fingerprint)) } } };
        const seen = new Set((await scanSecrets({ root, docsPath, config: bare })).map((f) => f.fingerprint));
        for (const e of entries) for (const f of await scanFile(join(root, e.file), e.file, bare.reconcile.secrets)) seen.add(f.fingerprint);
        const kept = entries.filter((e) => seen.has(e.fingerprint));
        if (kept.length !== entries.length) await saveBaseline(root, kept);
        logger.header('hewtd secrets --baseline-prune');
        logger.info(`  removed ${entries.length - kept.length}, kept ${kept.length}`);
      }
    } catch (e) {
      logger.error((e as Error).message);
      process.exitCode = 1;
    }
  });

// Opt-in git pre-commit hook for the staged secret scan
program
  .command('hooks <action>')
  .description('install | uninstall the opt-in pre-commit hook block (hewtd secrets --staged); never overwrites an existing hook')
  .option('-p, --docs-path <path>', 'Documentation path', '.documentation')
  .action(async (action, options) => {
    try {
      if (action !== 'install' && action !== 'uninstall') throw new Error('expected install or uninstall');
      const { projectRootOf } = await import('../core/reconcile/outside.js');
      const { installHook, uninstallHook } = await import('../core/reconcile/hooks.js');
      const root = projectRootOf(resolve(process.cwd(), options.docsPath));
      const r = await (action === 'install' ? installHook : uninstallHook)(root);
      logger.info(`${r.changed ? action + 'ed' : 'unchanged'}: ${relative(root, r.path)}`);
    } catch (e) {
      logger.error((e as Error).message);
      process.exitCode = 1;
    }
  });

// Search command
program
  .command('search <query>')
  .description('Search documentation')
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .action(async (query, options) => {
    const docsPath = resolve(process.cwd(), options.path);
    const { findMarkdownFiles } = await import('../utils/glob.js');
    const { readFile } = await import('fs/promises');
    const { relative } = await import('path');

    logger.header(`Search: "${query}"`);

    const files = await findMarkdownFiles(docsPath);
    const results: { file: string; matches: number }[] = [];
    const searchRegex = new RegExp(query, 'gi');

    for (const file of files) {
      try {
        const content = await readFile(file, 'utf-8');
        const matches = content.match(searchRegex);
        if (matches) {
          results.push({
            file: relative(docsPath, file),
            matches: matches.length,
          });
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (results.length === 0) {
      logger.info('No results found.');
      return;
    }

    results.sort((a, b) => b.matches - a.matches);

    logger.info(`Found ${results.length} files with matches:`);
    logger.newline();

    for (const result of results.slice(0, 20)) {
      logger.info(`  ${result.file} (${result.matches} matches)`);
    }

    if (results.length > 20) {
      logger.info(`  ...and ${results.length - 20} more`);
    }
  });

// Parse and execute
program.parse();
