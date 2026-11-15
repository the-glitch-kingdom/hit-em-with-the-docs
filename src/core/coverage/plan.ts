/**
 * The coverage-miss engine entry point (#113): locate -> decide -> merge -> generated-reference hint -> drafts.
 * `reconcile --gaps` feeds it eval misses; `hewtd coverage` will feed it the code inventory. Read-only: it
 * returns review entries, it writes nothing.
 */
import type { PluginConfig } from '../../utils/config.js';
import { load_doc_texts, resolve_decision, type Decision } from './decide.js';
import { build_drafts, type DraftResult } from './draft.js';
import { locate_facets } from './locate.js';
import { add_generated_references, merge_decisions, type Proposal } from './merge.js';
import { list_timed_out_facets, type CoverageMiss } from './facets.js';

/** The fields of a gaps.v1 entry the engine reads; `facets` is required. */
export type FacetGap = Omit<CoverageMiss, 'key' | 'count' | 'facets'> & { id?: string; used_doc?: string | null; count?: number; facets?: string[] };

export interface CoveragePlan { decisions: Decision[]; proposals: Proposal[]; drafts: DraftResult; /** Facets that ran out of time while matching: treated as matching nothing. */ warnings: string[] }

export async function plan_coverage_misses(options: { repo_root: string; docs_root: string; config: PluginConfig; gaps: FacetGap[]; include_blind?: boolean; today?: string; exclude_files?: string[] }): Promise<CoveragePlan> {
  const { repo_root, docs_root, config } = options;
  const misses: CoverageMiss[] = options.gaps.map((gap, i) => ({ ...gap, key: gap.id ?? `gaps[${i}]`, count: gap.count ?? 1, facets: gap.facets ?? [] })).filter((miss) => miss.facets.length);
  const located = await locate_facets({ repo_root, docs_root, cold_root: config.reconcile.cold_root, facets: [...new Set(misses.flatMap((miss) => miss.facets))], ...(options.exclude_files && { exclude_files: options.exclude_files }) });
  const docs = await load_doc_texts(docs_root);
  const decisions = misses.map((miss) => resolve_decision(miss, located, docs));
  // blind misses never share a proposal with others: a blind-only proposal can then be skipped whole
  const proposals = await add_generated_references(repo_root, [...merge_decisions(decisions.filter((decision) => !decision.blind)), ...merge_decisions(decisions.filter((decision) => decision.blind))]);
  const drafts = await build_drafts({ repo_root, docs_root, proposals, secrets_config: config.reconcile.secrets, ...(options.include_blind && { include_blind: true }), today: options.today ?? new Date().toISOString().slice(0, 10) });
  const slow = new Set(list_timed_out_facets());
  const warnings = misses.filter((miss) => miss.facets.some((facet) => slow.has(facet))).map((miss) => `${miss.key}: ${miss.facets.filter((facet) => slow.has(facet)).length} of ${miss.facets.length} facet(s) ran out of time while matching and count as matching nothing; simplify them`);
  return { decisions, proposals, drafts, warnings };
}
