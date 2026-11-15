/**
 * The coverage-miss engine entry point (#113): locate -> decide -> merge -> generated-reference hint -> drafts.
 * `reconcile --gaps` feeds it eval misses; `hewtd coverage` feeds it the code inventory. Read-only: it
 * returns review entries, it writes nothing.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { PluginConfig } from '../../utils/config.js';
import { load_doc_texts, resolve_decision, type Decision } from './decide.js';
import { build_drafts, type DraftResult } from './draft.js';
import { locate_facets, type LocateResult } from './locate.js';
import { add_generated_references, merge_decisions, type Proposal } from './merge.js';
import { compile_facet, list_timed_out_facets, parse_position_facet, REDACTED_FACET, test_facet, type CoverageMiss } from './facets.js';
import { find_value_in_name, find_value_spans, has_key_token, is_value_line } from '../security/gate.js';
import type { SecretsConfig } from '../../utils/config.js';

/** The fields of a gaps.v1 entry the engine reads; `facets` is required. */
export type FacetGap = Omit<CoverageMiss, 'key' | 'count' | 'facets'> & { id?: string; used_doc?: string | null; count?: number; facets?: string[] };

export interface CoveragePlan { decisions: Decision[]; proposals: Proposal[]; drafts: DraftResult; /** Facets that ran out of time while matching: treated as matching nothing. */ warnings: string[] }

/**
 * Facets that are only a value (#118): every line that holds the facet is a credential or config-default line, and the
 * facet sits on the value side of it (after the last `=`, `:`, `,`, `(`, `??` or `||`), never in the name. An env or
 * config NAME located on the same line is not one.
 */
/** A line inside a heredoc body (`<<EOF` ... `EOF`): all of it is a value. */
function is_in_heredoc(lines: string[], index: number): boolean {
  for (let i = index - 1; i >= Math.max(0, index - 200); i--) {
    const tag = /<<-?\s*['"]?(\w+)['"]?/.exec(lines[i] ?? '')?.[1];
    if (tag) return !lines.slice(i + 1, index).some((between) => between.trim() === tag);
  }
  return false;
}

/** The facet written without regex escapes, to screen it like a name. */
const de_regex = (facet: string): string => facet.replace(/\\(.)/g, '$1');
export const REDACTED_QUESTION = '[redacted question]';

/** Whether every match of `regex` in the line is inside a literal, an option argument or userinfo. */
function is_in_value_context(regex: RegExp, text: string): boolean {
  const spans = find_value_spans(text);
  const global = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  const found = [...text.slice(0, 20_000).matchAll(global)].filter((match) => match[0].length);
  return found.length > 0 && found.every((match) => spans.some(([from, to]) => match.index! >= from && match.index! + match[0].length <= to));
}

async function find_value_facets(repo_root: string, located: LocateResult, secrets_config: SecretsConfig, by_context: boolean): Promise<Set<string>> {
  const lines_of = new Map<string, string[]>();
  const found = new Set<string>();
  for (const [facet, located_hits] of located.code) {
    const regex = compile_facet(facet).regex;
    if (!regex || !located_hits.length || parse_position_facet(facet)) continue;
    let every = true;
    for (const located_hit of located_hits) {
      let lines = lines_of.get(located_hit.file);
      if (!lines) { lines = (await readFile(join(repo_root, located_hit.file), 'utf-8').catch(() => '')).split('\n'); lines_of.set(located_hit.file, lines); }
      const source_line = lines[located_hit.line - 1] ?? '';
      // by context (gaps facets only; a coverage facet is a screened surface name): inside a literal, an option argument, userinfo or a heredoc
      if (by_context && (is_in_heredoc(lines, located_hit.line - 1) || is_in_value_context(regex, source_line))) continue;
      const text = source_line.replace(/[\s,;)]+$/, '');
      const cut = Math.max(text.lastIndexOf('??'), text.lastIndexOf('||'), ...[...'=:,('].map((char) => text.lastIndexOf(char)));
      if (!(cut >= 0 && is_value_line(text, secrets_config) && test_facet(regex, text.slice(cut + 1)) && !test_facet(regex, text.slice(0, cut)))) { every = false; break; }
    }
    if (every) found.add(facet);
  }
  return found;
}

export async function plan_coverage_misses(options: { repo_root: string; docs_root: string; config: PluginConfig; gaps: FacetGap[]; include_blind?: boolean; today?: string; exclude_files?: string[]; /** Already located (hewtd coverage: a surface has its file:line), so the code is not searched. */ located?: LocateResult }): Promise<CoveragePlan> {
  const { repo_root, docs_root, config } = options;
  const by_context = !options.located;
  // a gaps question that holds a value (as written or as read) is not echoed
  const misses: CoverageMiss[] = options.gaps.map((gap, i) => ({ ...gap, key: gap.id ?? `gaps[${i}]`, count: gap.count ?? 1, facets: gap.facets ?? [], ...(by_context && find_value_in_name(gap.query) && { query: REDACTED_QUESTION }) })).filter((miss) => miss.facets.length);
  const located = options.located ?? await locate_facets({ repo_root, docs_root, cold_root: config.reconcile.cold_root, facets: [...new Set(misses.flatMap((miss) => miss.facets))], ...(options.exclude_files && { exclude_files: options.exclude_files }) });
  const docs = await load_doc_texts(docs_root);
  const value_facets = await find_value_facets(repo_root, located, config.reconcile.secrets, by_context);
  // a gaps facet that is key-shaped or holds a value once the regex escapes are read is a value, located or not
  if (by_context) for (const facet of misses.flatMap((miss) => miss.facets)) if (has_key_token(de_regex(facet)) || find_value_in_name(de_regex(facet))) value_facets.add(facet);
  // a facet that is only a value is classified like any other, then shown as [redacted facet] in every output
  const decisions = misses.map((miss) => resolve_decision(miss, located, docs)).map((decision) => ({ ...decision, missing_facets: [...new Set(decision.missing_facets.map((facet) => (value_facets.has(facet) ? REDACTED_FACET : facet)))] }));
  // blind misses never share a proposal with others: a blind-only proposal can then be skipped whole
  const proposals = await add_generated_references(repo_root, [...merge_decisions(decisions.filter((decision) => !decision.blind)), ...merge_decisions(decisions.filter((decision) => decision.blind))]);
  const drafts = await build_drafts({ repo_root, docs_root, proposals, secrets_config: config.reconcile.secrets, ...(options.include_blind && { include_blind: true }), today: options.today ?? new Date().toISOString().slice(0, 10) });
  const slow = new Set(list_timed_out_facets());
  const warnings = misses.filter((miss) => miss.facets.some((facet) => slow.has(facet))).map((miss) => `${miss.key}: ${miss.facets.filter((facet) => slow.has(facet)).length} of ${miss.facets.length} facet(s) ran out of time while matching and count as matching nothing; simplify them`);
  return { decisions, proposals, drafts, warnings };
}
