import { readFile } from 'fs/promises';
import { relative, basename, join, resolve } from 'path';
import { find_markdown_files } from '../../utils/glob.js';
import { list_domain_doc_files } from '../../generators/regenerate.js';
import { parse_frontmatter } from '../../utils/frontmatter.js';
import { logger } from '../../utils/logger.js';
import {
  validate_partial_metadata,
  validate_knowledge_base_fields,
  get_missing_required_fields,
  type PartialDocumentMetadata,
} from '../metadata/schema.js';
import { KB_ERROR_SEVERITY, type KbErrorCode } from '../metadata/errors.js';
import { detect_domain_from_path } from '../domains/detector.js';
import { is_valid_tier, TIERS } from '../domains/classifier.js';
import { is_valid_domain, get_all_domains } from '../domains/registry.js';
import { load_plugin_config } from '../../utils/config.js';
import { load_retrieval_docs, check_retrieval } from './retrieval.js';
import { check_overview } from './overview.js';
import { load_ledger } from '../reconcile/ledger.js';
import { find_unreviewed_docs } from '../reconcile/triage.js';
import { list_generations } from '../reconcile/rotation.js';
import { compute_targets, type TargetsReport } from './targets.js';
import { check_naming_convention, check_file_placement } from './rules.js';

export interface AuditOptions {
  docs_root: string;
  domain?: string;
  issues_only?: boolean;
  silent?: boolean;
  /**
   * Strict mode: when true, the `audit` CLI command will exit non-zero on
   * ANY error-severity issue, including the warning-only knowledge-base
   * checks (e.g. FACT_VERIFY_COMMAND_MULTILINE_SHEBANG). Has no effect on
   * the AuditResult itself — it's a flag the CLI inspects.
   */
  strict?: boolean;
  /** Where `.claude/hit-em-with-the-docs.json` lives (retrieval thresholds). Defaults to cwd. */
  repo_root?: string;
}

