/**
 * Overview-doc checks (#51). Advisory only: warnings with no `code`, like the
 * RETRIEVAL_* rules, so neither the exit code nor `audit --strict` changes.
 */

import { build_link_graph } from '../links/tracker.js';
import { find_clusters } from '../links/clusters.js';
import type { OverviewConfig } from '../../utils/config.js';
import { KB_ERROR_CODES } from '../metadata/errors.js';
import type { AuditIssue } from './auditor.js';

const O = KB_ERROR_CODES;
const TEMPLATE = '`templates/overview.template.md`';

export async function check_overview(docs_path: string, cfg: OverviewConfig): Promise<AuditIssue[]> {
  const on = (c: string): boolean => !cfg.disabled.includes(c);
  const want_missing = on(O.OVERVIEW_MISSING);
  const want_stale = on(O.OVERVIEW_STALE_LINKS);
  if (!want_missing && !want_stale) return [];

  const clusters = await find_clusters(docs_path, cfg);
  const issues: AuditIssue[] = [];
  const out = want_stale && clusters.some((c) => c.kindOverview)
    ? new Map<string, Set<string>>()
    : null;
  if (out) {
    for (const e of (await build_link_graph(docs_path)).edges) {
      (out.get(e.source) ?? out.set(e.source, new Set()).get(e.source)!).add(e.target);
    }
  }

  for (const c of clusters) {
    if (!c.overview) {
      if (!want_missing) continue;
      issues.push({
        file: c.top,
        rule: O.OVERVIEW_MISSING,
        severity: 'warning',
        message:
          `Flow${c.sharedTags.length ? `: ${c.sharedTags.join(', ')}` : ''} — ${c.members.length} docs (${c.members.slice(0, 5).join(', ')}${c.members.length > 5 ? ', ...' : ''}) have no overview` +
          (c.generatedOnlyHub ? '; only a generated index links them all' : ''),
        fixable: false,
        suggestion: `Write a \`kind: overview\` doc linking each member, starting from ${TEMPLATE}`,
      });
    } else if (out && c.kindOverview) {
      const linked = out.get(c.overview) ?? new Set<string>();
      const missing = c.members.filter((m) => m !== c.overview && !linked.has(m));
      if (missing.length === 0) continue;
      issues.push({
        file: c.overview,
        rule: O.OVERVIEW_STALE_LINKS,
        severity: 'warning',
        message:
          `Overview does not link ${missing.length} of ${c.members.length - 1} cluster docs: ` +
          missing.slice(0, 5).join(', ') + (missing.length > 5 ? ', ...' : ''),
        fixable: false,
        suggestion: 'Add a link to each missing doc in the overview',
      });
    }
  }
  return issues;
}
