import { readFile } from 'fs/promises';
import { relative, basename, join } from 'path';
import { findMarkdownFiles } from '../../utils/glob.js';
import { listDomainDocFiles } from '../../generators/regenerate.js';
import { parseFrontmatter } from '../../utils/frontmatter.js';
import { logger } from '../../utils/logger.js';
import {
  validatePartialMetadata,
  validateKnowledgeBaseFields,
  getMissingRequiredFields,
  type PartialDocumentMetadata,
} from '../metadata/schema.js';
import { KB_ERROR_SEVERITY, type KbErrorCode } from '../metadata/errors.js';
import { detectDomainFromPath } from '../domains/detector.js';
import { isValidTier, TIERS } from '../domains/classifier.js';
import { isValidDomain, getAllDomains } from '../domains/registry.js';
import { loadPluginConfig } from '../../utils/config.js';
import { collectRetrievalDocs, checkRetrieval } from './retrieval.js';
import { checkNamingConvention, checkFilePlacement } from './rules.js';

export interface AuditOptions {
  docsPath: string;
  domain?: string;
  issuesOnly?: boolean;
  silent?: boolean;
  /**
   * Strict mode: when true, the `audit` CLI command will exit non-zero on
   * ANY error-severity issue, including the warning-only knowledge-base
   * checks (e.g. FACT_VERIFY_COMMAND_MULTILINE_SHEBANG). Has no effect on
   * the AuditResult itself — it's a flag the CLI inspects.
   */
  strict?: boolean;
  /** Where `.claude/hit-em-with-the-docs.json` lives (retrieval thresholds). Defaults to cwd. */
  projectRoot?: string;
}

export interface AuditResult {
  totalFiles: number;
  passedFiles: number;
  failedFiles: number;
  issues: AuditIssue[];
  stats: AuditStats;
  healthScore: number;
}

export interface AuditIssue {
  file: string;
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  fixable: boolean;
  suggestion?: string;
  /**
   * Knowledge-base error code (2.3.0+), populated when this issue came from
   * a KB-specific validator (fact / incident / symptoms). Lets tooling switch
   * on specific violation kinds without substring-matching the message.
   */
  code?: KbErrorCode;
}

export interface AuditStats {
  metadataCompliance: number;
  namingCompliance: number;
  placementCompliance: number;
  tagConsistency: number;
  byDomain: Record<string, DomainAuditStats>;
}

export interface DomainAuditStats {
  files: number;
  issues: number;
  healthScore: number;
}

/**
 * Audit documentation for compliance and issues
 */
/** Issues that should count toward CI failure: advisory RETRIEVAL_* warnings (#50) never do. */
export function countActionableIssues(issues: { rule: string }[]): number {
  return issues.filter((i) => !i.rule.startsWith('RETRIEVAL_')).length;
}