export interface AuditResult {
  total_files: number;
  passed_files: number;
  failed_files: number;
  issues: AuditIssue[];
  stats: AuditStats;
  health_score: number;
  /** Docs targets (#109): advisory, never an issue; absent when it could not be computed. */
  targets?: TargetsReport;
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
/** Issues that should count toward CI failure: advisory RETRIEVAL_* (#50) and OVERVIEW_* (#51) warnings never do. */
export function count_actionable_issues(issues: { rule: string }[]): number {
  return issues.filter((i) => !/^(RETRIEVAL|OVERVIEW|COLD_GENERATION|LINK_BROKEN_ANCHOR|DOCS_UNREVIEWED)(_|$)/.test(i.rule)).length;
}

export async function check_documentation(options: AuditOptions): Promise<AuditResult> {
  const {
    docs_root: docs_root,
    domain,
    issues_only = false,
    silent = false,
  } = options;

  const result: AuditResult = {
    total_files: 0,
    passed_files: 0,
    failed_files: 0,
    issues: [],
    stats: {
      metadataCompliance: 0,
      namingCompliance: 0,
      placementCompliance: 0,
      tagConsistency: 0,
      byDomain: {},
    },
    health_score: 0,
  };

  if (!silent) {
    logger.header('Documentation Audit');
  }

  // Find all markdown files
  let files = await find_markdown_files(docs_root);

  // Filter by domain if specified
  if (domain) {
    files = files.filter((file) => {
      const doc_path = relative(docs_root, file);
      return doc_path.startsWith(domain + '/') || doc_path.startsWith(domain + '\\');
    });
  }

  // Exclude system files
  files = files.filter((file) => {
    const name = basename(file);
    return !['INDEX.md', 'REGISTRY.md'].includes(name);
  });

  result.total_files = files.length;

  if (!silent) {
    logger.info(`Auditing ${files.length} files...`);
  }

  let metadata_compliant = 0;
  let naming_compliant = 0;
  let placement_compliant = 0;
  const tag_counts = new Map<string, number>();

  for (const file of files) {
    const file_issues = await check_file(file, docs_root);

    // Track per-file results
    const has_errors = file_issues.some((i) => i.severity === 'error');

    if (has_errors) {
      result.failed_files++;
    } else {
      result.passed_files++;
    }

    // Add issues
    if (!issues_only || file_issues.length > 0) {
      result.issues.push(...file_issues);
    }

    // Update compliance stats
    const has_metadata_issue = file_issues.some((i) => i.rule.startsWith('metadata'));
    const has_naming_issue = file_issues.some((i) => i.rule === 'naming-convention');
    const has_placement_issue = file_issues.some((i) => i.rule === 'placement');

    if (!has_metadata_issue) metadata_compliant++;
    if (!has_naming_issue) naming_compliant++;
    if (!has_placement_issue) placement_compliant++;

    // Track tags for consistency check
    try {
      const content = await readFile(file, 'utf-8');
      const { data } = parse_frontmatter<PartialDocumentMetadata>(content);
      if (data.tags) {
        for (const tag of data.tags) {
          tag_counts.set(tag, (tag_counts.get(tag) ?? 0) + 1);
        }
      }

      // Track by domain
      const file_domain = data.domains?.[0] ?? detect_domain_from_path(file, docs_root).domain ?? 'unknown';
      if (!result.stats.byDomain[file_domain]) {
        result.stats.byDomain[file_domain] = { files: 0, issues: 0, healthScore: 0 };
      }
      result.stats.byDomain[file_domain]!.files++;
      result.stats.byDomain[file_domain]!.issues += file_issues.length;
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
  const drift_issues = await check_index_drift(docs_root, domain);
  result.issues.push(...drift_issues);

  // Retrieval readiness (#50): advisory warnings. Deliberately carry no `code`
  // so `audit --strict` (which fails on any coded issue) is unaffected.
  const plugin_cfg = await load_plugin_config(options.repo_root);
  const retrieval_cfg = plugin_cfg.retrieval;
  const retrieval_docs = await load_retrieval_docs(docs_root, files);
  result.issues.push(...check_retrieval(retrieval_docs, retrieval_cfg));
  result.issues.push(...(await check_overview(docs_root, plugin_cfg.overview)));

  // Cold generations (#97): locked history. A changed or missing one is a warning, never an error.
  for (const row of list_generations(options.repo_root ?? process.cwd(), plugin_cfg.cold_storage)) {
    if (row.status === 'ok') continue;
    result.issues.push({
      file: row.path, rule: `COLD_GENERATION_${row.status}`, severity: 'warning', fixable: false,
      message: `cold generation ${row.generation} ${row.status === 'CHANGED' ? 'changed since it was rotated (its checksum no longer matches)' : 'is missing from disk'}`,
      suggestion: 'Cold generations are read-only history; restore it from git, or run `hewtd reconcile --undo` only if it is intact',
    });
  }
  // Docs created or changed since their last reconcile review (#98): one advisory warning, no `code`.
  try {
    const unreviewed = await find_unreviewed_docs({ docs_root, ledger: await load_ledger(resolve(options.repo_root ?? process.cwd(), plugin_cfg.reconcile.ledger_path)) });
    if (unreviewed.length) {
      result.issues.push({
        file: '.', rule: 'DOCS_UNREVIEWED', severity: 'warning', fixable: false,
        message: `${unreviewed.length} doc(s) created or changed since their last review: ${unreviewed.slice(0, 5).join(', ')}${unreviewed.length > 5 ? `, +${unreviewed.length - 5} more` : ''}`,
        suggestion: 'Run `hewtd reconcile --changed --write-review`, judge each entry, then `hewtd reconcile --apply <file>`.',
      });
    }
  } catch { /* no ledger or unreadable doc: nothing to report */ }
  // Docs targets (#109): advisory, shown beside the issues, never one of them (so --strict and the exit code are unaffected).
  try { result.targets = await compute_targets({ repo_root: options.repo_root ?? process.cwd(), docs_root, config: plugin_cfg }); } catch { /* not a repo or unreadable: no targets */ }

  // Calculate stats
  result.stats.metadataCompliance = (metadata_compliant / files.length) * 100 || 0;
  result.stats.namingCompliance = (naming_compliant / files.length) * 100 || 0;
  result.stats.placementCompliance = (placement_compliant / files.length) * 100 || 0;

  // Tag consistency: percentage of tags used more than once
  const tags_used_multiple = [...tag_counts.values()].filter((tag_total) => tag_total > 1).length;
  result.stats.tagConsistency = tag_counts.size > 0
    ? (tags_used_multiple / tag_counts.size) * 100
    : 100;

  // Calculate per-domain health scores
  for (const stats of Object.values(result.stats.byDomain)) {
    const avg_issues_per_file = stats.issues / stats.files;
    stats.healthScore = Math.max(0, 100 - avg_issues_per_file * 10);
  }

  // Calculate overall health score
  result.health_score =
    (result.stats.metadataCompliance * 0.4) +
    (result.stats.namingCompliance * 0.2) +
    (result.stats.placementCompliance * 0.2) +
    (result.stats.tagConsistency * 0.2);

  if (!silent) {
    logger.newline();
    logger.success(`Audit complete!`);
    logger.info(`Passed: ${result.passed_files}/${result.total_files}`);
    logger.info(`Health Score: ${result.health_score.toFixed(1)}/100`);
    if (result.issues.length > 0) {
      const errors = result.issues.filter((i) => i.severity === 'error').length;
      const warnings = result.issues.filter((i) => i.severity === 'warning').length;
      logger.warn(`Issues: ${errors} errors, ${warnings} warnings`);
    }
    const unreviewed = result.issues.find((i) => i.rule === 'DOCS_UNREVIEWED');
    if (unreviewed) logger.warn(`DOCS_UNREVIEWED: ${unreviewed.message}. ${unreviewed.suggestion}`);
    if (result.targets) {
      logger.header('Targets (advisory)');
      logger.table(['Metric', 'Value', 'Target', 'Met', 'Held'], result.targets.rows.map((row) => [row.label, `${row.value}/${row.total}`, row.target, row.met ? 'met' : 'NOT MET', String(row.held)]));
      for (const row of result.targets.rows.filter((candidate) => !candidate.met)) logger.info(`  ${row.id}: ${row.next}${row.missing ? ` (${row.missing.join(', ')})` : ''}`);
      logger.info(result.targets.note);
    }
  }

  return result;
}

/**
 * Audit a single file
 */
async function check_file(file_path: string, docs_root: string): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const rel_path = relative(docs_root, file_path);

  try {
    const content = await readFile(file_path, 'utf-8');
    const { data } = parse_frontmatter<PartialDocumentMetadata>(content);

    // Check metadata presence
    const missing_required = get_missing_required_fields(data as Record<string, unknown>);
    if (missing_required.length > 0) {
      issues.push({
        file: rel_path,
        rule: 'metadata-required',
        severity: 'error',
        message: `Missing required fields: ${missing_required.join(', ')}`,
        fixable: true,
        suggestion: 'Run with --fix to auto-generate missing metadata',
      });
    }

    // Check metadata validity
    const validation = validate_partial_metadata(data);
    if (!validation.valid) {
      for (const error of validation.errors) {
        issues.push({
          file: rel_path,
          rule: 'metadata-invalid',
          severity: 'error',
          message: error,
          fixable: false,
        });
      }
    }

    // Check tier validity
    if (data.tier && !is_valid_tier(data.tier)) {
      issues.push({
        file: rel_path,
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
    const kb_errors = validate_knowledge_base_fields(data as Record<string, unknown>);
    for (const error of kb_errors) {
      const severity = KB_ERROR_SEVERITY[error.code];
      issues.push({
        file: rel_path,
        rule: `metadata-${error.code.toLowerCase().replace(/_/g, '-')}`,
        severity,
        message: error.message,
        fixable: false,
        code: error.code,
      });
    }

    // Check domain validity
    if (data.domains) {
      for (const doc of data.domains) {
        if (!is_valid_domain(doc)) {
          issues.push({
            file: rel_path,
            rule: 'metadata-domain',
            severity: 'warning',
            message: `Unknown domain: ${doc}`,
            fixable: false,
            suggestion: 'Consider using a standard domain or adding this as a custom domain',
          });
        }
      }
    }

    // Check naming convention
    const naming_result = check_naming_convention(file_path);
    if (!naming_result.valid) {
      const naming_issue: AuditIssue = {
        file: rel_path,
        rule: 'naming-convention',
        severity: 'warning',
        message: naming_result.message ?? 'Naming convention violation',
        fixable: false,
      };
      if (naming_result.suggestion) {
        naming_issue.suggestion = naming_result.suggestion;
      }
      issues.push(naming_issue);
    }

    // Check file placement
    const placement_result = check_file_placement(file_path, docs_root, data.domains?.[0]);
    if (!placement_result.valid) {
      const placement_issue: AuditIssue = {
        file: rel_path,
        rule: 'placement',
        severity: 'warning',
        message: placement_result.message ?? 'File may be in wrong domain',
        fixable: false,
      };
      if (placement_result.suggestion) {
        placement_issue.suggestion = placement_result.suggestion;
      }
      issues.push(placement_issue);
    }

    // Check for stale content
    if (data.last_updated) {
      const last_updated = new Date(data.last_updated);
      const days_since_update = (Date.now() - last_updated.getTime()) / (1000 * 60 * 60 * 24);

      if (days_since_update > 365) {
        issues.push({
          file: rel_path,
          rule: 'stale-content',
          severity: 'info',
          message: `Document not updated in ${Math.floor(days_since_update)} days`,
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
        file: rel_path,
        rule: 'deprecated-not-archived',
        severity: 'info',
        message: 'Document is marked deprecated but still in an active domain folder',
        fixable: false,
        suggestion: `Retire it with \`hewtd archive ${rel_path}\` (or restore it to active)`,
      });
    }

    // Check for empty tags
    if (data.tags && data.tags.length === 0 && data.status === 'active') {
      issues.push({
        file: rel_path,
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
      file: rel_path,
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
async function check_index_drift(
  docs_root: string,
  domain_filter?: string
): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const domains = domain_filter ? [domain_filter] : get_all_domains();
  const suggestion = 'Run `hewtd index` (or `hewtd maintain`) to regenerate it';

  for (const domain of domains) {
    const doc_files = await list_domain_doc_files(docs_root, domain);
    if (doc_files.length === 0) continue;

    let index_content: string | null = null;
    try {
      index_content = await readFile(join(docs_root, domain, 'INDEX.md'), 'utf-8');
    } catch {
      index_content = null;
    }

    if (index_content === null) {
      issues.push({
        file: `${domain}/INDEX.md`,
        rule: 'index-drift',
        severity: 'error',
        message: `INDEX.md is missing but ${doc_files.length} document(s) exist in ${domain}/`,
        fixable: true,
        suggestion,
      });
      continue;
    }

    const content = index_content;
    const unlisted = doc_files.filter((doc_file) => !content.includes(doc_file));
    if (unlisted.length > 0) {
      issues.push({
        file: `${domain}/INDEX.md`,
        rule: 'index-drift',
        severity: 'error',
        message:
          `INDEX.md lists ${doc_files.length - unlisted.length} of ` +
          `${doc_files.length} document(s) in ${domain}/ — unlisted: ${unlisted.join(', ')}`,
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
export async function load_audit_summary_for_domain(
  docs_root: string,
  domain: string
): Promise<DomainAuditStats> {
  const result = await check_documentation({
    docs_root: docs_root,
    domain,
    silent: true,
  });

  return result.stats.byDomain[domain] ?? { files: 0, issues: 0, healthScore: 100 };
}
