/**
 * Nearest doc and decision (#113): for a miss with facets, exactly one outcome.
 *   extend <doc>       one doc holds most facets, or already cites the located code: add the missing details
 *   new                no doc holds more than a small share and none cites the code: a new doc, sources named
 *   covered            a doc holds every facet: the fault is ranking or phrasing, not the docs
 *   instruction-only   the fact exists only in an agent instruction file that search cannot reach
 * Deterministic: same inputs, same output (ties break on doc path).
 */
import { readFile } from 'fs/promises';
import { dirname, relative } from 'path';
import { parse_frontmatter } from '../../utils/frontmatter.js';
import { list_markdown_files } from '../reconcile/triage.js';
import { compile_facet, is_code_line_facet, test_facet, type CoverageMiss } from './facets.js';
import type { FacetHit, LocateResult } from './locate.js';

/** A doc holding no more than this share of a miss's facets is not "the doc about it" (the eval found 2 of 16 misses with none anywhere, 8 with 2-3 of 3-4). */
export const NEW_DOC_MAX_SHARE = 0.25;

export interface DocText { path: string; text: string; sources: string[] }
export type DecisionKind = 'extend' | 'new' | 'covered' | 'instruction-only';
export interface Decision {
  key: string;
  query: string;
  count: number;
  kind: DecisionKind;
  /** extend / covered: the doc. */
  doc?: string;
  held: number;
  total: number;
  /** Facets the target doc (or, for a new doc, every doc) lacks. */
  missing_facets: string[];
  /** Located code: file -> lines, for the facets this proposal must add. */
  sources: FacetHit[];
  source_files: string[];
  cited_by: string[];
  /** new: folder where the docs about nearby code live. */
  domain?: string;
  rank?: number | null;
  instruction_files?: string[];
  flags: string[];
  notes: string[];
  blind?: boolean;
  tier?: string;
  ids: string[];
}

export async function load_doc_texts(docs_root: string): Promise<DocText[]> {
  const docs: DocText[] = [];
  for (const abs_path of await list_markdown_files(docs_root)) {
    const text = await readFile(abs_path, 'utf-8');
    const { data } = parse_frontmatter<Record<string, unknown>>(text);
    if (data.generated === true) continue;
    const listed = Array.isArray(data.sources) ? data.sources : [];
    const sources = listed.map((entry) => (typeof entry === 'string' ? entry : (entry as { path?: unknown } | null)?.path)).filter((path_text): path_text is string => typeof path_text === 'string');
    docs.push({ path: relative(docs_root, abs_path).split('\\').join('/'), text, sources });
  }
  return docs.sort((a, b) => a.path.localeCompare(b.path));
}

const holds_facet = (regex: RegExp, text: string): boolean => text.split('\n').some((line) => test_facet(regex, line));

