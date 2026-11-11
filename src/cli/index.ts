#!/usr/bin/env node

import { Command } from 'commander';
import { dirname, join, relative, resolve } from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createRequire } from 'node:module';
import { registerUpdateCommands } from '@theglitchking/claude-plugin-runtime';
import { logger } from '../utils/logger.js';

const require_module = createRequire(import.meta.url);
const package_info = require_module('../../package.json') as { version: string };
import { create_scaffold, is_scaffold_present } from '../generators/scaffold.js';
import { sync_metadata } from '../core/metadata/sync.js';
import { check_links } from '../core/links/checker.js';
import { check_documentation } from '../core/audit/auditor.js';
import { integrate_document } from '../core/integrate/integrator.js';
import { run_maintenance } from '../core/maintain/orchestrator.js';
import { discover_patterns } from '../core/discover/patterns.js';
import { discover_anti_patterns } from '../core/discover/antipatterns.js';
import { discover_standards } from '../core/discover/standards.js';
import { discover_dependencies } from '../core/discover/dependencies.js';
import { write_health_report } from '../reports/health-report.js';
import { write_audit_report } from '../reports/audit-report.js';
import { write_link_report } from '../reports/link-report.js';
import { type Domain } from '../core/domains/constants.js';
import {
  get_all_domains,
  get_registry,
  get_domain_definition,
  is_valid_domain,
} from '../core/domains/registry.js';
import { regenerate_indexes, generate_knowledge_base_indexes } from '../generators/regenerate.js';
import { write_report_stamps } from '../generators/stamp-reports.js';
import { write_raw_config } from '../utils/config.js';
import { get_status_values } from '../core/metadata/status-registry.js';
import { resolve_docs_path } from '../utils/docs-root.js';

export const program = new Command();

program
  .name('hit-em-with-the-docs')
  .description('Self-managing documentation system with hierarchical structure and intelligent automation')
  .version(package_info.version);

// Project root of the resolved docs path: the git root holding it, else its parent.
let project_root_dir = process.cwd();
function find_project_root(docs_root: string): string {
  let dir_path = dirname(docs_root);
  for (;;) {
    if (existsSync(join(dir_path, '.git'))) return dir_path;
    const parent = dirname(dir_path);
    if (parent === dir_path) return dirname(docs_root);
    dir_path = parent;
  }
}

