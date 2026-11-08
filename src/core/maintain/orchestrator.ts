import { dirname, join } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import { logger } from '../../utils/logger.js';
import { is_path_present, find_markdown_files } from '../../utils/glob.js';
import { load_retrieval_docs, compute_retrieval_coverage, type RetrievalCoverage } from '../audit/retrieval.js';
import { find_clusters } from '../links/clusters.js';
import { add_overview_backlinks, type BacklinkChange } from '../links/backlinks.js';
import { sync_metadata, type SyncResult } from '../metadata/sync.js';
import { check_links, type LinkCheckResult } from '../links/checker.js';
import { check_documentation, type AuditResult } from '../audit/auditor.js';
import { get_all_domains } from '../domains/registry.js';
import { format_date } from '../metadata/generator.js';
import { load_plugin_config, resolve_reports_dir } from '../../utils/config.js';
import {
  regenerate_indexes,
  generate_knowledge_base_indexes,
  type RegenerateResult,
} from '../../generators/regenerate.js';

export interface MaintainOptions {
  docs_root: string;
  quick?: boolean;
  fix?: boolean;
  silent?: boolean;
}

export interface MaintainResult {
  success: boolean;
  domain_health: DomainHealthResult;
  metadata_sync?: SyncResult;
  index_regeneration?: RegenerateResult;
  link_check?: LinkCheckResult;
  audit?: AuditResult;
  retrieval_coverage?: RetrievalCoverage;
  overview_coverage?: OverviewCoverage;
  /** Back-links added under --fix, or that would be added without it. */
  overview_backlinks?: BacklinkChange[];
  health_score: number;
  report_path?: string;
  errors: string[];
}

export interface OverviewCoverage {
  withOverview: number;
  withoutOverview: number;
  missing: Array<{ id: string; size: number; generatedOnlyHub: boolean }>;
}

export interface DomainHealthResult {
  healthy: boolean;
  presentDomains: string[];
  missingDomains: string[];
  missingIndexes: string[];
  missingRegistries: string[];
}

/**
 * Run full maintenance on documentation
 */
