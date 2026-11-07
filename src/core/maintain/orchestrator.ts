import { dirname, join } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import { logger } from '../../utils/logger.js';
import { pathExists, findMarkdownFiles } from '../../utils/glob.js';
import { collectRetrievalDocs, retrievalCoverage, type RetrievalCoverage } from '../audit/retrieval.js';
import { findClusters } from '../links/clusters.js';
import { addOverviewBacklinks, type BacklinkChange } from '../links/backlinks.js';
import { syncMetadata, type SyncResult } from '../metadata/sync.js';
import { checkLinks, type LinkCheckResult } from '../links/checker.js';
import { auditDocumentation, type AuditResult } from '../audit/auditor.js';
import { getAllDomains } from '../domains/registry.js';
import { formatDate } from '../metadata/generator.js';
import {
  loadPluginConfig,
  resolveVaultRoot,
  resolveReportsDir,
  resolvePlaybookGlobs,
} from '../../utils/config.js';
import { buildCiterIndex } from '../knowledge-base/citers.js';
import { generateFactsIndex } from '../../generators/facts-index.js';
import { generateIncidentsIndex } from '../../generators/incidents-index.js';
import { generateSymptomsIndex } from '../../generators/symptoms-index.js';
import {
  regenerateIndexes,
  type RegenerateResult,
} from '../../generators/regenerate.js';

export interface MaintainOptions {
  docsPath: string;
  quick?: boolean;
  fix?: boolean;
  silent?: boolean;
}

