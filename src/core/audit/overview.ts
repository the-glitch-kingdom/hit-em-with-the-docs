/**
 * Overview-doc checks (#51). Advisory only: warnings with no `code`, like the
 * RETRIEVAL_* rules, so neither the exit code nor `audit --strict` changes.
 */

import { build_link_graph } from '../links/tracker.js';
import { find_clusters } from '../links/clusters.js';
import type { OverviewConfig } from '../../utils/config.js';
import { KB_ERROR_CODES } from '../metadata/errors.js';
import type { AuditIssue } from './auditor.js';

const error_codes = KB_ERROR_CODES;
const TEMPLATE = '`templates/overview.template.md`';

export async function check_overview(docs_root: string, config: OverviewConfig): Promise<AuditIssue[]> {
  const is_check_enabled = (content: string): boolean => !config.disabled.includes(content);
  const want_missing = is_check_enabled(error_codes.OVERVIEW_MISSING);
  const want_stale = is_check_enabled(error_codes.OVERVIEW_STALE_LINKS);
  if (!want_missing && !want_stale) return [];

  const clusters = await find_clusters(docs_root, config);
  const issues: AuditIssue[] = [];
  const found = want_stale && clusters.some((cluster) => cluster.kind_overview)
    ? new Map<string, Set<string>>()
    : null;
  if (found) {
    for (const edge of (await build_link_graph(docs_root)).edges) {
      (found.get(edge.source) ?? found.set(edge.source, new Set()).get(edge.source)!).add(edge.target);
    }
  }

  for (const cluster of clusters) {
    if (!cluster.overview) {
      if (!want_missing) continue;
      issues.push({
        file: cluster.top,
        rule: error_codes.OVERVIEW_MISSING,
        severity: 'warning',
        message:
          `Flow${cluster.shared_tags.length ? `: ${cluster.shared_tags.join(', ')}` : ''} — ${cluster.members.length} docs (${cluster.members.slice(0, 5).join(', ')}${cluster.members.length > 5 ? ', ...' : ''}) have no overview` +
          (cluster.generated_only_hub ? '; only a generated index links them all' : ''),
        fixable: false,
        suggestion: `Write a \`kind: overview\` doc linking each member, starting from ${TEMPLATE}`,
      });
    } else if (found && cluster.kind_overview) {
      const linked = found.get(cluster.overview) ?? new Set<string>();
      const missing = cluster.members.filter((member) => member !== cluster.overview && !linked.has(member));
      if (missing.length === 0) continue;
      issues.push({
        file: cluster.overview,
        rule: error_codes.OVERVIEW_STALE_LINKS,
        severity: 'warning',
        message:
          `Overview does not link ${missing.length} of ${cluster.members.length - 1} cluster docs: ` +
          missing.slice(0, 5).join(', ') + (missing.length > 5 ? ', ...' : ''),
        fixable: false,
        suggestion: 'Add a link to each missing doc in the overview',
      });
    }
  }
  return issues;
}