export async function run_maintenance(options: MaintainOptions): Promise<MaintainResult> {
  const {
    docs_root: docs_root,
    quick = false,
    fix = false,
    silent = false,
  } = options;

  const result: MaintainResult = {
    success: true,
    domain_health: {
      healthy: true,
      presentDomains: [],
      missingDomains: [],
      missingIndexes: [],
      missingRegistries: [],
    },
    health_score: 0,
    errors: [],
  };

  const start_time = Date.now();

  if (!silent) {
    logger.header('Documentation Maintenance');
    logger.info(`Mode: ${quick ? 'Quick' : 'Full'}${fix ? ' (Auto-fix)' : ''}`);
    logger.info(`Path: ${docs_root}`);
  }

  // Step 0: Domain Health Check
  if (!silent) {
    logger.subheader('Step 0: Domain Health Check');
  }

  result.domain_health = await check_domain_health(docs_root);

  if (!silent) {
    if (result.domain_health.healthy) {
      logger.success(`All ${result.domain_health.presentDomains.length} domains healthy`);
    } else {
      logger.warn(`Domain issues found:`);
      if (result.domain_health.missingDomains.length > 0) {
        logger.warn(`  Missing domains: ${result.domain_health.missingDomains.join(', ')}`);
      }
      if (result.domain_health.missingIndexes.length > 0) {
        logger.warn(`  Missing INDEX.md: ${result.domain_health.missingIndexes.join(', ')}`);
      }
      if (result.domain_health.missingRegistries.length > 0) {
        logger.warn(`  Missing REGISTRY.md: ${result.domain_health.missingRegistries.join(', ')}`);
      }
    }
  }

  // Overview back-links (#51): body edits, so only written under --fix; always listed.
  // Runs before metadata sync so word_count/read-time and the indexes see the edit in the same run.
  try {
    const config = await load_plugin_config(dirname(docs_root));
    if (config.overview.backlinks) {
      result.overview_backlinks = await add_overview_backlinks(docs_root, { dry_run: !fix });
    }
  } catch (error) {
    result.errors.push(`Overview back-links failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Step 1: Metadata Sync
  if (!silent) {
    logger.subheader('Step 1: Metadata Sync');
  }

  try {
    result.metadata_sync = await sync_metadata({
      docs_root: docs_root,
      dry_run: !fix,
      fix,
      silent,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(`Metadata sync failed: ${message}`);
    result.success = false;
  }

  // Step 1.5: Index Regeneration
  //
  // Domain and root INDEX.md/REGISTRY.md are derived artifacts — they are
  // rebuilt from the documents on disk on every maintain run so they never
  // drift from reality. This also self-heals any INDEX.md/REGISTRY.md that
  // checkDomainHealth reported as missing. Runs in quick mode too: it is
  // cheap and is the core "self-managing" guarantee.
  if (!silent) {
    logger.subheader('Step 1.5: Index Regeneration');
  }

  try {
    result.index_regeneration = await regenerate_indexes({ docs_root: docs_root, silent });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(`Index regeneration failed: ${message}`);
  }

  // Step 1.6: Knowledge-base indexes (2.3.0+) — only when a vault root exists.
  // Backward-compat hard requirement: a project with no knowledge-base/ subtree must
  // observe zero behavior change vs. 2.2.0.
  //
  // MUST run BEFORE the link check. This used to be "Step 3.5", after it, so the checker
  // read the PREVIOUS run's symptoms/INDEX.md: two consecutive `maintain` runs on identical
  // inputs reported different broken-link counts, and a generator fix appeared not to work
  // until you ran maintain twice. Generated output has to exist before anything validates it.
  try {
    await ensure_knowledge_base_indexes(docs_root, silent, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(`Knowledge-base index generation failed: ${message}`);
  }

  // Step 2: Link Check (skip in quick mode)
  if (!quick) {
    if (!silent) {
      logger.subheader('Step 2: Link Check');
    }

    try {
      result.link_check = await check_links({
        docs_root: docs_root,
        silent,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Link check failed: ${message}`);
    }
  } else if (!silent) {
    logger.info('Step 2: Link Check (SKIPPED - quick mode)');
  }

  // Step 3: Documentation Audit
  if (!silent) {
    logger.subheader('Step 3: Documentation Audit');
  }

  try {
    result.audit = await check_documentation({
      docs_root: docs_root,
      silent,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(`Audit failed: ${message}`);
  }

  // Retrieval coverage (#50): shown in the health report only, not part of the score.
  try {
    const docs = await load_retrieval_docs(docs_root, await find_markdown_files(docs_root));
    const config = await load_plugin_config(dirname(docs_root));
    result.retrieval_coverage = compute_retrieval_coverage(docs, config.retrieval);
  } catch (error) {
    result.errors.push(`Retrieval coverage failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Overview coverage (#51): clusters with and without an overview.
  try {
    const config = await load_plugin_config(dirname(docs_root));
    const clusters = await find_clusters(docs_root, config.overview);
    const missing = clusters.filter((cluster) => !cluster.overview);
    result.overview_coverage = {
      withOverview: clusters.length - missing.length,
      withoutOverview: missing.length,
      missing: missing.map((cluster) => ({ id: cluster.id, size: cluster.members.length, generatedOnlyHub: cluster.generated_only_hub })),
    };
  } catch (error) {
    result.errors.push(`Overview coverage failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Calculate overall health score
  result.health_score = compute_health_score(result);

  // Generate report
  if (!silent) {
    logger.subheader('Step 4: Generate Report');
  }

  try {
    result.report_path = await write_maintenance_report(docs_root, result, start_time);
    if (!silent) {
      logger.success(`Report saved: ${result.report_path}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(`Report generation failed: ${message}`);
  }

  // Summary
  if (!silent) {
    const duration = ((Date.now() - start_time) / 1000).toFixed(1);
    logger.newline();
    logger.header('Maintenance Summary');
    logger.info(`Duration: ${duration}s`);
    logger.info(`Health Score: ${result.health_score.toFixed(1)}/100`);

    if (result.metadata_sync) {
      logger.info(`Files: ${result.metadata_sync.total_files}`);
      if (fix) {
        logger.info(`Fixed: ${result.metadata_sync.fixed_files}`);
      }
    }

    if (result.link_check) {
      logger.info(`Links: ${result.link_check.total_links} (${result.link_check.broken_links.length} broken)`);
    }

    if (result.audit) {
      const errors = result.audit.issues.filter((i) => i.severity === 'error').length;
      const warnings = result.audit.issues.filter((i) => i.severity === 'warning').length;
      logger.info(`Issues: ${errors} errors, ${warnings} warnings`);
    }

    if (result.errors.length > 0) {
      logger.warn(`Errors: ${result.errors.length}`);
    }
  }

  return result;
}

/**
 * Check domain health (folders, index files, registry files)
 */
async function check_domain_health(docs_root: string): Promise<DomainHealthResult> {
  const result: DomainHealthResult = {
    healthy: true,
    presentDomains: [],
    missingDomains: [],
    missingIndexes: [],
    missingRegistries: [],
  };

  for (const domain of get_all_domains()) {
    const domain_path = join(docs_root, domain);
    const index_path = join(domain_path, 'INDEX.md');
    const registry_path = join(domain_path, 'REGISTRY.md');

    const domain_exists = await is_path_present(domain_path);
    const index_exists = await is_path_present(index_path);
    const registry_exists = await is_path_present(registry_path);

    if (!domain_exists) {
      result.missingDomains.push(domain);
      result.healthy = false;
    } else {
      result.presentDomains.push(domain);

      if (!index_exists) {
        result.missingIndexes.push(domain);
        result.healthy = false;
      }

      if (!registry_exists) {
        result.missingRegistries.push(domain);
        result.healthy = false;
      }
    }
  }

  return result;
}

/**
 * Calculate overall health score
 */
function compute_health_score(result: MaintainResult): number {
  let score = 100;

  // Domain health penalty
  if (!result.domain_health.healthy) {
    const missing_count =
      result.domain_health.missingDomains.length +
      result.domain_health.missingIndexes.length +
      result.domain_health.missingRegistries.length;
    score -= missing_count * 2;
  }

  // Metadata compliance
  if (result.metadata_sync) {
    const compliance_rate = result.metadata_sync.valid_files / result.metadata_sync.total_files;
    score = score * 0.7 + compliance_rate * 30;
  }

  // Link health
  if (result.link_check) {
    const broken_rate = result.link_check.broken_links.length / Math.max(result.link_check.total_links, 1);
    score -= broken_rate * 20;
  }

  // Audit score
  if (result.audit) {
    score = score * 0.7 + result.audit.health_score * 0.3;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Generate maintenance report
 */
async function write_maintenance_report(
  docs_root: string,
  result: MaintainResult,
  start_time: number
): Promise<string> {
  const now = format_date(new Date());
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const duration = ((Date.now() - start_time) / 1000).toFixed(1);

  let content = `---
title: Maintenance Report - ${now}
tier: admin
domains: [root]
status: active
last_updated: '${now}'
version: '1.0.0'
generated: true
---

# Maintenance Report

**Generated:** ${new Date().toISOString()}
**Duration:** ${duration}s
**Health Score:** ${result.health_score.toFixed(1)}/100

## Summary

| Metric | Value |
|--------|-------|
| Overall Health | ${result.health_score.toFixed(1)}% |
| Domain Health | ${result.domain_health.healthy ? 'Healthy' : 'Issues Found'} |
| Indexes Regenerated | ${result.index_regeneration?.files_written.length ?? 0} files |
| Files Scanned | ${result.metadata_sync?.total_files ?? 0} |
| Valid Files | ${result.metadata_sync?.valid_files ?? 0} |
| Broken Links | ${result.link_check?.broken_links.length ?? 'Not checked'} |
| Audit Issues | ${result.audit?.issues.length ?? 0} |

## Domain Health

`;

  if (result.domain_health.healthy) {
    content += `All ${result.domain_health.presentDomains.length} domains are healthy.\n\n`;
  } else {
    if (result.domain_health.missingDomains.length > 0) {
      content += `### Missing Domains\n\n`;
      content += result.domain_health.missingDomains.map((missing_domain) => `- ${missing_domain}`).join('\n');
      content += '\n\n';
    }

    if (result.domain_health.missingIndexes.length > 0) {
      content += `### Missing INDEX.md Files\n\n`;
      content += result.domain_health.missingIndexes.map((missing_index) => `- ${missing_index}/INDEX.md`).join('\n');
      content += '\n\n';
    }

    if (result.domain_health.missingRegistries.length > 0) {
      content += `### Missing REGISTRY.md Files\n\n`;
      content += result.domain_health.missingRegistries.map((missing_registry) => `- ${missing_registry}/REGISTRY.md`).join('\n');
      content += '\n\n';
    }
  }

  if (result.metadata_sync) {
    content += `## Metadata Sync

| Metric | Value |
|--------|-------|
| Total Files | ${result.metadata_sync.total_files} |
| Valid | ${result.metadata_sync.valid_files} |
| Fixed | ${result.metadata_sync.fixed_files} |
| Errors | ${result.metadata_sync.errors.length} |
| Avg Completeness | ${result.metadata_sync.stats.avg_completeness.toFixed(1)}% |

`;
  }

  if (result.link_check) {
    content += `## Link Check

| Metric | Value |
|--------|-------|
| Total Links | ${result.link_check.total_links} |
| Valid Links | ${result.link_check.valid_links} |
| Broken Links | ${result.link_check.broken_links.length} |
| Cross-Domain | ${result.link_check.stats.crossDomainLinks} |

`;

    if (result.link_check.broken_links.length > 0) {
      content += `### Broken Links\n\n`;
      content += `| File | Target | Line |\n`;
      content += `|------|--------|------|\n`;
      for (const link of result.link_check.broken_links.slice(0, 20)) {
        content += `| ${link.sourceFile} | ${link.targetPath} | ${link.lineNumber} |\n`;
      }
      if (result.link_check.broken_links.length > 20) {
        content += `\n*...and ${result.link_check.broken_links.length - 20} more*\n`;
      }
      content += '\n';
    }
  }

  if (result.audit) {
    content += `## Audit Results

| Metric | Value |
|--------|-------|
| Passed Files | ${result.audit.passed_files} |
| Failed Files | ${result.audit.failed_files} |
| Health Score | ${result.audit.health_score.toFixed(1)}% |
| Metadata Compliance | ${result.audit.stats.metadataCompliance.toFixed(1)}% |
| Naming Compliance | ${result.audit.stats.namingCompliance.toFixed(1)}% |

`;

    const error_issues = result.audit.issues.filter((i) => i.severity === 'error');
    if (error_issues.length > 0) {
      content += `### Critical Issues\n\n`;
      for (const issue of error_issues.slice(0, 10)) {
        content += `- **${issue.file}**: ${issue.message}\n`;
      }
      if (error_issues.length > 10) {
        content += `\n*...and ${error_issues.length - 10} more errors*\n`;
      }
      content += '\n';
    }
  }

  if (result.errors.length > 0) {
    content += `## Errors

`;
    for (const error of result.errors) {
      content += `- ${error}\n`;
    }
  }

  content += `
---

*Generated by hit-em-with-the-docs*
`;

  // Save report
  const reports_dir = await resolve_reports_dir(docs_root);
  if (!(await is_path_present(reports_dir))) {
    await mkdir(reports_dir, { recursive: true });
  }

  const report_path = join(reports_dir, `maintenance-${timestamp}.md`);
  await writeFile(report_path, content, 'utf-8');

  return report_path;
}

/**
 * Generate the three knowledge-base indexes when a vault root exists.
 * No-op (silent) when the vault root doesn't exist — backward-compat hard
 * requirement: a 2.2.0-era project tree must observe zero behavior change.
 */
async function ensure_knowledge_base_indexes(
  docs_root: string,
  silent: boolean,
  result: MaintainResult
): Promise<void> {
  const knowledge_base_indexes = await generate_knowledge_base_indexes(docs_root);
  if (!knowledge_base_indexes) return;

  if (!silent) {
    logger.subheader('Step 3.5: Knowledge-base Indexes');
    logger.success(`Generated ${knowledge_base_indexes.facts} facts → ${knowledge_base_indexes.facts_path}`);
    logger.success(`Generated ${knowledge_base_indexes.incidents} incidents → ${knowledge_base_indexes.incidents_path}`);
    logger.success(`Generated symptoms index → ${knowledge_base_indexes.symptoms_path}`);
  }

  // Suppress unused-var: result is part of the signature for future use
  // (e.g. surfacing KB stats into the maintenance report).
  void result;
}

/**
 * Quick health check without full maintenance
 */
export async function check_quick_health(docs_root: string): Promise<{
  healthy: boolean;
  score: number;
  issues: string[];
}> {
  const domain_health = await check_domain_health(docs_root);
  const issues: string[] = [];

  if (!domain_health.healthy) {
    if (domain_health.missingDomains.length > 0) {
      issues.push(`Missing domains: ${domain_health.missingDomains.join(', ')}`);
    }
    if (domain_health.missingIndexes.length > 0) {
      issues.push(`Missing INDEX.md in: ${domain_health.missingIndexes.join(', ')}`);
    }
  }

  const score = domain_health.healthy ? 100 : 100 - issues.length * 10;

  return {
    healthy: issues.length === 0,
    score: Math.max(0, score),
    issues,
  };
}