export interface MaintainResult {
  success: boolean;
  domainHealth: DomainHealthResult;
  metadataSync?: SyncResult;
  indexRegeneration?: RegenerateResult;
  linkCheck?: LinkCheckResult;
  audit?: AuditResult;
  retrievalCoverage?: RetrievalCoverage;
  overviewCoverage?: OverviewCoverage;
  /** Back-links added under --fix, or that would be added without it. */
  overviewBacklinks?: BacklinkChange[];
  healthScore: number;
  reportPath?: string;
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
export async function runMaintenance(options: MaintainOptions): Promise<MaintainResult> {
  const {
    docsPath,
    quick = false,
    fix = false,
    silent = false,
  } = options;

  const result: MaintainResult = {
    success: true,
    domainHealth: {
      healthy: true,
      presentDomains: [],
      missingDomains: [],
      missingIndexes: [],
      missingRegistries: [],
    },
    healthScore: 0,
    errors: [],
  };

  const startTime = Date.now();

  if (!silent) {
    logger.header('Documentation Maintenance');
    logger.info(`Mode: ${quick ? 'Quick' : 'Full'}${fix ? ' (Auto-fix)' : ''}`);
    logger.info(`Path: ${docsPath}`);
  }

  // Step 0: Domain Health Check
  if (!silent) {
    logger.subheader('Step 0: Domain Health Check');
  }

  result.domainHealth = await checkDomainHealth(docsPath);

  if (!silent) {
    if (result.domainHealth.healthy) {
      logger.success(`All ${result.domainHealth.presentDomains.length} domains healthy`);
    } else {
      logger.warn(`Domain issues found:`);
      if (result.domainHealth.missingDomains.length > 0) {
        logger.warn(`  Missing domains: ${result.domainHealth.missingDomains.join(', ')}`);
      }
      if (result.domainHealth.missingIndexes.length > 0) {
        logger.warn(`  Missing INDEX.md: ${result.domainHealth.missingIndexes.join(', ')}`);
      }
      if (result.domainHealth.missingRegistries.length > 0) {
        logger.warn(`  Missing REGISTRY.md: ${result.domainHealth.missingRegistries.join(', ')}`);
      }
    }
  }

  // Overview back-links (#51): body edits, so only written under --fix; always listed.
  // Runs before metadata sync so word_count/read-time and the indexes see the edit in the same run.
  try {
    const cfg = await loadPluginConfig(dirname(docsPath));
    if (cfg.overview.backlinks) {
      result.overviewBacklinks = await addOverviewBacklinks(docsPath, { dryRun: !fix });
    }
  } catch (error) {
    result.errors.push(`Overview back-links failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Step 1: Metadata Sync
  if (!silent) {
    logger.subheader('Step 1: Metadata Sync');
  }

  try {
    result.metadataSync = await syncMetadata({
      docsPath,
      dryRun: !fix,
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
    result.indexRegeneration = await regenerateIndexes({ docsPath, silent });
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
    await maybeGenerateKbIndexes(docsPath, silent, result);
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
      result.linkCheck = await checkLinks({
        docsPath,
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
    result.audit = await auditDocumentation({
      docsPath,
      silent,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(`Audit failed: ${message}`);
  }

  // Retrieval coverage (#50): shown in the health report only, not part of the score.
  try {
    const docs = await collectRetrievalDocs(docsPath, await findMarkdownFiles(docsPath));
    const cfg = await loadPluginConfig(dirname(docsPath));
    result.retrievalCoverage = retrievalCoverage(docs, cfg.retrieval);
  } catch (error) {
    result.errors.push(`Retrieval coverage failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Overview coverage (#51): clusters with and without an overview.
  try {
    const cfg = await loadPluginConfig(dirname(docsPath));
    const clusters = await findClusters(docsPath, cfg.overview);
    const missing = clusters.filter((c) => !c.overview);
    result.overviewCoverage = {
      withOverview: clusters.length - missing.length,
      withoutOverview: missing.length,
      missing: missing.map((c) => ({ id: c.id, size: c.members.length, generatedOnlyHub: c.generatedOnlyHub })),
    };
  } catch (error) {
    result.errors.push(`Overview coverage failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Calculate overall health score
  result.healthScore = calculateHealthScore(result);

  // Generate report
  if (!silent) {
    logger.subheader('Step 4: Generate Report');
  }

  try {
    result.reportPath = await generateMaintenanceReport(docsPath, result, startTime);
    if (!silent) {
      logger.success(`Report saved: ${result.reportPath}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(`Report generation failed: ${message}`);
  }

  // Summary
  if (!silent) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.newline();
    logger.header('Maintenance Summary');
    logger.info(`Duration: ${duration}s`);
    logger.info(`Health Score: ${result.healthScore.toFixed(1)}/100`);

    if (result.metadataSync) {
      logger.info(`Files: ${result.metadataSync.totalFiles}`);
      if (fix) {
        logger.info(`Fixed: ${result.metadataSync.fixedFiles}`);
      }
    }

    if (result.linkCheck) {
      logger.info(`Links: ${result.linkCheck.totalLinks} (${result.linkCheck.brokenLinks.length} broken)`);
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
async function checkDomainHealth(docsPath: string): Promise<DomainHealthResult> {
  const result: DomainHealthResult = {
    healthy: true,
    presentDomains: [],
    missingDomains: [],
    missingIndexes: [],
    missingRegistries: [],
  };

  for (const domain of getAllDomains()) {
    const domainPath = join(docsPath, domain);
    const indexPath = join(domainPath, 'INDEX.md');
    const registryPath = join(domainPath, 'REGISTRY.md');

    const domainExists = await pathExists(domainPath);
    const indexExists = await pathExists(indexPath);
    const registryExists = await pathExists(registryPath);

    if (!domainExists) {
      result.missingDomains.push(domain);
      result.healthy = false;
    } else {
      result.presentDomains.push(domain);

      if (!indexExists) {
        result.missingIndexes.push(domain);
        result.healthy = false;
      }

      if (!registryExists) {
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
function calculateHealthScore(result: MaintainResult): number {
  let score = 100;

  // Domain health penalty
  if (!result.domainHealth.healthy) {
    const missingCount =
      result.domainHealth.missingDomains.length +
      result.domainHealth.missingIndexes.length +
      result.domainHealth.missingRegistries.length;
    score -= missingCount * 2;
  }

  // Metadata compliance
  if (result.metadataSync) {
    const complianceRate = result.metadataSync.validFiles / result.metadataSync.totalFiles;
    score = score * 0.7 + complianceRate * 30;
  }

  // Link health
  if (result.linkCheck) {
    const brokenRate = result.linkCheck.brokenLinks.length / Math.max(result.linkCheck.totalLinks, 1);
    score -= brokenRate * 20;
  }

  // Audit score
  if (result.audit) {
    score = score * 0.7 + result.audit.healthScore * 0.3;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Generate maintenance report
 */
async function generateMaintenanceReport(
  docsPath: string,
  result: MaintainResult,
  startTime: number
): Promise<string> {
  const now = formatDate(new Date());
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

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
**Health Score:** ${result.healthScore.toFixed(1)}/100

## Summary

| Metric | Value |
|--------|-------|
| Overall Health | ${result.healthScore.toFixed(1)}% |
| Domain Health | ${result.domainHealth.healthy ? 'Healthy' : 'Issues Found'} |
| Indexes Regenerated | ${result.indexRegeneration?.filesWritten.length ?? 0} files |
| Files Scanned | ${result.metadataSync?.totalFiles ?? 0} |
| Valid Files | ${result.metadataSync?.validFiles ?? 0} |
| Broken Links | ${result.linkCheck?.brokenLinks.length ?? 'Not checked'} |
| Audit Issues | ${result.audit?.issues.length ?? 0} |

## Domain Health

`;

  if (result.domainHealth.healthy) {
    content += `All ${result.domainHealth.presentDomains.length} domains are healthy.\n\n`;
  } else {
    if (result.domainHealth.missingDomains.length > 0) {
      content += `### Missing Domains\n\n`;
      content += result.domainHealth.missingDomains.map((d) => `- ${d}`).join('\n');
      content += '\n\n';
    }

    if (result.domainHealth.missingIndexes.length > 0) {
      content += `### Missing INDEX.md Files\n\n`;
      content += result.domainHealth.missingIndexes.map((d) => `- ${d}/INDEX.md`).join('\n');
      content += '\n\n';
    }

    if (result.domainHealth.missingRegistries.length > 0) {
      content += `### Missing REGISTRY.md Files\n\n`;
      content += result.domainHealth.missingRegistries.map((d) => `- ${d}/REGISTRY.md`).join('\n');
      content += '\n\n';
    }
  }

  if (result.metadataSync) {
    content += `## Metadata Sync

| Metric | Value |
|--------|-------|
| Total Files | ${result.metadataSync.totalFiles} |
| Valid | ${result.metadataSync.validFiles} |
| Fixed | ${result.metadataSync.fixedFiles} |
| Errors | ${result.metadataSync.errors.length} |
| Avg Completeness | ${result.metadataSync.stats.avgCompleteness.toFixed(1)}% |

`;
  }

  if (result.linkCheck) {
    content += `## Link Check

| Metric | Value |
|--------|-------|
| Total Links | ${result.linkCheck.totalLinks} |
| Valid Links | ${result.linkCheck.validLinks} |
| Broken Links | ${result.linkCheck.brokenLinks.length} |
| Cross-Domain | ${result.linkCheck.stats.crossDomainLinks} |

`;

    if (result.linkCheck.brokenLinks.length > 0) {
      content += `### Broken Links\n\n`;
      content += `| File | Target | Line |\n`;
      content += `|------|--------|------|\n`;
      for (const link of result.linkCheck.brokenLinks.slice(0, 20)) {
        content += `| ${link.sourceFile} | ${link.targetPath} | ${link.lineNumber} |\n`;
      }
      if (result.linkCheck.brokenLinks.length > 20) {
        content += `\n*...and ${result.linkCheck.brokenLinks.length - 20} more*\n`;
      }
      content += '\n';
    }
  }

  if (result.audit) {
    content += `## Audit Results

| Metric | Value |
|--------|-------|
| Passed Files | ${result.audit.passedFiles} |
| Failed Files | ${result.audit.failedFiles} |
| Health Score | ${result.audit.healthScore.toFixed(1)}% |
| Metadata Compliance | ${result.audit.stats.metadataCompliance.toFixed(1)}% |
| Naming Compliance | ${result.audit.stats.namingCompliance.toFixed(1)}% |

`;

    const errorIssues = result.audit.issues.filter((i) => i.severity === 'error');
    if (errorIssues.length > 0) {
      content += `### Critical Issues\n\n`;
      for (const issue of errorIssues.slice(0, 10)) {
        content += `- **${issue.file}**: ${issue.message}\n`;
      }
      if (errorIssues.length > 10) {
        content += `\n*...and ${errorIssues.length - 10} more errors*\n`;
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
  const reportsDir = await resolveReportsDir(docsPath);
  if (!(await pathExists(reportsDir))) {
    await mkdir(reportsDir, { recursive: true });
  }

  const reportPath = join(reportsDir, `maintenance-${timestamp}.md`);
  await writeFile(reportPath, content, 'utf-8');

  return reportPath;
}

/**
 * Generate the three knowledge-base indexes when a vault root exists.
 * No-op (silent) when the vault root doesn't exist — backward-compat hard
 * requirement: a 2.2.0-era project tree must observe zero behavior change.
 */
async function maybeGenerateKbIndexes(
  docsPath: string,
  silent: boolean,
  result: MaintainResult
): Promise<void> {
  // Project root is the parent of docsPath (e.g. .documentation/ → project root).
  // Config and playbook globs are resolved relative to the project root.
  const projectRoot = dirname(docsPath);

  const config = await loadPluginConfig(projectRoot);
  const vaultRoot = resolveVaultRoot(projectRoot, config);

  if (!(await pathExists(vaultRoot))) {
    // No vault — backward-compat path. Don't even log.
    return;
  }

  if (!silent) {
    logger.subheader('Step 3.5: Knowledge-base Indexes');
  }

  const playbookGlobs = resolvePlaybookGlobs(projectRoot, config);
  const index = await buildCiterIndex({ projectRoot, vaultRoot, playbookGlobs });

  const factsPath = await generateFactsIndex({ vaultRoot, index });
  const incidentsPath = await generateIncidentsIndex({ vaultRoot, index });
  const symptomsPath = await generateSymptomsIndex({ vaultRoot, index });

  if (!silent) {
    logger.success(`Generated ${index.facts.size} facts → ${factsPath}`);
    logger.success(`Generated ${index.incidents.size} incidents → ${incidentsPath}`);
    logger.success(`Generated symptoms index → ${symptomsPath}`);
  }

  // Suppress unused-var: result is part of the signature for future use
  // (e.g. surfacing KB stats into the maintenance report).
  void result;
}

/**
 * Quick health check without full maintenance
 */
export async function quickHealthCheck(docsPath: string): Promise<{
  healthy: boolean;
  score: number;
  issues: string[];
}> {
  const domainHealth = await checkDomainHealth(docsPath);
  const issues: string[] = [];

  if (!domainHealth.healthy) {
    if (domainHealth.missingDomains.length > 0) {
      issues.push(`Missing domains: ${domainHealth.missingDomains.join(', ')}`);
    }
    if (domainHealth.missingIndexes.length > 0) {
      issues.push(`Missing INDEX.md in: ${domainHealth.missingIndexes.join(', ')}`);
    }
  }

  const score = domainHealth.healthy ? 100 : 100 - issues.length * 10;

  return {
    healthy: issues.length === 0,
    score: Math.max(0, score),
    issues,
  };
}