// Every command except `init` finds the docs tree from a subdirectory when -p is the default,
// and loads the project's config (domains, statuses) from that project, not from the cwd.
program.hook('preAction', (_this, action) => {
  if (action.name() === 'init') return;
  let docs_root: string | undefined;
  for (const key of ['path', 'docsPath']) {
    if (action.getOptionValueSource(key) === undefined) continue;
    if (action.getOptionValueSource(key) === 'default') {
      action.setOptionValue(key, resolve_docs_path(process.cwd(), String(action.getOptionValue(key)), false));
    }
    docs_root = resolve(process.cwd(), String(action.getOptionValue(key)));
  }
  docs_root ??= resolve_docs_path(process.cwd(), '.documentation', false);
  project_root_dir = find_project_root(docs_root);
  get_registry(project_root_dir);
  get_status_values(project_root_dir);
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
    const docs_root = resolve(process.cwd(), options.path);

    const existed = await is_scaffold_present(docs_root);
    if (existed && !options.force) {
      logger.warn('Documentation structure already exists. Use --force to overwrite.');
      process.exit(1);
    }

    const result = await create_scaffold({
      root_path: docs_root,
      overwrite: options.force,
    });

    if (!result.success) {
      logger.error('Failed to initialize documentation');
      process.exit(1);
    }

    // New installs only: keep reports out of the searched docs tree. A re-init (--force) keeps
    // where reports already go, and an unreadable config is never overwritten.
    if (!existed) {
      const repo_root = dirname(docs_root);
      let raw_text: Record<string, unknown> | null = {};
      try {
        raw_text = JSON.parse(await readFile(join(repo_root, '.claude/hit-em-with-the-docs.json'), 'utf-8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') raw_text = null;
      }
      if (raw_text === null || typeof raw_text !== 'object' || Array.isArray(raw_text)) {
        logger.warn('Could not parse .claude/hit-em-with-the-docs.json; left it alone (reports_dir not set).');
      } else if (raw_text.reports_dir === undefined) {
        await write_raw_config(repo_root, { ...raw_text, reports_dir: '.hewtd/reports' });
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
    const docs_root = resolve(process.cwd(), options.path);

    const result = await run_maintenance({
      docs_root: docs_root,
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
  .option('--no-graph', 'Skip the .hewtd/graph.json export (fast refresh for hooks)')
  .action(async (options) => {
    const docs_root = resolve(process.cwd(), options.path);

    let domains: Domain[] | undefined;
    if (options.domain) {
      if (!is_valid_domain(options.domain)) {
        logger.error(`Unknown domain: ${options.domain}`);
        logger.info(`Valid domains: ${get_all_domains().join(', ')}`);
        process.exit(1);
      }
      domains = [options.domain];
    }

    logger.header(options.dryRun ? 'Index Regeneration (dry run)' : 'Index Regeneration');

    // Count what each domain's INDEX.md lists TODAY, so a dry run can show the
    // delta rather than just the new totals. The 2.7.1 recursive walk can add
    // hundreds of rows on first run; users deserve to see that before it lands.
    const listed_before: Record<string, number> = {};
    if (options.dryRun) {
      for (const domain of get_all_domains()) {
        listed_before[domain] = await count_indexed_doc_rows(
          join(docs_root, domain, 'INDEX.md')
        );
      }
    }

    const result = await regenerate_indexes({
      docs_root: docs_root,
      ...(domains ? { domains } : {}),
      silent: true,
      dry_run: options.dryRun,
    });

    let added = 0;
    for (const domain of get_all_domains()) {
      const count = result.document_counts[domain] ?? 0;
      let suffix = '';
      if (options.dryRun) {
        const delta = count - (listed_before[domain] ?? 0);
        added += Math.max(0, delta);
        suffix = delta > 0 ? `  (+${delta} not currently listed)` : '';
      }
      logger.info(
        `  ${domain.padEnd(16)} ${count} document${count === 1 ? '' : 's'}${suffix}`
      );
    }
    logger.newline();

    // Upgrade step: KB indexes and pre-2.13 reports also get rebuilt/stamped here.
    const knowledge_base_indexes = await generate_knowledge_base_indexes(docs_root, options.dryRun);
    const stamped = await write_report_stamps(docs_root, options.dryRun);
    if (knowledge_base_indexes) {
      logger.info(
        `Knowledge base: ${knowledge_base_indexes.facts} facts, ${knowledge_base_indexes.incidents} incidents${options.dryRun ? ' (would rebuild indexes)' : ' (indexes rebuilt)'}`
      );
    }
    if (stamped.length > 0) {
      logger.info(`${options.dryRun ? 'Would stamp' : 'Stamped'} generated: true on ${stamped.length} report file(s)`);
      if (options.dryRun) for (const file of stamped) logger.info(`  ${file}`);
    }

    if (options.graph !== false) await export_graph(docs_root, options.dryRun);

    if (!options.dryRun) {
      logger.success(
        `${result.files_written.length} index files written · ${result.total_documents} documents total`
      );
      return;
    }

    logger.success(
      `Would write ${result.files_written.length} index files · ${result.total_documents} documents total`
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

/** Write .hewtd/graph.json (#65). Never fails the caller: the export is a side product. */
async function export_graph(docs_root: string, dry_run: boolean): Promise<void> {
  try {
    const { load_plugin_config } = await import('../utils/config.js');
    const { resolve_git_top: project_root_of } = await import('../core/reconcile/outside.js');
    const { write_graph } = await import('../core/graph/export.js');
    const repo_root = project_root_of(docs_root);
    const result = await write_graph({ root: repo_root, docs_root: docs_root, config: await load_plugin_config(repo_root), dry_run });
    if (result.status === 'no-git') logger.info('Graph export skipped: not a git checkout.');
    else if (result.status === 'written') logger.info('Graph export written: .hewtd/graph.json');
    else if (result.status === 'would-write') logger.info('Would update .hewtd/graph.json');
    if (result.hint) logger.info('Tip: .hewtd/graph.json is not git-ignored; add it to .gitignore unless you want it committed.');
  } catch (entry) {
    logger.warn(`Graph export failed: ${(entry as Error).message}`);
  }
}

/** How many document rows a generated INDEX.md currently lists (0 if absent). */
async function count_indexed_doc_rows(index_path: string): Promise<number> {
  try {
    const content = await readFile(index_path, 'utf-8');
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
    const docs_root = resolve(process.cwd(), options.path);

    const result = await sync_metadata({
      docs_root: docs_root,
      domain: options.domain,
      dry_run: options.dryRun,
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
    const docs_root = resolve(process.cwd(), options.path);

    const result = await check_links({
      docs_root: docs_root,
      domain: options.domain,
    });

    if (options.report) {
      const report_path = await write_link_report(docs_root, result);
      logger.success(`Report saved: ${report_path}`);
    }

    if (result.broken_links.length > 0) {
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
    const docs_root = resolve(process.cwd(), options.path);
    const git_top = (await import('../core/reconcile/triage.js')).find_git_top(docs_root); // cold generations are found from any subfolder or -p

    const result = await check_documentation({
      docs_root: docs_root,
      ...(git_top && { repo_root: git_top }),
      domain: options.domain,
      issues_only: options.issuesOnly,
      strict: options.strict,
    });

    if (options.report) {
      const report_path = await write_audit_report(docs_root, result);
      logger.success(`Report saved: ${report_path}`);
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
      const has_violation = result.issues.some(
        (i) => i.severity === 'error' || i.code !== undefined
      );
      if (has_violation) {
        logger.error('Strict mode: violations detected, exiting non-zero');
        process.exit(1);
      }
    } else if (result.failed_files > 0) {
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
    const docs_root = resolve(process.cwd(), options.path);
    const file_path = resolve(process.cwd(), file);

    const result = await integrate_document({
      file_path,
      docs_root: docs_root,
      auto: options.auto,
      dry_run: options.dryRun,
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
    const root_path = resolve(process.cwd(), options.root);

    await discover_patterns({
      root_path,
      language: options.language,
      category: options.category,
    });
  });

discover
  .command('anti-patterns')
  .description('Detect anti-patterns in codebase')
  .option('-r, --root <path>', 'Root path to scan', '.')
  .action(async (options) => {
    const root_path = resolve(process.cwd(), options.root);

    await discover_anti_patterns({
      root_path,
    });
  });

discover
  .command('standards')
  .description('Extract implicit standards from codebase')
  .option('-r, --root <path>', 'Root path to scan', '.')
  .action(async (options) => {
    const root_path = resolve(process.cwd(), options.root);

    await discover_standards({
      root_path,
    });
  });

discover
  .command('dependencies')
  .description('Analyze project dependencies')
  .option('-r, --root <path>', 'Root path to scan', '.')
  .action(async (options) => {
    const root_path = resolve(process.cwd(), options.root);

    await discover_dependencies({
      root_path,
    });
  });

// Report command
program
  .command('report <type>')
  .description('Generate a report (health, audit, links)')
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .option('-f, --format <format>', 'Output format (markdown, json)', 'markdown')
  .action(async (type, options) => {
    const docs_root = resolve(process.cwd(), options.path);

    switch (type) {
      case 'health': {
        const result = await run_maintenance({ docs_root: docs_root, quick: true, silent: true });
        const report_path = await write_health_report(docs_root, result, options.format);
        logger.success(`Health report saved: ${report_path}`);
        break;
      }
      case 'audit': {
        const result = await check_documentation({ docs_root: docs_root, silent: true });
        const report_path = await write_audit_report(docs_root, result, options.format);
        logger.success(`Audit report saved: ${report_path}`);
        break;
      }
      case 'links': {
        const result = await check_links({ docs_root: docs_root, silent: true });
        const report_path = await write_link_report(docs_root, result, options.format);
        logger.success(`Link report saved: ${report_path}`);
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
    const rows = get_all_domains().map((doc) => {
      const definition = get_domain_definition(doc);
      return [doc, definition.category, `${definition.loadPriority}/10`, definition.description];
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
    const { list_domains } = await import('../core/domains/manage.js');
    const result = list_domains(project_root_dir);

    if (options.json) {
      logger.info(JSON.stringify(result, null, 2));
      return;
    }

    logger.header('Documentation Domains');
    const headers = ['Domain', 'Kind', 'Category', 'Priority', 'Description'];
    const rows = [
      ...result.builtin.map((doc) => [
        doc.id,
        'built-in',
        doc.category,
        `${doc.loadPriority}/10`,
        doc.description,
      ]),
      ...result.custom.map((doc) => [
        doc.id,
        'custom',
        doc.category,
        `${doc.loadPriority}/10`,
        doc.description,
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
    const { add_domain } = await import('../core/domains/manage.js');
    const docs_root = resolve(process.cwd(), options.path);

    const format_title_case = (text: string) =>
      text.replace(/[-_]/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

    const spec = {
      id,
      name: options.name ?? format_title_case(id),
      description: options.description ?? `${format_title_case(id)} documentation`,
      keywords: options.keywords
        ? String(options.keywords)
            .split(',')
            .map((key: string) => key.trim())
            .filter(Boolean)
        : [],
      loadPriority: parseInt(options.loadPriority, 10),
      category: options.category,
    };

    const result = await add_domain({
      repo_root: dirname(docs_root),
      docs_root: docs_root,
      spec,
      dry_run: options.dryRun,
    });

    logger.header(`hewtd domain add: ${id}`);
    if (!result.ok) {
      for (const entry of result.errors) logger.error(entry);
      process.exit(1);
    }
    logger.info(`Config:  ${result.config_path}`);
    logger.info(`Folder:  ${result.domain_folder}`);
    if (result.action === 'dry_run') {
      logger.info('');
      logger.info('--- proposed config entry ---');
      logger.info(JSON.stringify(result.spec, null, 2));
      logger.info('');
      logger.info('Dry-run — nothing written. Re-run without --dry-run to apply.');
      return;
    }
    logger.success(`Added custom domain "${id}".`);
    logger.info(`Wrote ${result.files_written?.length ?? 0} file(s).`);
    logger.info('Run `hewtd maintain` any time to refresh indexes.');
  });

domain
  .command('remove <id>')
  .alias('rm')
  .description('Remove a custom domain from config (never deletes docs)')
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .option('--dry-run', 'Preview without writing', false)
  .action(async (id, options) => {
    const { remove_domain } = await import('../core/domains/manage.js');
    const docs_root = resolve(process.cwd(), options.path);

    const result = await remove_domain({
      repo_root: dirname(docs_root),
      docs_root: docs_root,
      id,
      dry_run: options.dryRun,
    });

    logger.header(`hewtd domain remove: ${id}`);
    if (!result.ok) {
      for (const entry of result.errors) logger.error(entry);
      process.exit(1);
    }
    if (result.orphaned_docs > 0) {
      logger.warn(
        `${result.orphaned_docs} document(s) in ${result.domain_folder} will be ORPHANED (left on disk, no longer a recognized domain).`
      );
    }
    if (result.action === 'dry_run') {
      logger.info('');
      logger.info('Dry-run — nothing written. Re-run without --dry-run to apply.');
      return;
    }
    logger.success(`Removed custom domain "${id}" from config.`);
    logger.info(`Folder left intact: ${result.domain_folder}`);
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
    const { archive_doc } = await import('../core/archive/manage.js');
    const docs_root = resolve(process.cwd(), options.path);
    const result = await archive_doc({
      repo_root: dirname(docs_root),
      docs_root: docs_root,
      file,
      reason: options.reason,
      force: options.force,
      dry_run: options.dryRun,
    });

    logger.header(`hewtd archive: ${file}`);
    if (!result.ok) {
      for (const entry of result.errors) logger.error(entry);
      if (result.action === 'blocked' && result.inbound_links.length > 0) {
        logger.info('');
        logger.info('Active docs linking here (fix these or use --force):');
        for (const line of result.inbound_links) {
          logger.info(`  ${line.source}:${line.line_number}  "${line.link_text}"`);
        }
      }
      process.exit(1);
    }
    logger.info(`From: ${result.from}`);
    logger.info(`To:   ${result.to}`);
    if (result.inbound_links.length > 0) {
      logger.warn(
        `${result.inbound_links.length} active doc(s) link here — these become dangling:`
      );
      for (const line of result.inbound_links) logger.info(`  ${line.source}:${line.line_number}`);
    }
    if (result.action === 'dry_run') {
      logger.info('');
      logger.info('Dry-run — nothing moved. Re-run without --dry-run to apply.');
      return;
    }
    logger.success(`Archived via ${result.move_method}. Run \`hewtd maintain\` any time to refresh.`);
  });

program
  .command('unarchive <file>')
  .description('Restore an archived doc back to its domain folder (reverse of archive).')
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .option('--dry-run', 'Preview without moving anything', false)
  .action(async (file, options) => {
    const { unarchive_doc } = await import('../core/archive/manage.js');
    const docs_root = resolve(process.cwd(), options.path);
    const result = await unarchive_doc({
      repo_root: dirname(docs_root),
      docs_root: docs_root,
      file,
      dry_run: options.dryRun,
    });

    logger.header(`hewtd unarchive: ${file}`);
    if (!result.ok) {
      for (const entry of result.errors) logger.error(entry);
      process.exit(1);
    }
    logger.info(`From: ${result.from}`);
    logger.info(`To:   ${result.to}`);
    if (result.action === 'dry_run') {
      logger.info('');
      logger.info('Dry-run — nothing moved. Re-run without --dry-run to apply.');
      return;
    }
    logger.success(`Restored via ${result.move_method}.`);
  });

program
  .command('archive-candidates')
  .description('List docs that may warrant archiving (advisory — never moves anything).')
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .option('--json', 'Output as JSON', false)
  .action(async (options) => {
    const { load_plugin_config } = await import('../utils/config.js');
    const { find_archive_candidates } = await import('../core/archive/candidates.js');
    const docs_root = resolve(process.cwd(), options.path);
    const config = await load_plugin_config(dirname(docs_root));

    const candidates = await find_archive_candidates({
      docs_root: docs_root,
      repo_root: dirname(docs_root),
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
    for (const candidate of candidates) {
      logger.info(`  ${candidate.file}  (score ${candidate.score})`);
      for (const reason of candidate.reasons) logger.info(`      - ${reason}`);
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
  .action(async (fact_id, options) => {
    const repo_root = project_root_dir;
    const { load_plugin_config, resolve_vault_root, resolve_playbook_globs } = await import(
      '../utils/config.js'
    );
    const { build_citer_index, find_citers_in_index } = await import(
      '../core/knowledge-base/citers.js'
    );

    const config = await load_plugin_config(repo_root);
    const vault_root = resolve_vault_root(repo_root, config);
    const playbook_globs = resolve_playbook_globs(repo_root, config);

    const index = await build_citer_index({ repo_root: repo_root, vault_root, playbook_globs });
    const result = find_citers_in_index(index, fact_id);

    if (options.json) {
      logger.info(JSON.stringify(result, null, 2));
      if (!result.fact_exists) process.exit(1);
      return;
    }

    logger.header(`Citers for fact: ${fact_id}`);
    if (!result.fact_exists) {
      logger.error(`Fact not found in vault.`);
      logger.info('Did you mean another fact id? Run `hewtd audit-facts` to see all known facts.');
      process.exit(1);
    }
    logger.info('');
    logger.info(`Citers (${result.citers.length}):`);
    for (const content of result.citers) logger.info(`  - ${content}`);
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
    const repo_root = project_root_dir;
    const { load_plugin_config, resolve_vault_root, resolve_playbook_globs } = await import(
      '../utils/config.js'
    );
    const { build_citer_index } = await import('../core/knowledge-base/citers.js');
    const { check_facts: audit_facts, run_fact_verify } = await import('../core/knowledge-base/audit.js');

    const config = await load_plugin_config(repo_root);
    const vault_root = resolve_vault_root(repo_root, config);
    const playbook_globs = resolve_playbook_globs(repo_root, config);
    const window = options.window
      ? parseInt(options.window, 10)
      : config.vault.audit_window_days;

    const index = await build_citer_index({ repo_root: repo_root, vault_root, playbook_globs });

    // --run-verify-all path (#39): one command for a periodic re-check.
    if (options.runVerifyAll) {
      const results = [];
      for (const fact of [...index.facts.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        const result = await run_fact_verify({ fact, vault_root });
        if (result.executed) results.push(result);
      }
      const failed = results.filter((result) => !result.updated);
      if (options.json) {
        logger.info(JSON.stringify(results, null, 2));
      } else {
        logger.header(`Verified ${results.length} fact(s) with a verify_command:`);
        for (const result of results) {
          logger.info(`  ${result.updated ? '✓' : '✗'} ${result.factId}  (exit ${result.exitCode})`);
        }
        if (failed.length > 0) {
          logger.error(`${failed.length} failed; last_verified not updated for those.`);
        }
      }
      process.exit(failed.length > 0 ? 1 : 0);
    }

    // --run-verify path
    if (options.runVerify) {
      const fact_id = options.runVerify;
      const fact = index.facts.get(fact_id);
      if (!fact) {
        logger.error(`Fact not found: ${fact_id}`);
        process.exit(1);
      }
      logger.header(`Running verify command for: ${fact_id}`);
      const result = await run_fact_verify({ fact: fact!, vault_root });
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
    const audit = audit_facts({ index, audit_window_days: window });

    if (options.json) {
      logger.info(JSON.stringify(audit, null, 2));
      if (audit.stale.length > 0) process.exit(1);
      return;
    }

    logger.header(`Stale facts (verified > ${window}d ago):`);
    if (audit.stale.length === 0) {
      logger.success('No stale facts.');
    } else {
      for (const text of audit.stale) {
        logger.info(
          `  ${text.id}    ${text.lastVerified}  (${text.daysSinceVerified}d)  confidence:${text.confidence ?? '?'}`
        );
      }
      logger.info('');
      logger.info('Run verify commands:');
      logger.info(`  hewtd audit-facts --run-verify <fact-id>`);
    }

    if (audit.unverifiable.length > 0) {
      logger.warn(`Unverifiable facts (malformed/missing last_verified): ${audit.unverifiable.length}`);
      for (const unit of audit.unverifiable) {
        logger.info(`  ${unit.id}    ${unit.relPath}`);
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
  .action(async (fact_id, options) => {
    if (!options.file) {
      logger.error('--file <path> is required');
      process.exit(1);
    }
    const playbook_path = resolve(process.cwd(), options.file);
    const { add_citation: cite } = await import('../core/knowledge-base/cite.js');

    const symptom_match: NonNullable<Parameters<typeof cite>[0]['symptom_match']> = {};
    if (options.alertName) symptom_match.alert_name = options.alertName;
    if (options.userPhrase) symptom_match.user_phrase = options.userPhrase;
    if (options.errorPattern) symptom_match.error_pattern = options.errorPattern;

    const cite_opts: Parameters<typeof cite>[0] = {
      playbook_path,
      fact_id,
      dry_run: options.dryRun,
    };
    if (Object.keys(symptom_match).length > 0) {
      cite_opts.symptom_match = symptom_match;
    }
    const result = await cite(cite_opts);

    logger.header(`hewtd cite: ${fact_id}`);
    logger.info(`Playbook: ${result.playbook_path}`);
    logger.info(`Action:   ${result.action}`);
    logger.info(`Symptom:  index ${result.symptom_index}`);
    if (options.dryRun) {
      logger.info('');
      logger.info('--- proposed content ---');
      logger.info(result.new_content);
    }
  });

program
  .command('migrate-incident <flat-file>')
  .description('Convert a legacy flat-file incident into the folder form (narrative.md + facts.md). Always writes to <vault-root>/incidents/<slug>/.')
  .option('--dry-run', 'Preview the migration without writing', false)
  .option('--force', 'Migrate even if a folder already exists at the canonical or legacy location (overwrites)', false)
  .action(async (flat_file, options) => {
    const repo_root = project_root_dir;
    const flat_file_path = resolve(process.cwd(), flat_file);
    const { migrate_incident } = await import('../core/knowledge-base/migrate.js');
    const { load_plugin_config, resolve_vault_root } = await import('../utils/config.js');

    const config = await load_plugin_config(repo_root);
    const vault_root = resolve_vault_root(repo_root, config);

    const result = await migrate_incident({
      flat_file_path,
      vault_root,
      dry_run: options.dryRun,
      force: options.force,
    });

    logger.header(`hewtd migrate-incident`);
    logger.info(`Source:        ${result.flat_file_path}`);
    logger.info(`Target folder: ${result.target_folder}`);
    logger.info(`Action:        ${result.action}`);
    if (result.action === 'dry_run') {
      logger.info('');
      logger.info('--- narrative.md ---');
      logger.info(result.narrative_content);
      logger.info('--- facts.md ---');
      logger.info(result.facts_content);
    } else if (result.action === 'migrated') {
      logger.success(`Migrated to ${result.target_folder}`);
      logger.info(`  narrative: ${result.narrative_path}`);
      logger.info(`  facts:     ${result.facts_path}`);
      logger.info(`  evidence:  ${result.evidence_path} (empty)`);
      logger.info(`  original:  ${result.flat_file_path}.migrated (renamed for rollback)`);
    } else if (result.action === 'already_migrated') {
      logger.warn(`Already migrated.`);
      if (result.existing_location === 'legacy') {
        logger.warn(`  Existing folder is at the 2.3.0 legacy location: ${result.narrative_path}`);
        logger.warn(`  Run \`hewtd fix-legacy-layout\` to relocate it under incidents/.`);
      } else {
        logger.info(`  Existing folder: ${result.narrative_path}`);
      }
      logger.info(`  Use --force to re-migrate (overwrites).`);
    }
  });

program
  .command('fix-legacy-layout')
  .description('Relocate incident folders written by buggy 2.3.0 migrate-incident into the canonical <vault>/incidents/ parent, and rewrite any provenance: refs in fact files. Idempotent.')
  .option('--dry-run', 'Report what would be moved without writing', false)
  .action(async (options) => {
    const repo_root = project_root_dir;
    const { fix_legacy_layout } = await import(
      '../core/knowledge-base/fix-legacy-layout.js'
    );
    const { load_plugin_config, resolve_vault_root } = await import(
      '../utils/config.js'
    );

    const config = await load_plugin_config(repo_root);
    const vault_root = resolve_vault_root(repo_root, config);

    const result = await fix_legacy_layout({
      vault_root,
      repo_root: repo_root,
      dry_run: options.dryRun,
    });

    logger.header(`hewtd fix-legacy-layout`);
    logger.info(`Vault root: ${result.vault_root}`);
    logger.info(`Action:     ${result.action}`);

    if (result.action === 'no_op') {
      logger.success('No legacy-layout incident folders found. Nothing to do.');
      return;
    }

    if (result.moved.length > 0) {
      logger.info('');
      logger.info(`Moved ${result.moved.length} folder${result.moved.length === 1 ? '' : 's'}:`);
      for (const moved_file of result.moved) {
        logger.info(`  ${moved_file.from} → ${moved_file.to}`);
      }
    }

    if (result.rewritten_provenance.length > 0) {
      logger.info('');
      logger.info(`Rewrote ${result.rewritten_provenance.length} provenance reference${result.rewritten_provenance.length === 1 ? '' : 's'}:`);
      for (const rewritten of result.rewritten_provenance) {
        logger.info(`  ${rewritten.fact_path}: ${rewritten.old_ref} → ${rewritten.new_ref}`);
      }
    }

    if (result.skipped.length > 0) {
      logger.warn('');
      logger.warn(`Skipped ${result.skipped.length}:`);
      for (const skipped_file of result.skipped) {
        logger.warn(`  ${skipped_file.path} — ${skipped_file.reason}`);
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
    const { fix_retrieval_fields } = await import('../core/metadata/fix-retrieval-fields.js');
    const result = await fix_retrieval_fields({
      docs_root: resolve(process.cwd(), options.docsPath),
      apply: options.apply,
    });
    logger.header('hewtd fix-retrieval-fields');
    for (const change of result.changed) logger.info(`  ${change.file}: ${change.actions.join(', ')}`);
    for (const file of result.conflicts) logger.warn(`  ${file}: purpose and summary/description both set, left alone`);
    for (const entry of result.errors) logger.error(`  ${entry.file}: could not parse frontmatter, skipped (${entry.message})`);
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
  .action(async (incident_folder_arg, options) => {
    if (!options.accept) {
      logger.error(
        '--accept <json> is required. This CLI is the WRITER; use the /hit-em-with-the-docs:extract-facts slash command for the LLM-driven proposer.'
      );
      process.exit(1);
    }
    let accept: unknown;
    try {
      accept = JSON.parse(options.accept);
    } catch (error) {
      logger.error(`--accept must be valid JSON: ${(error as Error).message}`);
      process.exit(1);
    }
    if (!Array.isArray(accept)) {
      logger.error('--accept must be a JSON array of FactSpec objects');
      process.exit(1);
    }

    const repo_root = project_root_dir;
    const incident_folder = resolve(process.cwd(), incident_folder_arg);
    const { load_plugin_config, resolve_vault_root } = await import('../utils/config.js');
    const { extract_facts } = await import('../core/knowledge-base/extract.js');

    const config = await load_plugin_config(repo_root);
    const vault_root = resolve_vault_root(repo_root, config);

    // Trust the caller's JSON shape — the slash command produced it after
    // the user accepted proposals. Runtime errors surface naturally.
    const result = await extract_facts({
      incident_folder,
      vault_root,
      repo_root: repo_root,
      accept: accept as Parameters<typeof extract_facts>[0]['accept'],
      dry_run: options.dryRun,
    });

    logger.header(`hewtd extract-facts: ${result.incident_id}`);
    for (const file of result.extracted_facts) {
      const tag = file.action === 'created' ? '✓ created' : '· skipped (exists)';
      logger.info(`  ${tag}  ${file.fact_path}`);
    }
    if (result.facts_md_updated) {
      logger.success(`Updated ${result.facts_md_path} (produced: list)`);
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
  .option('--stage <dir>', 'Snapshot the live docs working tree (archive/ and gitignored files included) into <dir>/docs for a staged reconcile; <dir> must be empty or new, inside the repo, outside the docs tree and on its filesystem (use .hewtd/<name>); never commit it', undefined)
  .option('--staged <dir>', 'Run any mode on the stage made by --stage: its docs, ledger.json and reconcile/ review files; the live tree, ledger and git are untouched (no commits). Not with -p', undefined)
  .option('--promote', 'With --staged <dir>: swap the reconciled copy in as the live docs and keep the old tree as a committed, read-only, dated cold generation (reconcile.cold_root). Prints the plan and changes nothing without --confirm', false)
  .option('--undo <generation>', 'Restore a cold generation as the live docs, byte for byte; the rejected tree moves to a new stage under .hewtd/stage. Needs --confirm', undefined)
  .option('--generations', 'List the cold generations with path, date, checksum status (ok / CHANGED / MISSING) and secret finding count; with --json, machine-readable', false)
  .option('--confirm', 'Required to carry out --promote or --undo', false)
  .option('--gaps <file>', 'Classify missed search queries (gaps.v1 file or one question per line) into user_phrase proposals, new-doc candidates and open questions; writes only .hewtd/reconcile/gaps-report-<date>.md', undefined)
  .action(async (scope: string[], options, command: Command) => {
    const { load_plugin_config } = await import('../utils/config.js');
    const { load_ledger, get_ledger_status: ledger_status, compute_content_hash: hash_content } = await import('../core/reconcile/ledger.js');
    const { list_glob_matches: glob } = await import('../utils/glob.js');
    const { resolve_git_top: project_root_of } = await import('../core/reconcile/outside.js');
    let staged: import('../core/reconcile/rotation.js').Stage | undefined;
    try {
      const { load_stage } = await import('../core/reconcile/rotation.js');
      if (options.stage && options.staged) throw new Error('--stage and --staged are mutually exclusive');
      if (options.staged && command.getOptionValueSource('docsPath') === 'cli') throw new Error('--staged and -p/--docs-path cannot be combined: the stage records its own docs folder');
      const rotating = [options.promote, options.undo, options.generations].filter(Boolean).length;
      if (rotating > 1) throw new Error('--promote, --undo and --generations are mutually exclusive');
      if (options.promote && !options.staged) throw new Error('--promote needs --staged <dir>');
      if ((options.undo || options.generations) && (options.staged || options.stage)) throw new Error('--undo and --generations do not take --stage/--staged');
      if (options.confirm && !options.promote && !options.undo) throw new Error('--confirm only goes with --promote or --undo');
      if (options.staged) staged = load_stage(resolve(process.cwd(), options.staged));
    } catch (entry) {
      logger.error((entry as Error).message);
      process.exitCode = 1;
      return;
    }
    // --promote works on the LIVE tree the stage was taken from; every other --staged mode works on the copy.
    const live_of_stage = staged && options.promote ? resolve(project_root_of(staged.stage_dir), staged.docs_path) : undefined;
    const docs_root = live_of_stage ?? (staged ? staged.docs_root : resolve(process.cwd(), options.docsPath));
    // State (ledger, review files, config) lives at the project root, so a run from a subdirectory shares it.
    const repo_root = project_root_of(docs_root);
    const config = await load_plugin_config(repo_root);
    const ledger_file = staged && !live_of_stage ? staged.ledger_file : resolve(repo_root, config.reconcile.ledger_path);
    if (staged && !live_of_stage) (await import('../core/reconcile/review.js')).set_review_dir(staged.review_dir);
    if (options.promote || options.undo || options.generations) {
      try {
        const rotation = await import('../core/reconcile/rotation.js');
        if (options.generations) {
          const rows = rotation.list_generations(repo_root, config.cold_storage);
          if (options.json) { console.log(JSON.stringify(rows, null, 2)); return; }
          logger.header('hewtd reconcile --generations');
          if (!rows.length) logger.info('  no cold generations');
          for (const row of rows) logger.info(`  ${row.generation}  ${row.path}  rotated ${row.rotated_at.slice(0, 10)}  checksum ${row.status}${row.disk_only_absent ? ` (disk-only files absent: ${row.disk_only_absent})` : ''}  ${row.secrets_findings} secret finding(s)`);
        } else if (options.undo) {
          if (!options.confirm) {
            const entry = await rotation.plan_undo({ repo_root, docs_root, config, generation: options.undo });
            throw new Error(`refusing without --confirm. Would move ${relative(repo_root, docs_root)} to a new stage under .hewtd/stage and restore ${entry.path} as the live docs. Re-run with --confirm`);
          }
          const done = await rotation.run_undo({ repo_root, docs_root, config, generation: options.undo });
          logger.header('hewtd reconcile --undo');
          logger.info(`  restored generation ${done.generation} as ${relative(repo_root, docs_root)} (${done.commit})`);
          if (done.disk_only_absent) logger.warn(`  ${done.disk_only_absent} gitignored (disk-only) file(s) of that generation are absent here and were not restored (a fresh clone does not have them)`);
          logger.info(`  the rejected tree is in ${done.rejected_stage}/docs (a stage: reconcile it with --staged, or discard it)`);
          await export_graph(docs_root, false);
        } else if (staged) {
          logger.header('hewtd reconcile --promote');
          if (!options.confirm) {
            const plan = await rotation.plan_promote({ repo_root, docs_root, config, stage: staged });
            logger.info(`  stage ${plan.stage_path} (taken at ${plan.source_commit.slice(0, 7)}); the live docs are unchanged since`);
            logger.info(`  ${plan.docs_path} -> ${plan.cold_path} (read-only, committed as a cold generation)`);
            logger.info(`  ${plan.stage_path}/docs -> ${plan.docs_path}`);
            logger.info(`  ${plan.secrets_findings.length} secret finding(s) in the outgoing tree (recorded as path:line in cold_storage, never values)`);
            logger.info(`  ${plan.untracked_files.length} gitignored file(s) stay on disk only (listed in cold_storage)`);
            logger.info('  nothing was changed. Re-run with --confirm to rotate.');
            return;
          }
          const done = await rotation.run_promote({ repo_root, docs_root, config, stage: staged });
          logger.info(`  promoted ${done.stage_path}; the previous tree is cold generation ${done.generation} at ${done.cold_path} (${done.commit})`);
          logger.info(`  ${done.secrets_findings.length} secret finding(s) in it are recorded in cold_storage; rotate those credentials, they stay in git history`);
          await export_graph(docs_root, false);
        }
      } catch (entry) {
        logger.error((entry as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    if (options.stage) {
      try {
        const { create_stage } = await import('../core/reconcile/rotation.js');
        const made = await create_stage({ repo_root, docs_root, stage_dir: resolve(process.cwd(), options.stage) });
        if (options.json) { console.log(JSON.stringify({ stage: relative(repo_root, made.stage_dir), docs_path: made.docs_path, source_commit: made.source_commit, staged_at: made.staged_at, live_checksum: made.live_checksum }, null, 2)); return; }
        logger.header('hewtd reconcile --stage');
        logger.info(`  staged ${made.docs_path} at ${made.source_commit.slice(0, 7)} into ${relative(repo_root, made.stage_dir)}/docs`);
        logger.info(`  next: hewtd reconcile --staged ${relative(process.cwd(), made.stage_dir) || '.'} <scope> --write-review`);
      } catch (entry) {
        logger.error((entry as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    if (options.apply) {
      try {
        const { apply_reviews } = await import('../core/reconcile/apply.js');
        const result = await apply_reviews({
          root: repo_root, docs_root: docs_root, ledger: await load_ledger(ledger_file), ledger_file,
          files: (options.apply as string[]).map((file) => resolve(repo_root, file)), ...(staged && { staged: true }),
        });
        logger.header('hewtd reconcile --apply');
        for (const outcome of result.outcomes) logger.info(`  [${outcome.status}] ${outcome.path}${outcome.detail ? ` - ${outcome.detail}` : ''}`);
        if (result.commit) logger.info(`  committed ${result.commit}`);
        if (result.index_warning) logger.warn(`  ${result.index_warning}`);
        const count_outcomes = (st: string) => result.outcomes.filter((outcome) => outcome.status === st).length;
        logger.info(`applied ${count_outcomes('applied')}, stale ${count_outcomes('stale')}, rejected ${count_outcomes('rejected')}, error ${count_outcomes('error')}`);
        if (count_outcomes('error')) process.exitCode = 1;
        if (count_outcomes('applied') && !staged) await export_graph(docs_root, false); // a rolled-back batch has no 'applied' outcome
        const after = await load_ledger(ledger_file);
        if (result.outcomes.some((outcome) => outcome.status === 'applied' && after.entries[outcome.path]?.env_names?.length)) {
          const { build_secrets_report, write_secrets_report } = await import('../core/reconcile/secrets-report.js');
          // Re-scan, so findings still pending stay in the report instead of being overwritten by the moved ones.
          const { scan_secrets } = await import('../core/reconcile/triage.js');
          const pending = await scan_secrets({ root: repo_root, docs_root: docs_root, config });
          const rep = await build_secrets_report({ root: repo_root, docs_root: docs_root, findings: pending, ledger: after, secrets_config: config.reconcile.secrets });
          logger.info(`  secrets report with next steps (rotate, then purge): ${relative(repo_root, await write_secrets_report(repo_root, rep.text))}`);
        }
      } catch (entry) {
        logger.error((entry as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    if (options.secrets) {
      try {
        const { scan_secrets } = await import('../core/reconcile/triage.js');
        const found = await scan_secrets({ root: repo_root, docs_root: docs_root, config, scope });
        const { build_secrets_report, write_secrets_report } = await import('../core/reconcile/secrets-report.js');
        const report = await build_secrets_report({ root: repo_root, docs_root: docs_root, findings: found, ledger: await load_ledger(ledger_file), secrets_config: config.reconcile.secrets });
        const report_file = relative(repo_root, await write_secrets_report(repo_root, report.text));
        if (options.json) { console.log(JSON.stringify(found, null, 2)); return; }
        logger.header('hewtd reconcile --secrets');
        for (const file of found) logger.info(`  [${file.kind}] ${file.rule} ${file.file}:${file.line} ${file.masked} (${file.fingerprint.slice(0, 12)})`);
        logger.info(`  ${found.length} finding(s)`);
        logger.info(`  report with next steps: ${report_file}`);
      } catch (entry) {
        logger.error((entry as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    if (options.gaps) {
      try {
        const { readFile: read_file } = await import('fs/promises');
        const { parse_gaps, classify_gaps } = await import('../core/reconcile/gaps.js');
        const { render_gaps_report, write_gaps_report } = await import('../core/reconcile/gaps-report.js');
        const read = parse_gaps(await read_file(resolve(process.cwd(), options.gaps), 'utf-8'), { docs_root: docs_root, repo_root: repo_root });
        const result = await classify_gaps(read.gaps, { root: repo_root, docs_root: docs_root, config });
        const report_file = relative(repo_root, await write_gaps_report(repo_root, render_gaps_report(result, config.reconcile.secrets)));
        const review_file = options.writeReview ? await (await import('../core/reconcile/review.js')).write_gaps_review({ root: repo_root, docs_root: docs_root, proposals: result.proposals, batch: options.batch }) : undefined;
        if (options.json) { console.log(JSON.stringify({ ...result, errors: read.errors, report: report_file, ...(review_file && { review: relative(repo_root, review_file) }) }, null, 2)); return; }
        logger.header('hewtd reconcile --gaps');
        for (const entry of read.errors) logger.warn(`  ${entry}`);
        logger.info(`  ${result.proposals.length} doc(s) with phrase proposals (${result.proposals.reduce((count, proposal) => count + proposal.accepted.length, 0)} phrases), ${result.candidates.length} new-doc candidate(s), ${result.questions.length} open question(s), ${result.dropped.length} dropped`);
        logger.info(`  report: ${report_file}`);
        if (review_file) logger.info(`  wrote ${relative(repo_root, review_file)}`);
      } catch (entry) {
        logger.error((entry as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    if (options.overview && options.writeReview) {
      try {
        const { write_overview_review } = await import('../core/reconcile/overview.js');
        logger.info(`  wrote ${relative(repo_root, await write_overview_review({ root: repo_root, docs_root: docs_root, members_file: resolve(repo_root, options.overview), batch: options.batch }))}`);
      } catch (entry) {
        logger.error((entry as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    if (options.overview) {
      try {
        const { load_overview_seed: seed_overview, write_members_file } = await import('../core/reconcile/overview.js');
        const seed = await seed_overview({
          docs_root: docs_root, config, ledger: await load_ledger(ledger_file), question: options.overview,
          limit: options.limit ? parseInt(options.limit, 10) || undefined : undefined,
        });
        const file = relative(repo_root, await write_members_file(repo_root, seed));
        if (options.json) { console.log(JSON.stringify({ ...seed, file }, null, 2)); return; }
        logger.header('hewtd reconcile --overview');
        for (const match of seed.members) logger.info(`  [${match.state}] ${match.path} (${match.via})`);
        if (seed.existingOverview) logger.info(`  existing overview covers ${Math.round(seed.existingOverview.coverage * 100)}% of these: ${seed.existingOverview.path} (update it instead of adding one)`);
        if (seed.members.some((member) => member.state !== 'reconciled')) logger.warn('  reconcile the non-reconciled members first, or mark them in the overview');
        logger.info(`  members file (confirm before drafting): ${file}`);
      } catch (entry) {
        logger.error((entry as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    if (options.outside) {
      try {
        const { discover_outside, write_outside_review } = await import('../core/reconcile/outside.js');
        const docs = await discover_outside(docs_root, (await load_plugin_config(project_root_of(docs_root))).reconcile.keep_in_place);
        if (options.writeReview) logger.info(`  wrote ${relative(repo_root, await write_outside_review({ docs_root: docs_root, root: repo_root, docs, batch: options.batch }))}`);
        if (options.json) { console.log(JSON.stringify(docs, null, 2)); return; }
        logger.header('hewtd reconcile --outside');
        for (const doc of docs) logger.info(`  [${doc.cls}] ${doc.path} - ${doc.reason}`);
      } catch (entry) {
        logger.error((entry as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    if (!options.status) {
      const { resolve_scope, find_dirty_in_scope: dirty_in_scope, triage_docs: triage } = await import('../core/reconcile/triage.js');
      const { write_ledger: save_ledger } = await import('../core/reconcile/ledger.js');
      try {
        if (options.serial && options.team) throw new Error('--serial and --team are mutually exclusive');
        const ledger = await load_ledger(ledger_file);
        const next = options.next ? parseInt(options.next, 10) || undefined : undefined;
        const doc_paths = await resolve_scope(docs_root, scope, { ...(next && { next }), ledger });
        const dirty = dirty_in_scope(docs_root, doc_paths);
        if (dirty.length) {
          throw new Error(`Refusing to start: uncommitted changes in scope (commit or stash first):\n${dirty.map((doc) => `  ${doc}`).join('\n')}`);
        }
        const result = await triage({
          root: repo_root, docs_root: docs_root, rels: doc_paths, config, ledger,
          ...(staged && { history_docs_root: resolve(repo_root, staged.docs_path) }), // a stage is untracked: git history comes from the live counterpart
          ...((options.serial && { mode: 'serial' }) || (options.team && { mode: 'team' }) || {}),
        });
        await save_ledger(ledger_file, ledger);
        if (options.writeReview) {
          const { write_review_skeletons } = await import('../core/reconcile/review.js');
          const files = await write_review_skeletons({ root: repo_root, docs_root: docs_root, triage: result, scope: scope.join(' ') || `next ${options.next}`, batch: options.batch, include_clean: scope.length > 0 && !options.next });
          files.forEach((file) => logger.info(`  wrote ${relative(repo_root, file)}`));
        }
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        logger.header('hewtd reconcile');
        const totals = result.totals;
        logger.info(`  ${totals.docs} docs, ${totals.bytes} bytes to read; judgment needed on ${totals.judgmentDocs} (${totals.judgmentBytes} bytes)`);
        for (const [key, value] of Object.entries(totals.byLane)) logger.info(`  ${key}: ${value}`);
        for (const doc of result.docs) logger.info(`  [${doc.lane}] ${doc.path}${doc.reasons.length ? ` - ${doc.reasons.join('; ')}` : ''}`);
        for (const warning of result.warnings) logger.warn(warning);
        if (result.peripheral.length) logger.warn(`${result.peripheral.length} secret finding(s) in archive/, the outside lane or .hewtd/ (run: hewtd reconcile --secrets)`);
        logger.info(`  schema files: ${result.schemaFiles.length ? result.schemaFiles.join(', ') : 'none (set reconcile.schema_sources to check tables)'}`);
        logger.info(`  mode: ${result.mode}`);
        for (const shard of result.shards) logger.info(`    shard ${shard.id}: ${shard.docs.length} docs, ${shard.bytes} bytes`);
      } catch (entry) {
        logger.error((entry as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    // eslint-disable-next-line id-denylist -- glob/child_process option name
    const files = (await glob('**/*.md', { cwd: docs_root, ignore: ['archive/**', '**/INDEX.md', '**/REGISTRY.md'] })).sort();
    const docs = await Promise.all(
      files.map(async (file) => ({ path: file, hash: hash_content(await readFile(join(docs_root, file), 'utf-8')) }))
    );
    const ledger = await load_ledger(ledger_file);
    const st = ledger_status(ledger, docs, parseInt(options.next ?? '10', 10) || 10);
    logger.header('hewtd reconcile --status');
    logger.info(`  reviewed ${st.reviewed} of ${st.total}`);
    for (const [key, value] of Object.entries(st.by_lane)) logger.info(`  lane ${key}: ${value}`);
    for (const [key, value] of Object.entries(st.by_verdict)) logger.info(`  verdict ${key}: ${value}`);
    if (st.metadata_updated) logger.info(`  reviewed, metadata updated since: ${st.metadata_updated}`);
    if (st.next_unreviewed.length) logger.info(`  next unreviewed:\n${st.next_unreviewed.map((path_text) => `    ${path_text}`).join('\n')}`);
    // Cheap: the last graph export plus each reviewed doc's frontmatter; never runs triage.
    const { is_reviewed, get_external_refs_status } = await import('../core/reconcile/ledger.js');
    // the graph lives at the docs' git top-level (write_graph), which can differ from where the command ran
    const { find_git_top: find_graph_top } = await import('../core/reconcile/triage.js');
    const graph_top = staged ? undefined : find_graph_top(docs_root);
    let graph_text: string | undefined;
    try {
      graph_text = graph_top ? await readFile(join(graph_top, '.hewtd', 'graph.json'), 'utf-8') : undefined;
    } catch { /* absent: the hint below says why */ }
    if (graph_text === undefined) {
      const { load_plugin_config: load_status_config } = await import('../utils/config.js');
      const why = staged ? 'a staged copy has no graph (the live .hewtd/graph.json describes the live tree)' : !graph_top ? 'the docs are not in a git checkout, so no graph is written'
        : !(await load_status_config(repo_root)).graph_export ? 'graph_export is off in the plugin config, so no graph is written'
        : 'no .hewtd/graph.json yet (run `hewtd index` to write it)';
      logger.info(`  refs in reviewed docs: ${why}`);
    }
    if (graph_text !== undefined) {
      try {
        const reviewed = docs.filter((doc) => is_reviewed(ledger.entries[doc.path], doc.hash)).map((doc) => doc.path);
        const frontmatters = Object.fromEntries(await Promise.all(reviewed.map(async (doc_path) => [doc_path, (await import('gray-matter')).default(await readFile(join(docs_root, doc_path), 'utf-8')).data])));
        const ref_status = get_external_refs_status(JSON.parse(graph_text), frontmatters, reviewed);
        logger.info(`  refs in reviewed docs: ${ref_status.covered} covered by external_refs, ${ref_status.still_missing} still missing in ${ref_status.docs_still_missing} doc(s)`);
      } catch (error) {
        logger.info(`  refs in reviewed docs: .hewtd/graph.json is malformed (${error instanceof Error ? error.message : String(error)}); run \`hewtd index\` to rewrite it`);
      }
    }
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
      const { load_plugin_config } = await import('../utils/config.js');
      const { resolve_git_top: project_root_of } = await import('../core/reconcile/outside.js');
      const { add_baseline, load_baseline, write_baseline: save_baseline, scan_file, BASELINE_PATH } = await import('../core/reconcile/secrets.js');
      const docs_root = resolve(process.cwd(), options.docsPath);
      const repo_root = project_root_of(docs_root);
      const config = await load_plugin_config(repo_root);
      const secrets_config = config.reconcile.secrets;
      if (options.staged) {
        const { scan_staged } = await import('../core/reconcile/hooks.js');
        const matches = scan_staged(repo_root, docs_root, secrets_config);
        if (!matches.length) return;
        logger.error(`commit refused: ${matches.length} added line(s) contain a secret (masked, first4…length):`);
        for (const file of matches.slice(0, 20)) logger.info(`  ${file.file}:${file.line} ${file.rule} ${file.masked} (${file.fingerprint.slice(0, 12)})`);
        logger.info('  rotate it, then move the value to .env.hewtd and leave a pointer (hewtd reconcile --secrets); a false positive: hewtd secrets --baseline-add <file:line> --reason "..."');
        process.exitCode = 1;
        return;
      }
      if (!options.baselineAdd && !options.baselinePrune) throw new Error('nothing to do: pass --baseline-add <file:line> --reason "..." or --baseline-prune');
      if (options.baselineAdd) {
        const match = /^(.+):(\d+)$/.exec(options.baselineAdd);
        if (!match) throw new Error('--baseline-add expects <file:line>');
        const file = relative(repo_root, resolve(process.cwd(), match[1]!)).split('\\').join('/');
        const text = await readFile(join(repo_root, file), 'utf-8');
        const added = await add_baseline(repo_root, file, text, parseInt(match[2]!, 10), options.reason ?? '', secrets_config);
        logger.header('hewtd secrets --baseline-add');
        for (const a of added) logger.info(`  baselined ${a.rule} ${a.file} ${a.masked} (${a.fingerprint.slice(0, 12)})`);
        if (!added.length) logger.info('  already baselined');
        // Hint only: .gitignore is the user's call.
        const { spawnSync: spawn_sync } = await import('child_process');
        // eslint-disable-next-line id-denylist -- glob/child_process option name
        if (spawn_sync('git', ['check-ignore', '-q', BASELINE_PATH], { cwd: repo_root }).status === 0) {
          logger.warn(`  ${BASELINE_PATH} is gitignored; to share it: git add -f ${BASELINE_PATH} (or add "!${BASELINE_PATH}" to .gitignore)`);
        }
      }
      if (options.baselinePrune) {
        const { scan_secrets } = await import('../core/reconcile/triage.js');
        const entries = await load_baseline(repo_root);
        // Scan with the baseline off, so a still-present value shows up.
        const bare = { ...config, reconcile: { ...config.reconcile, secrets: { ...secrets_config, allow: secrets_config.allow.filter((a) => !entries.some((entry) => entry.fingerprint === a.fingerprint)) } } };
        const seen = new Set((await scan_secrets({ root: repo_root, docs_root: docs_root, config: bare })).map((file) => file.fingerprint));
        for (const entry of entries) for (const file of await scan_file(join(repo_root, entry.file), entry.file, bare.reconcile.secrets)) seen.add(file.fingerprint);
        const kept = entries.filter((entry) => seen.has(entry.fingerprint));
        if (kept.length !== entries.length) await save_baseline(repo_root, kept);
        logger.header('hewtd secrets --baseline-prune');
        logger.info(`  removed ${entries.length - kept.length}, kept ${kept.length}`);
      }
    } catch (entry) {
      logger.error((entry as Error).message);
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
      const { resolve_git_top: project_root_of } = await import('../core/reconcile/outside.js');
      const { install_hook, uninstall_hook } = await import('../core/reconcile/hooks.js');
      const repo_root = project_root_of(resolve(process.cwd(), options.docsPath));
      const result = await (action === 'install' ? install_hook : uninstall_hook)(repo_root);
      logger.info(`${result.changed ? action + 'ed' : 'unchanged'}: ${relative(repo_root, result.path)}`);
    } catch (entry) {
      logger.error((entry as Error).message);
      process.exitCode = 1;
    }
  });

// Search command
program
  .command('search <query>')
  .description('Search documentation')
  .option('-p, --path <path>', 'Documentation path', '.documentation')
  .action(async (query, options) => {
    const docs_root = resolve(process.cwd(), options.path);
    const { find_markdown_files } = await import('../utils/glob.js');
    const { readFile: read_file } = await import('fs/promises');
    const { relative } = await import('path');

    logger.header(`Search: "${query}"`);

    const files = await find_markdown_files(docs_root);
    const results: { file: string; matches: number }[] = [];
    const search_regex = new RegExp(query, 'gi');

    for (const file of files) {
      try {
        const content = await read_file(file, 'utf-8');
        const matches = content.match(search_regex);
        if (matches) {
          results.push({
            file: relative(docs_root, file),
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

// Parse and execute (unless a test imports the program to read its commands)
if (!process.env.HEWTD_NO_PARSE) program.parse();