export async function auditDocumentation(options: AuditOptions): Promise<AuditResult> {
  const {
    docsPath,
    domain,
    issuesOnly = false,
    silent = false,
  } = options;

  const result: AuditResult = {
    totalFiles: 0,
    passedFiles: 0,
    failedFiles: 0,
    issues: [],
    stats: {
      metadataCompliance: 0,
      namingCompliance: 0,
      placementCompliance: 0,
      tagConsistency: 0,
      byDomain: {},
    },
    healthScore: 0,
  };

  if (!silent) {
    logger.header('Documentation Audit');
  }

  // Find all markdown files
  let files = await findMarkdownFiles(docsPath);

  // Filter by domain if specified
  if (domain) {
    files = files.filter((f) => {
      const rel = relative(docsPath, f);
      return rel.startsWith(domain + '/') || rel.startsWith(domain + '\\');
    });
  }

  // Exclude system files
  files = files.filter((f) => {
    const name = basename(f);
    return !['INDEX.md', 'REGISTRY.md'].includes(name);
  });

  result.totalFiles = files.length;

  if (!silent) {
    logger.info(`Auditing ${files.length} files...`);
  }

  let metadataCompliant = 0;
  let namingCompliant = 0;
  let placementCompliant = 0;
  const tagCounts = new Map<string, number>();

  for (const file of files) {
    const fileIssues = await auditFile(file, docsPath);

    // Track per-file results
    const hasErrors = fileIssues.some((i) => i.severity === 'error');

    if (hasErrors) {
      result.failedFiles++;
    } else {
      result.passedFiles++;
    }

    // Add issues
    if (!issuesOnly || fileIssues.length > 0) {
      result.issues.push(...fileIssues);
    }

    // Update compliance stats
    const hasMetadataIssue = fileIssues.some((i) => i.rule.startsWith('metadata'));
    const hasNamingIssue = fileIssues.some((i) => i.rule === 'naming-convention');
    const hasPlacementIssue = fileIssues.some((i) => i.rule === 'placement');

    if (!hasMetadataIssue) metadataCompliant++;
    if (!hasNamingIssue) namingCompliant++;
    if (!hasPlacementIssue) placementCompliant++;

    // Track tags for consistency check
    try {
      const content = await readFile(file, 'utf-8');
      const { data } = parseFrontmatter<PartialDocumentMetadata>(content);
      if (data.tags) {
        for (const tag of data.tags) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      }

      // Track by domain
      const fileDomain = data.domains?.[0] ?? detectDomainFromPath(file, docsPath).domain ?? 'unknown';
      if (!result.stats.byDomain[fileDomain]) {
        result.stats.byDomain[fileDomain] = { files: 0, issues: 0, healthScore: 0 };
      }
      result.stats.byDomain[fileDomain]!.files++;
      result.stats.byDomain[fileDomain]!.issues += fileIssues.length;
    } catch {
      // Ignore read errors
    }
  }

  // INDEX.md drift detection (2.5.0). Domain-level, not per-file: flags any
  // document on disk that its domain's INDEX.md fails to list. This is the
  // symptom of the pre-2.5.0 integrate bug (issue #7) and of INDEX files
  // going stale between maintain runs. Drift issues are error-severity so
  // `audit --strict` gates CI on them; they do not change `failedFiles`, so
  // a plain `audit` exit code is unaffected (existing behavior preserved).
  const driftIssues = await checkIndexDrift(docsPath, domain);
  result.issues.push(...driftIssues);

  // Retrieval readiness (#50): advisory warnings. Deliberately carry no `code`
  // so `audit --strict` (which fails on any coded issue) is unaffected.
  const retrievalCfg = (await loadPluginConfig(options.projectRoot)).retrieval;
  const retrievalDocs = await collectRetrievalDocs(docsPath, files);
  result.issues.push(...checkRetrieval(retrievalDocs, retrievalCfg));

  // Calculate stats
  result.stats.metadataCompliance = (metadataCompliant / files.length) * 100 || 0;
  result.stats.namingCompliance = (namingCompliant / files.length) * 100 || 0;
  result.stats.placementCompliance = (placementCompliant / files.length) * 100 || 0;

  // Tag consistency: percentage of tags used more than once
  const tagsUsedMultiple = [...tagCounts.values()].filter((c) => c > 1).length;
  result.stats.tagConsistency = tagCounts.size > 0
    ? (tagsUsedMultiple / tagCounts.size) * 100
    : 100;

  // Calculate per-domain health scores
  for (const stats of Object.values(result.stats.byDomain)) {
    const avgIssuesPerFile = stats.issues / stats.files;
    stats.healthScore = Math.max(0, 100 - avgIssuesPerFile * 10);
  }

  // Calculate overall health score
  result.healthScore =
    (result.stats.metadataCompliance * 0.4) +
    (result.stats.namingCompliance * 0.2) +
    (result.stats.placementCompliance * 0.2) +
    (result.stats.tagConsistency * 0.2);

  if (!silent) {
    logger.newline();
    logger.success(`Audit complete!`);
    logger.info(`Passed: ${result.passedFiles}/${result.totalFiles}`);
    logger.info(`Health Score: ${result.healthScore.toFixed(1)}/100`);
    if (result.issues.length > 0) {
      const errors = result.issues.filter((i) => i.severity === 'error').length;
      const warnings = result.issues.filter((i) => i.severity === 'warning').length;
      logger.warn(`Issues: ${errors} errors, ${warnings} warnings`);
    }
  }

  return result;
}

/**
 * Audit a single file
 */
