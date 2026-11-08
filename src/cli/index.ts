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
import { create_scaffold, scaffold_exists } from '../generators/scaffold.js';
import { sync_metadata } from '../core/metadata/sync.js';
import { check_links } from '../core/links/checker.js';
import { check_documentation } from '../core/audit/auditor.js';
import { integrate_document } from '../core/integrate/integrator.js';
import { run_maintenance } from '../core/maintain/orchestrator.js';
import { discover_patterns } from '../core/discover/patterns.js';
import { discover_anti_patterns } from '../core/discover/antipatterns.js';
import { discover_standards } from '../core/discover/standards.js';
import { discover_dependencies } from '../core/discover/dependencies.js';
import { save_health_report } from '../reports/health-report.js';
import { save_audit_report } from '../reports/audit-report.js';
import { save_link_report } from '../reports/link-report.js';
import { type Domain } from '../core/domains/constants.js';
import {
  get_all_domains,
  get_registry,
  get_domain_definition,
  is_valid_domain,
} from '../core/domains/registry.js';
import { regenerate_indexes, generate_kb_indexes } from '../generators/regenerate.js';
import { stamp_reports } from '../generators/stamp-reports.js';
import { write_raw_config } from '../utils/config.js';
import { get_status_values } from '../core/metadata/status-registry.js';
import { resolve_docs_path } from '../utils/docs-root.js';

const program = new Command();

program
  .name('hit-em-with-the-docs')
  .description('Self-managing documentation system with hierarchical structure and intelligent automation')
  .version(pkg.version);

// Project root of the resolved docs path: the git root holding it, else its parent.
let project_root_dir = process.cwd();
function find_project_root(docs_path: string): string {
  let dir = dirname(docs_path);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(docs_path);
    dir = parent;
  }
}