export function resolve_decision(miss: CoverageMiss, located: Pick<LocateResult, 'code' | 'instructions'>, docs: DocText[]): Decision {
  const facets = miss.facets;
  const total = facets.length;
  const compiled = facets.map((facet) => ({ facet, regex: compile_facet(facet).regex })).filter((item): item is { facet: string; regex: RegExp } => !!item.regex);
  const held_by = (doc: DocText): string[] => compiled.filter(({ regex }) => holds_facet(regex, doc.text)).map(({ facet }) => facet);
  const counts = docs.map((doc) => ({ doc, held: held_by(doc) }));
  const ranked = [...counts].sort((a, b) => b.held.length - a.held.length || a.doc.path.localeCompare(b.doc.path));
  const notes: string[] = [];
  const flags: string[] = [];

  // the eval's nearest doc wins when it is a live doc; hewtd says where its own count differs
  const eval_path = miss.nearest_doc?.path;
  const eval_doc = eval_path ? counts.find((item) => item.doc.path === eval_path) : undefined;
  let best = eval_doc ?? ranked[0];
  if (eval_doc && miss.nearest_doc?.facet_coverage) {
    const own = `${eval_doc.held.length}/${total}`;
    if (own !== miss.nearest_doc.facet_coverage) notes.push(`the eval counts ${miss.nearest_doc.facet_coverage} in ${eval_doc.doc.path}, hewtd counts ${own}`);
  }

  const code_hits = compiled.flatMap(({ facet }) => located.code.get(facet) ?? []);
  const source_files = [...new Set(code_hits.map((found) => found.file))].sort();
  const cited_by = counts.filter(({ doc }) => doc.sources.some((source) => source_files.includes(source)) || source_files.some((file) => doc.text.includes(file))).map(({ doc }) => doc.path);
  const base = { key: miss.key, query: miss.query, count: miss.count, total, flags, notes, ids: [miss.key], ...(miss.blind && { blind: true }), ...(miss.tier && { tier: miss.tier }) };
  const finish = (decision: Omit<Decision, keyof typeof base | 'cited_by' | 'source_files' | 'sources'>): Decision => {
    const missing_set = new Set(decision.missing_facets);
    const needed = code_hits.filter((found) => compiled.some(({ facet }) => missing_set.has(facet) && (located.code.get(facet) ?? []).includes(found)));
    const sources = needed.length ? needed : code_hits;
    if (decision.kind !== 'covered' && decision.missing_facets.length && decision.missing_facets.every(is_code_line_facet)) {
      flags.push('facet-shape');
      notes.push('every facet behind this outcome looks like a code line: the miss may be facet shape, not a missing doc (rewrite them as prose-tolerant regexes and re-run the eval)');
    }
    return { ...base, ...decision, sources, source_files: [...new Set(sources.map((found) => found.file))].sort(), cited_by };
  };

  if (best && total && best.held.length === total) {
    const rank = miss.nearest_doc?.rank;
    notes.push(rank != null ? `every facet is in ${best.doc.path} and it has rank ${rank}: check ranking and phrasing (symptoms, purpose, title), not the doc's content` : `every facet is in ${best.doc.path}: check ranking and phrasing, not the doc's content`);
    return finish({ kind: 'covered', doc: best.doc.path, held: total, missing_facets: [], ...(rank !== undefined && { rank }) });
  }

  const none_in_code = !code_hits.length;
  const instruction_files = [...new Set(compiled.flatMap(({ facet }) => located.instructions.get(facet) ?? []).map((found) => found.file))].sort();
  const nobody_holds = !best || best.held.length === 0;
  if (none_in_code && instruction_files.length && nobody_holds) {
    notes.push('the fact exists only in an agent instruction file, which search cannot reach: move it into an indexed doc');
    return finish({ kind: 'instruction-only', held: 0, missing_facets: facets, instruction_files });
  }

  // the doc that already cites the located code is the topic's home, even when it holds no facet yet
  const citing = counts.filter(({ doc }) => cited_by.includes(doc.path)).sort((a, b) => b.held.length - a.held.length || a.doc.path.localeCompare(b.doc.path))[0];
  const share = best && total ? best.held.length / total : 0;
  if (!eval_doc && citing && (!best || share <= NEW_DOC_MAX_SHARE || citing.held.length >= best.held.length)) best = citing;
  if (best && (share > NEW_DOC_MAX_SHARE || cited_by.includes(best.doc.path))) {
    return finish({ kind: 'extend', doc: best.doc.path, held: best.held.length, missing_facets: facets.filter((facet) => !best!.held.includes(facet)) });
  }

  // new doc: the folder where the docs about nearby code live
  const votes = new Map<string, number>();
  for (const doc of docs) {
    const folder = doc.path.includes('/') ? doc.path.split('/')[0]! : undefined;
    if (!folder || folder === 'archive') continue;
    const near = doc.sources.some((source) => source_files.some((file) => dirname(file) === dirname(source)));
    if (near) votes.set(folder, (votes.get(folder) ?? 0) + 1);
  }
  const domain = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  return finish({ kind: 'new', held: best?.held.length ?? 0, missing_facets: facets, ...(domain && { domain }) });
}