async function auditFile(filePath: string, docsPath: string): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const relPath = relative(docsPath, filePath);

  try {
    const content = await readFile(filePath, 'utf-8');
    const { data } = parseFrontmatter<PartialDocumentMetadata>(content);

    // Check metadata presence
    const missingRequired = getMissingRequiredFields(data as Record<string, unknown>);
    if (missingRequired.length > 0) {
      issues.push({
        file: relPath,
        rule: 'metadata-required',
        severity: 'error',
        message: `Missing required fields: ${missingRequired.join(', ')}`,
        fixable: true,
        suggestion: 'Run with --fix to auto-generate missing metadata',
      });
    }

    // Check metadata validity
    const validation = validatePartialMetadata(data);
    if (!validation.valid) {
      for (const error of validation.errors) {
        issues.push({
          file: relPath,
          rule: 'metadata-invalid',
          severity: 'error',
          message: error,
          fixable: false,
        });
      }
    }

    // Check tier validity
    if (data.tier && !isValidTier(data.tier)) {
      issues.push({
        file: relPath,
        rule: 'metadata-tier',
        severity: 'error',
        message: `Invalid tier: ${data.tier}`,
        fixable: true,
        suggestion: `Valid tiers: ${TIERS.join(', ')}`,
      });
    }

    // Knowledge-base primitive validation (fact / incident-narrative /
    // incident-facts / symptoms). Runs after the partial-schema check so
    // we don't double-report missing universal fields.
    const kbErrors = validateKnowledgeBaseFields(data as Record<string, unknown>);
    for (const err of kbErrors) {
      const severity = KB_ERROR_SEVERITY[err.code];
      issues.push({
        file: relPath,
        rule: `metadata-${err.code.toLowerCase().replace(/_/g, '-')}`,
        severity,
        message: err.message,
        fixable: false,
        code: err.code,
      });
    }

    // Check domain validity
    if (data.domains) {
      for (const d of data.domains) {
        if (!isValidDomain(d)) {
          issues.push({
            file: relPath,
            rule: 'metadata-domain',
            severity: 'warning',
            message: `Unknown domain: ${d}`,
            fixable: false,
            suggestion: 'Consider using a standard domain or adding this as a custom domain',
          });
        }
      }
    }

    // Check naming convention
    const namingResult = checkNamingConvention(filePath);
    if (!namingResult.valid) {
      const namingIssue: AuditIssue = {
        file: relPath,
        rule: 'naming-convention',
        severity: 'warning',
        message: namingResult.message ?? 'Naming convention violation',
        fixable: false,
      };
      if (namingResult.suggestion) {
        namingIssue.suggestion = namingResult.suggestion;
      }
      issues.push(namingIssue);
    }

    // Check file placement
    const placementResult = checkFilePlacement(filePath, docsPath, data.domains?.[0]);
    if (!placementResult.valid) {
      const placementIssue: AuditIssue = {
        file: relPath,
        rule: 'placement',
        severity: 'warning',
        message: placementResult.message ?? 'File may be in wrong domain',
        fixable: false,
      };
      if (placementResult.suggestion) {
        placementIssue.suggestion = placementResult.suggestion;
      }
      issues.push(placementIssue);
    }

    // Check for stale content
    if (data.last_updated) {
      const lastUpdated = new Date(data.last_updated);
      const daysSinceUpdate = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);

      if (daysSinceUpdate > 365) {
        issues.push({
          file: relPath,
          rule: 'stale-content',
          severity: 'info',
          message: `Document not updated in ${Math.floor(daysSinceUpdate)} days`,
          fixable: false,
          suggestion: 'Consider reviewing and updating this document',
        });
      }
    }

    // Deprecation nudge: a doc marked `status: deprecated` is, by definition,
    // still in an active domain folder (archived docs live under archive/ and
    // are not scanned). Nudge toward the archival process. This is what finally
    // makes `status: deprecated` actionable.
    if (data.status === 'deprecated') {
      issues.push({
        file: relPath,
        rule: 'deprecated-not-archived',
        severity: 'info',
        message: 'Document is marked deprecated but still in an active domain folder',
        fixable: false,
        suggestion: `Retire it with \`hewtd archive ${relPath}\` (or restore it to active)`,
      });
    }

    // Check for empty tags
    if (data.tags && data.tags.length === 0 && data.status === 'active') {
      issues.push({
        file: relPath,
        rule: 'missing-tags',
        severity: 'info',
        message: 'Active document has no tags',
        fixable: true,
        suggestion: 'Add relevant tags for better discoverability',
      });
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({
      file: relPath,
      rule: 'read-error',
      severity: 'error',
      message: `Could not read file: ${message}`,
      fixable: false,
    });
  }

  return issues;
}

/**
 * Detect INDEX.md drift for every domain (or a single domain when filtered).
 *
 * "Drift" means a document exists on disk that the domain's INDEX.md does not
 * list — the exact symptom of the pre-2.5.0 `integrate` bug (issue #7), and
 * of INDEX.md going stale when documents are added/removed by hand. Each
 * drifted domain yields one error-severity, fixable issue; running
 * `hewtd index` or `hewtd maintain` clears it.
 */
async function checkIndexDrift(
  docsPath: string,
  domainFilter?: string
): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const domains = domainFilter ? [domainFilter] : getAllDomains();
  const suggestion = 'Run `hewtd index` (or `hewtd maintain`) to regenerate it';

  for (const domain of domains) {
    const docFiles = await listDomainDocFiles(docsPath, domain);
    if (docFiles.length === 0) continue;

    let indexContent: string | null = null;
    try {
      indexContent = await readFile(join(docsPath, domain, 'INDEX.md'), 'utf-8');
    } catch {
      indexContent = null;
    }

    if (indexContent === null) {
      issues.push({
        file: `${domain}/INDEX.md`,
        rule: 'index-drift',
        severity: 'error',
        message: `INDEX.md is missing but ${docFiles.length} document(s) exist in ${domain}/`,
        fixable: true,
        suggestion,
      });
      continue;
    }

    const content = indexContent;
    const unlisted = docFiles.filter((f) => !content.includes(f));
    if (unlisted.length > 0) {
      issues.push({
        file: `${domain}/INDEX.md`,
        rule: 'index-drift',
        severity: 'error',
        message:
          `INDEX.md lists ${docFiles.length - unlisted.length} of ` +
          `${docFiles.length} document(s) in ${domain}/ — unlisted: ${unlisted.join(', ')}`,
        fixable: true,
        suggestion,
      });
    }
  }

  return issues;
}

/**
 * Get audit summary for a domain
 */
export async function getAuditSummaryForDomain(
  docsPath: string,
  domain: string
): Promise<DomainAuditStats> {
  const result = await auditDocumentation({
    docsPath,
    domain,
    silent: true,
  });

  return result.stats.byDomain[domain] ?? { files: 0, issues: 0, healthScore: 100 };
}