// Every command except `init` finds the docs tree from a subdirectory when -p is the default,
// and loads the project's config (domains, statuses) from that project, not from the cwd.
program.hook('preAction', (_this, action) => {
  if (action.name() === 'init') return;
  let docs_path: string | undefined;
  for (const key of ['path', 'docsPath']) {
    if (action.getOptionValueSource(key) === undefined) continue;
    if (action.getOptionValueSource(key) === 'default') {
      action.setOptionValue(key, resolve_docs_path(process.cwd(), String(action.getOptionValue(key)), false));
    }
    docs_path = resolve(process.cwd(), String(action.getOptionValue(key)));
  }
  docs_path ??= resolve_docs_path(process.cwd(), '.documentation', false);
  project_root_dir = find_project_root(docs_path);
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
    const docs_path = resolve(process.cwd(), options.path);

    const existed = await scaffold_exists(docs_path);
    if (existed && !options.force) {
      logger.warn('Documentation structure already exists. Use --force to overwrite.');
      process.exit(1);
    }

    const result = await create_scaffold({
      root_path: docs_path,
      overwrite: options.force,
    });

    if (!result.success) {
      logger.error('Failed to initialize documentation');
      process.exit(1);
    }

    // New installs only: keep reports out of the searched docs tree. A re-init (--force) keeps
    // where reports already go, and an unreadable config is never overwritten.
    if (!existed) {
      const project_root = dirname(docs_path);
      let raw: Record<string, unknown> | null = {};
      try {
        raw = JSON.parse(await readFile(join(project_root, '.claude/hit-em-with-the-docs.json'), 'utf-8'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') raw = null;
      }
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        logger.warn('Could not parse .claude/hit-em-with-the-docs.json; left it alone (reports_dir not set).');
      } else if (raw.reports_dir === undefined) {
        await write_raw_config(project_root, { ...raw, reports_dir: '.hewtd/reports' });
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
    const docs_path = resolve(process.cwd(), options.path);

    const result = await run_maintenance({
      docs_path,
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
    const docs_path = resolve(process.cwd(), options.path);

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
          join(docs_path, domain, 'INDEX.md')
        );
      }
    }

    const result = await regenerate_indexes({
      docs_path,
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
    const kb = await generate_kb_indexes(docs_path, options.dryRun);
    const stamped = await stamp_reports(docs_path, options.dryRun);
    if (kb) {
      logger.info(
        `Knowledge base: ${kb.facts} facts, ${kb.incidents} incidents${options.dryRun ? ' (would rebuild indexes)' : ' (indexes rebuilt)'}`
      );
    }
    if (stamped.length > 0) {
      logger.info(`${options.dryRun ? 'Would stamp' : 'Stamped'} generated: true on ${stamped.length} report file(s)`);
      if (options.dryRun) for (const f of stamped) logger.info(`  ${f}`);
    }

    if (options.graph !== false) await export_graph(docs_path, options.dryRun);

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
async function export_graph(docs_path: string, dry_run: boolean): Promise<void> {
  try {
    const { load_plugin_config } = await import('../utils/config.js');
    const { resolve_git_top: project_root_of } = await import('../core/reconcile/outside.js');
    const { write_graph } = await import('../core/graph/export.js');
    const root = project_root_of(docs_path);
    const r = await write_graph({ root, docs_path, config: await load_plugin_config(root), dry_run });
    if (r.status === 'no-git') logger.info('Graph export skipped: not a git checkout.');
    else if (r.status === 'written') logger.info('Graph export written: .hewtd/graph.json');
    else if (r.status === 'would-write') logger.info('Would update .hewtd/graph.json');
    if (r.hint) logger.info('Tip: .hewtd/graph.json is not git-ignored; add it to .gitignore unless you want it committed.');
  } catch (e) {
    logger.warn(`Graph export failed: ${(e as Error).message}`);
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
    const docs_path = resolve(process.cwd(), options.path);

    const result = await sync_metadata({
      docs_path,
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
    const docs_path = resolve(process.cwd(), options.path);

    const result = await check_links({
      docs_path,
      domain: options.domain,
    });

    if (options.report) {
      const report_path = await save_link_report(docs_path, result);
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
    const docs_path = resolve(process.cwd(), options.path);

    const result = await check_documentation({
      docs_path,
      domain: options.domain,
      issues_only: options.issuesOnly,
      strict: options.strict,
    });

    if (options.report) {
      const report_path = await save_audit_report(docs_path, result);
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
    const docs_path = resolve(process.cwd(), options.path);
    const file_path = resolve(process.cwd(), file);

    const result = await integrate_document({
      file_path,
      docs_path,
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
    const docs_path = resolve(process.cwd(), options.path);

    switch (type) {
      case 'health': {
        const result = await run_maintenance({ docs_path, quick: true, silent: true });
        const report_path = await save_health_report(docs_path, result, options.format);
        logger.success(`Health report saved: ${report_path}`);
        break;
      }
      case 'audit': {
        const result = await check_documentation({ docs_path, silent: true });
        const report_path = await save_audit_report(docs_path, result, options.format);
        logger.success(`Audit report saved: ${report_path}`);
        break;
      }
      case 'links': {
        const result = await check_links({ docs_path, silent: true });
        const report_path = await save_link_report(docs_path, result, options.format);
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
    const rows = get_all_domains().map((d) => {
      const def = get_domain_definition(d);
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
    const { list_domains } = await import('../core/domains/manage.js');
    const result = list_domains(project_root_dir);

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
    const { add_domain } = await import('../core/domains/manage.js');
    const docs_path = resolve(process.cwd(), options.path);

    const title_case = (s: string) =>
      s.replace(/[-_]/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

    const spec = {
      id,
      name: options.name ?? title_case(id),
      description: options.description ?? `${title_case(id)} documentation`,
      keywords: options.keywords
        ? String(options.keywords)
            .split(',')
            .map((k: string) => k.trim())
            .filter(Boolean)
        : [],
      loadPriority: parseInt(options.loadPriority, 10),
      category: options.category,
    };

    const result = await add_domain({
      project_root: dirname(docs_path),
      docs_path,
      spec,
      dry_run: options.dryRun,
    });

    logger.header(`hewtd domain add: ${id}`);
    if (!result.ok) {
      for (const e of result.errors) logger.error(e);
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
    const docs_path = resolve(process.cwd(), options.path);

    const result = await remove_domain({
      project_root: dirname(docs_path),
      docs_path,
      id,
      dry_run: options.dryRun,
    });

    logger.header(`hewtd domain remove: ${id}`);
    if (!result.ok) {
      for (const e of result.errors) logger.error(e);
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
    const docs_path = resolve(process.cwd(), options.path);
    const result = await archive_doc({
      project_root: dirname(docs_path),
      docs_path,
      file,
      reason: options.reason,
      force: options.force,
      dry_run: options.dryRun,
    });

    logger.header(`hewtd archive: ${file}`);
    if (!result.ok) {
      for (const e of result.errors) logger.error(e);
      if (result.action === 'blocked' && result.inbound_links.length > 0) {
        logger.info('');
        logger.info('Active docs linking here (fix these or use --force):');
        for (const l of result.inbound_links) {
          logger.info(`  ${l.source}:${l.line_number}  "${l.link_text}"`);
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
      for (const l of result.inbound_links) logger.info(`  ${l.source}:${l.line_number}`);
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
    const docs_path = resolve(process.cwd(), options.path);
    const result = await unarchive_doc({
      project_root: dirname(docs_path),
      docs_path,
      file,
      dry_run: options.dryRun,
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
    const docs_path = resolve(process.cwd(), options.path);
    const config = await load_plugin_config(dirname(docs_path));

    const candidates = await find_archive_candidates({
      docs_path,
      project_root: dirname(docs_path),
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
  .action(async (fact_id, options) => {
    const project_root = project_root_dir;
    const { load_plugin_config, resolve_vault_root, resolve_playbook_globs } = await import(
      '../utils/config.js'
    );
    const { build_citer_index, find_citers_in_index } = await import(
      '../core/knowledge-base/citers.js'
    );

    const config = await load_plugin_config(project_root);
    const vault_root = resolve_vault_root(project_root, config);
    const playbook_globs = resolve_playbook_globs(project_root, config);

    const index = await build_citer_index({ project_root, vault_root, playbook_globs });
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
    const project_root = project_root_dir;
    const { load_plugin_config, resolve_vault_root, resolve_playbook_globs } = await import(
      '../utils/config.js'
    );
    const { build_citer_index } = await import('../core/knowledge-base/citers.js');
    const { check_facts: audit_facts, run_fact_verify } = await import('../core/knowledge-base/audit.js');

    const config = await load_plugin_config(project_root);
    const vault_root = resolve_vault_root(project_root, config);
    const playbook_globs = resolve_playbook_globs(project_root, config);
    const window = options.window
      ? parseInt(options.window, 10)
      : config.vault.audit_window_days;

    const index = await build_citer_index({ project_root, vault_root, playbook_globs });

    // --run-verify-all path (#39): one command for a periodic re-check.
    if (options.runVerifyAll) {
      const results = [];
      for (const fact of [...index.facts.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        const r = await run_fact_verify({ fact, vault_root });
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
    const project_root = project_root_dir;
    const flat_file_path = resolve(process.cwd(), flat_file);
    const { migrate_incident } = await import('../core/knowledge-base/migrate.js');
    const { load_plugin_config, resolve_vault_root } = await import('../utils/config.js');

    const config = await load_plugin_config(project_root);
    const vault_root = resolve_vault_root(project_root, config);

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
    const project_root = project_root_dir;
    const { fix_legacy_layout } = await import(
      '../core/knowledge-base/fix-legacy-layout.js'
    );
    const { load_plugin_config, resolve_vault_root } = await import(
      '../utils/config.js'
    );

    const config = await load_plugin_config(project_root);
    const vault_root = resolve_vault_root(project_root, config);

    const result = await fix_legacy_layout({
      vault_root,
      project_root,
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
      for (const m of result.moved) {
        logger.info(`  ${m.from} → ${m.to}`);
      }
    }

    if (result.rewritten_provenance.length > 0) {
      logger.info('');
      logger.info(`Rewrote ${result.rewritten_provenance.length} provenance reference${result.rewritten_provenance.length === 1 ? '' : 's'}:`);
      for (const r of result.rewritten_provenance) {
        logger.info(`  ${r.fact_path}: ${r.old_ref} → ${r.new_ref}`);
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
    const { fix_retrieval_fields } = await import('../core/metadata/fix-retrieval-fields.js');
    const result = await fix_retrieval_fields({
      docs_path: resolve(process.cwd(), options.docsPath),
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
    } catch (err) {
      logger.error(`--accept must be valid JSON: ${(err as Error).message}`);
      process.exit(1);
    }
    if (!Array.isArray(accept)) {
      logger.error('--accept must be a JSON array of FactSpec objects');
      process.exit(1);
    }

    const project_root = project_root_dir;
    const incident_folder = resolve(process.cwd(), incident_folder_arg);
    const { load_plugin_config, resolve_vault_root } = await import('../utils/config.js');
    const { extract_facts } = await import('../core/knowledge-base/extract.js');

    const config = await load_plugin_config(project_root);
    const vault_root = resolve_vault_root(project_root, config);

    // Trust the caller's JSON shape — the slash command produced it after
    // the user accepted proposals. Runtime errors surface naturally.
    const result = await extract_facts({
      incident_folder,
      vault_root,
      project_root,
      accept: accept as Parameters<typeof extract_facts>[0]['accept'],
      dry_run: options.dryRun,
    });

    logger.header(`hewtd extract-facts: ${result.incident_id}`);
    for (const f of result.extracted_facts) {
      const tag = f.action === 'created' ? '✓ created' : '· skipped (exists)';
      logger.info(`  ${tag}  ${f.fact_path}`);
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
  .option('--gaps <file>', 'Classify missed search queries (gaps.v1 file or one question per line) into user_phrase proposals, new-doc candidates and open questions; writes only .hewtd/reconcile/gaps-report-<date>.md', undefined)
  .action(async (scope: string[], options) => {
    const { load_plugin_config } = await import('../utils/config.js');
    const { load_ledger, get_ledger_status: ledger_status, compute_content_hash: hash_content } = await import('../core/reconcile/ledger.js');
    const { glob } = await import('../utils/glob.js');
    const { resolve_git_top: project_root_of } = await import('../core/reconcile/outside.js');
    const docs_path = resolve(process.cwd(), options.docsPath);
    // State (ledger, review files, config) lives at the project root, so a run from a subdirectory shares it.
    const root = project_root_of(docs_path);
    const config = await load_plugin_config(root);
    const ledger_file = resolve(root, config.reconcile.ledger_path);
    if (options.apply) {
      try {
        const { apply_reviews } = await import('../core/reconcile/apply.js');
        const res = await apply_reviews({
          root, docs_path, ledger: await load_ledger(ledger_file), ledger_file,
          files: (options.apply as string[]).map((f) => resolve(root, f)),
        });
        logger.header('hewtd reconcile --apply');
        for (const o of res.outcomes) logger.info(`  [${o.status}] ${o.path}${o.detail ? ` - ${o.detail}` : ''}`);
        if (res.commit) logger.info(`  committed ${res.commit}`);
        const n = (st: string) => res.outcomes.filter((o) => o.status === st).length;
        logger.info(`applied ${n('applied')}, stale ${n('stale')}, rejected ${n('rejected')}, error ${n('error')}`);
        if (n('error')) process.exitCode = 1;
        if (n('applied')) await export_graph(docs_path, false); // a rolled-back batch has no 'applied' outcome
        const after = await load_ledger(ledger_file);
        if (res.outcomes.some((o) => o.status === 'applied' && after.entries[o.path]?.env_names?.length)) {
          const { build_secrets_report, write_secrets_report } = await import('../core/reconcile/secrets-report.js');
          // Re-scan, so findings still pending stay in the report instead of being overwritten by the moved ones.
          const { scan_secrets } = await import('../core/reconcile/triage.js');
          const pending = await scan_secrets({ root, docs_path, config });
          const rep = await build_secrets_report({ root, docs_path, findings: pending, ledger: after, secrets_config: config.reconcile.secrets });
          logger.info(`  secrets report with next steps (rotate, then purge): ${relative(root, await write_secrets_report(root, rep.text))}`);
        }
      } catch (e) {
        logger.error((e as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    if (options.secrets) {
      try {
        const { scan_secrets } = await import('../core/reconcile/triage.js');
        const found = await scan_secrets({ root, docs_path, config, scope });
        const { build_secrets_report, write_secrets_report } = await import('../core/reconcile/secrets-report.js');
        const report = await build_secrets_report({ root, docs_path, findings: found, ledger: await load_ledger(ledger_file), secrets_config: config.reconcile.secrets });
        const report_file = relative(root, await write_secrets_report(root, report.text));
        if (options.json) { console.log(JSON.stringify(found, null, 2)); return; }
        logger.header('hewtd reconcile --secrets');
        for (const f of found) logger.info(`  [${f.kind}] ${f.rule} ${f.file}:${f.line} ${f.masked} (${f.fingerprint.slice(0, 12)})`);
        logger.info(`  ${found.length} finding(s)`);
        logger.info(`  report with next steps: ${report_file}`);
      } catch (e) {
        logger.error((e as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    if (options.gaps) {
      try {
        const { readFile: read_file } = await import('fs/promises');
        const { parse_gaps, classify_gaps } = await import('../core/reconcile/gaps.js');
        const { render_gaps_report, write_gaps_report } = await import('../core/reconcile/gaps-report.js');
        const read = parse_gaps(await read_file(resolve(process.cwd(), options.gaps), 'utf-8'), { docs_root: docs_path, repo_root: root });
        const res = await classify_gaps(read.gaps, { root, docs_root: docs_path, config });
        const report_file = relative(root, await write_gaps_report(root, render_gaps_report(res, config.reconcile.secrets)));
        const review_file = options.writeReview ? await (await import('../core/reconcile/review.js')).write_gaps_review({ root, docs_path, proposals: res.proposals, batch: options.batch }) : undefined;
        if (options.json) { console.log(JSON.stringify({ ...res, errors: read.errors, report: report_file, ...(review_file && { review: relative(root, review_file) }) }, null, 2)); return; }
        logger.header('hewtd reconcile --gaps');
        for (const e of read.errors) logger.warn(`  ${e}`);
        logger.info(`  ${res.proposals.length} doc(s) with phrase proposals (${res.proposals.reduce((n, p) => n + p.accepted.length, 0)} phrases), ${res.candidates.length} new-doc candidate(s), ${res.questions.length} open question(s), ${res.dropped.length} dropped`);
        logger.info(`  report: ${report_file}`);
        if (review_file) logger.info(`  wrote ${relative(root, review_file)}`);
      } catch (e) {
        logger.error((e as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    if (options.overview && options.writeReview) {
      try {
        const { write_overview_review } = await import('../core/reconcile/overview.js');
        logger.info(`  wrote ${relative(root, await write_overview_review({ root, docs_path, members_file: resolve(root, options.overview), batch: options.batch }))}`);
      } catch (e) {
        logger.error((e as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    if (options.overview) {
      try {
        const { load_overview_seed: seed_overview, write_members_file } = await import('../core/reconcile/overview.js');
        const seed = await seed_overview({
          docs_path, config, ledger: await load_ledger(ledger_file), question: options.overview,
          limit: options.limit ? parseInt(options.limit, 10) || undefined : undefined,
        });
        const file = relative(root, await write_members_file(root, seed));
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
        const { discover_outside, write_outside_review } = await import('../core/reconcile/outside.js');
        const docs = await discover_outside(docs_path, (await load_plugin_config(project_root_of(docs_path))).reconcile.keep_in_place);
        if (options.writeReview) logger.info(`  wrote ${relative(root, await write_outside_review({ docs_path, root, docs, batch: options.batch }))}`);
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
      const { resolve_scope, find_dirty_in_scope: dirty_in_scope, triage_docs: triage } = await import('../core/reconcile/triage.js');
      const { write_ledger: save_ledger } = await import('../core/reconcile/ledger.js');
      try {
        if (options.serial && options.team) throw new Error('--serial and --team are mutually exclusive');
        const ledger = await load_ledger(ledger_file);
        const next = options.next ? parseInt(options.next, 10) || undefined : undefined;
        const rels = await resolve_scope(docs_path, scope, { ...(next && { next }), ledger });
        const dirty = dirty_in_scope(docs_path, rels);
        if (dirty.length) {
          throw new Error(`Refusing to start: uncommitted changes in scope (commit or stash first):\n${dirty.map((d) => `  ${d}`).join('\n')}`);
        }
        const result = await triage({
          root, docs_path, rels, config, ledger,
          ...((options.serial && { mode: 'serial' }) || (options.team && { mode: 'team' }) || {}),
        });
        await save_ledger(ledger_file, ledger);
        if (options.writeReview) {
          const { write_review_skeletons } = await import('../core/reconcile/review.js');
          const files = await write_review_skeletons({ root, docs_path, triage: result, scope: scope.join(' ') || `next ${options.next}`, batch: options.batch });
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
    const files = (await glob('**/*.md', { cwd: docs_path, ignore: ['archive/**', '**/INDEX.md', '**/REGISTRY.md'] })).sort();
    const docs = await Promise.all(
      files.map(async (f) => ({ path: f, hash: hash_content(await readFile(join(docs_path, f), 'utf-8')) }))
    );
    const ledger = await load_ledger(ledger_file);
    const st = ledger_status(ledger, docs, parseInt(options.next ?? '10', 10) || 10);
    logger.header('hewtd reconcile --status');
    logger.info(`  reviewed ${st.reviewed} of ${st.total}`);
    for (const [k, v] of Object.entries(st.by_lane)) logger.info(`  lane ${k}: ${v}`);
    for (const [k, v] of Object.entries(st.by_verdict)) logger.info(`  verdict ${k}: ${v}`);
    if (st.next_unreviewed.length) logger.info(`  next unreviewed:\n${st.next_unreviewed.map((p) => `    ${p}`).join('\n')}`);
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
      const docs_path = resolve(process.cwd(), options.docsPath);
      const root = project_root_of(docs_path);
      const config = await load_plugin_config(root);
      const cfg = config.reconcile.secrets;
      if (options.staged) {
        const { scan_staged } = await import('../core/reconcile/hooks.js');
        const hits = scan_staged(root, docs_path, cfg);
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
        const added = await add_baseline(root, file, text, parseInt(m[2]!, 10), options.reason ?? '', cfg);
        logger.header('hewtd secrets --baseline-add');
        for (const a of added) logger.info(`  baselined ${a.rule} ${a.file} ${a.masked} (${a.fingerprint.slice(0, 12)})`);
        if (!added.length) logger.info('  already baselined');
        // Hint only: .gitignore is the user's call.
        const { spawnSync: spawn_sync } = await import('child_process');
        if (spawn_sync('git', ['check-ignore', '-q', BASELINE_PATH], { cwd: root }).status === 0) {
          logger.warn(`  ${BASELINE_PATH} is gitignored; to share it: git add -f ${BASELINE_PATH} (or add "!${BASELINE_PATH}" to .gitignore)`);
        }
      }
      if (options.baselinePrune) {
        const { scan_secrets } = await import('../core/reconcile/triage.js');
        const entries = await load_baseline(root);
        // Scan with the baseline off, so a still-present value shows up.
        const bare = { ...config, reconcile: { ...config.reconcile, secrets: { ...cfg, allow: cfg.allow.filter((a) => !entries.some((e) => e.fingerprint === a.fingerprint)) } } };
        const seen = new Set((await scan_secrets({ root, docs_path, config: bare })).map((f) => f.fingerprint));
        for (const e of entries) for (const f of await scan_file(join(root, e.file), e.file, bare.reconcile.secrets)) seen.add(f.fingerprint);
        const kept = entries.filter((e) => seen.has(e.fingerprint));
        if (kept.length !== entries.length) await save_baseline(root, kept);
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
      const { resolve_git_top: project_root_of } = await import('../core/reconcile/outside.js');
      const { install_hook, uninstall_hook } = await import('../core/reconcile/hooks.js');
      const root = project_root_of(resolve(process.cwd(), options.docsPath));
      const r = await (action === 'install' ? install_hook : uninstall_hook)(root);
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
    const docs_path = resolve(process.cwd(), options.path);
    const { find_markdown_files } = await import('../utils/glob.js');
    const { readFile: read_file } = await import('fs/promises');
    const { relative } = await import('path');

    logger.header(`Search: "${query}"`);

    const files = await find_markdown_files(docs_path);
    const results: { file: string; matches: number }[] = [];
    const search_regex = new RegExp(query, 'gi');

    for (const file of files) {
      try {
        const content = await read_file(file, 'utf-8');
        const matches = content.match(search_regex);
        if (matches) {
          results.push({
            file: relative(docs_path, file),
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
