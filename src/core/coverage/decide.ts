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
import { compile_facet, is_code_line_facet, is_weak_facet, match_facets, type CoverageMiss } from './facets.js';
import type { FacetHit, LocateResult } from './locate.js';

/** A doc must hold at least this share of a miss's facets to be extended on coverage alone (#115). */
export const EXTEND_MIN_SHARE = 0.5;
/** A doc citing more files than this is too broad to be "the doc about" one of them. */
export const SPECIFIC_MAX_SOURCES = 5;
/** A doc citing more files than this is a hub: an index in all but name. */
export const HUB_MIN_SOURCES = 15;

/** A doc whose body has at least this many path lines, making up at least PATH_LIST_SHARE of its non-empty lines, is a file map (#118). */
export const PATH_LIST_MIN_LINES = 5;
export const PATH_LIST_SHARE = 0.5;
/** A citing doc with no facet qualifies as relevant when its title, purpose or path share a distinctive question term, or its body shares this many (and at least half of all of them) (#118). */
export const RELEVANT_BODY_TERMS = 2;
const PATH_TOKEN = /[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|php|sh|ya?ml|json|toml|sql|tf|conf|ini|env)\b/;
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)]|\|)\s*/;

const HUB_NAME = /^(index|readme|overview)/i;
const HUB_TIERS = new Set(['overview', 'reference', 'index', 'incident-narrative', 'incident-facts']);
const hub_cache = new WeakMap<DocText, boolean>();
/** Index, overview, reference, generated, archive, incident or very broad docs: last-resort targets, never merge points (#115). */
export function is_hub_doc(doc: DocText): boolean {
  const cached = hub_cache.get(doc);
  if (cached !== undefined) return cached;
  const base = doc.path.split('/').pop() ?? doc.path;
  let hub = HUB_NAME.test(base) || /(^|\/)archive\//.test(doc.path) || /(^|\/)knowledge-base\/incidents?\//.test(doc.path) || doc.sources.length > HUB_MIN_SOURCES;
  if (!hub) {
    const { data } = parse_frontmatter<Record<string, unknown>>(doc.text);
    hub = data.generated === true || [data.tier, data.kind].some((value) => typeof value === 'string' && HUB_TIERS.has(value));
  }
  if (!hub) hub = is_path_list(parse_frontmatter<Record<string, unknown>>(doc.text).content);
  hub_cache.set(doc, hub);
  return hub;
}

/** A body that is mostly a list of paths (a file map or inventory) names code without explaining any of it. */
function is_path_list(body: string): boolean {
  const lines = body.split('\n').filter((line) => line.trim() && !/^\s*#/.test(line));
  const path_lines = lines.filter((line) => LIST_LINE.test(line) && PATH_TOKEN.test(line)).length;
  return path_lines >= PATH_LIST_MIN_LINES && path_lines / lines.length >= PATH_LIST_SHARE;
}

/** A `sources` entry that says which lines it cites; absent `lines` means the whole file. */
export interface SourceRef { path: string; lines?: [number, number][] }
export interface DocText { path: string; text: string; sources: string[]; /** Only for entries that carry line granularity. */ source_refs?: SourceRef[] }

const STOP_TERMS = new Set('a an and are as at be by can do does for from how i if in is it its of on or so that the their there these this to was what when where which who why will with work works used use uses using value values code file files data system service function method class'.split(' '));
/** Distinctive words of a text: identifiers split, lower-cased, stop and generic words dropped, a plural `s` folded. */
export function get_distinctive_terms(text: string): Set<string> {
  const words = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [];
  return new Set(words.map((word) => (word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word)).filter((word) => !STOP_TERMS.has(word)));
}
function is_relevant_to_query(doc: DocText, query_terms: Set<string>): boolean {
  if (!query_terms.size) return false;
  const { data, content } = parse_frontmatter<Record<string, unknown>>(doc.text);
  const label = get_distinctive_terms([doc.path.replace(/\.md$/, ''), data.title, data.purpose].filter((part): part is string => typeof part === 'string').join(' '));
  if ([...query_terms].some((term) => label.has(term))) return true;
  const body = get_distinctive_terms(content);
  const shared = [...query_terms].filter((term) => body.has(term)).length;
  return shared >= RELEVANT_BODY_TERMS && shared / query_terms.size >= 0.5;
}
/** A citation with line data counts for a file only when it covers one of the facet lines; without line data the whole file counts. */
function covers_hits(doc: DocText, located: FacetHit[]): boolean {
  return located.some((found) => {
    const citations = (doc.source_refs ?? []).filter((citation) => citation.path === found.file);
    if (!citations.length) return doc.sources.includes(found.file) || doc.text.includes(found.file);
    return citations.some((citation) => !citation.lines || citation.lines.some(([from, to]) => found.line >= from && found.line <= to));
  });
}
export type DecisionKind = 'extend' | 'new' | 'covered' | 'instruction-only';
export interface Decision {
  key: string;
  query: string;
  count: number;
  kind: DecisionKind;
  /** extend / covered: the doc. */
  doc?: string;
  /** The target doc is a hub (last resort): it never joins a merge. */
  hub?: boolean;
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
    const source_refs = listed.flatMap((entry): SourceRef[] => {
      const { path: path_text, lines } = (entry && typeof entry === 'object' ? entry : {}) as { path?: unknown; lines?: unknown };
      if (typeof path_text !== 'string' || lines === undefined) return [];
      const ranges = (Array.isArray(lines) ? lines : [lines]).map((item) => /^(\d+)(?:\s*-\s*(\d+))?$/.exec(String(item).trim())).filter((found): found is RegExpExecArray => !!found).map((found): [number, number] => [Number(found[1]), Number(found[2] ?? found[1])]);
      return ranges.length ? [{ path: path_text, lines: ranges }] : [];
    });
    docs.push({ path: relative(docs_root, abs_path).split('\\').join('/'), text, sources, ...(source_refs.length && { source_refs }) });
  }
  return docs.sort((a, b) => a.path.localeCompare(b.path));
}

export function resolve_decision(miss: CoverageMiss, located: Pick<LocateResult, 'code' | 'instructions' | 'weak'>, docs: DocText[]): Decision {
  const facets = miss.facets;
  const total = facets.length;
  const compiled = facets.map((facet) => ({ facet, regex: compile_facet(facet).regex })).filter((item): item is { facet: string; regex: RegExp } => !!item.regex);
  const held_by = (doc: DocText): string[] => {
    const matched = match_facets(compiled.map(({ regex }) => regex), doc.text.split('\n'), 1);
    return compiled.filter((_, i) => matched[i]?.length).map(({ facet }) => facet);
  };
  const counts = docs.map((doc) => ({ doc, held: held_by(doc) }));
  const ranked = [...counts].sort((a, b) => b.held.length - a.held.length || a.doc.path.localeCompare(b.doc.path));
  const notes: string[] = [];
  const flags: string[] = [];

  const eval_path = miss.nearest_doc?.path;
  const eval_doc = eval_path ? counts.find((item) => item.doc.path === eval_path) : undefined;
  if (eval_doc && miss.nearest_doc?.facet_coverage) {
    const own = `${eval_doc.held.length}/${total}`;
    if (own !== miss.nearest_doc.facet_coverage) notes.push(`the eval counts ${miss.nearest_doc.facet_coverage} in ${eval_doc.doc.path}, hewtd counts ${own}`);
  }
  // a doc holding every facet means the fact is written down already, whichever doc the eval ranked nearest
  const holds_all = total ? ranked.find((item) => item.held.length === total) : undefined;
  if (eval_doc && holds_all && eval_doc.held.length < total) notes.push(`the eval's nearest doc ${eval_doc.doc.path} holds ${eval_doc.held.length}/${total}; ${holds_all.doc.path} holds them all`);

  // distinctive facets name the files; weak ones (short, numeric, broad) only count inside those files (#115)
  const is_weak = (facet: string): boolean => is_weak_facet(facet) || !!located.weak?.has(facet);
  const strong_files = new Set(compiled.filter(({ facet }) => !is_weak(facet)).flatMap(({ facet }) => (located.code.get(facet) ?? []).map((found) => found.file)));
  const hits_of = (facet: string): FacetHit[] => (located.code.get(facet) ?? []).filter((found) => strong_files.has(found.file));
  const code_hits = compiled.flatMap(({ facet }) => hits_of(facet));
  if (compiled.length && !strong_files.size) notes.push('every facet is weak (short, numeric or found in many files): no source is named for it, so a person must say where it lives');
  const source_files = [...new Set(code_hits.map((found) => found.file))].sort();
  const cited_by = counts.filter(({ doc }) => doc.sources.some((source) => source_files.includes(source)) || source_files.some((file) => doc.text.includes(file))).map(({ doc }) => doc.path);
  const base = { key: miss.key, query: miss.query, count: miss.count, total, flags, notes, ids: [miss.key], ...(miss.blind && { blind: true }), ...(miss.tier && { tier: miss.tier }) };
  const finish = (decision: Omit<Decision, keyof typeof base | 'cited_by' | 'source_files' | 'sources'>): Decision => {
    if (decision.doc && decision.kind === 'extend' && is_hub_doc(counts.find((item) => item.doc.path === decision.doc)!.doc)) decision.hub = true;
    const missing_set = new Set(decision.missing_facets);
    const needed = code_hits.filter((found) => compiled.some(({ facet }) => missing_set.has(facet) && hits_of(facet).includes(found)));
    const sources = needed.length ? needed : code_hits;
    if (decision.kind !== 'covered' && decision.missing_facets.length && decision.missing_facets.every(is_code_line_facet)) {
      flags.push('facet-shape');
      notes.push('every facet behind this outcome looks like a code line: the miss may be facet shape, not a missing doc (rewrite them as prose-tolerant regexes and re-run the eval)');
    }
    return { ...base, ...decision, sources, source_files: [...new Set(sources.map((found) => found.file))].sort(), cited_by };
  };

  const best = holds_all;
  if (best && total) {
    const rank = best === eval_doc ? miss.nearest_doc?.rank : undefined;
    notes.push(rank != null ? `every facet is in ${best.doc.path} and it has rank ${rank}: check ranking and phrasing (symptoms, purpose, title), not the doc's content` : `every facet is in ${best.doc.path}: check ranking and phrasing, not the doc's content`);
    return finish({ kind: 'covered', doc: best.doc.path, held: total, missing_facets: [], ...(rank !== undefined && { rank }) });
  }

  const none_in_code = !code_hits.length;
  const instruction_files = [...new Set(compiled.filter(({ facet }) => !is_weak(facet)).flatMap(({ facet }) => located.instructions.get(facet) ?? []).map((found) => found.file))].sort();
  const nobody_holds = !ranked[0] || ranked[0].held.length === 0;
  if (none_in_code && instruction_files.length && nobody_holds) {
    notes.push('the fact exists only in an agent instruction file, which search cannot reach: move it into an indexed doc');
    return finish({ kind: 'instruction-only', held: 0, missing_facets: facets, instruction_files });
  }

  // 1. the doc holding most facets (>= half), a non-hub first; the eval's nearest doc, then the closer and narrower doc, win ties
  const near_dirs = new Set(source_files.map((file) => dirname(file)));
  const closeness = (doc: DocText): number => (doc.sources.some((source) => near_dirs.has(dirname(source))) ? 0 : 1);
  const order = (a: (typeof counts)[number], b: (typeof counts)[number]): number =>
    b.held.length - a.held.length || Number(b.doc.path === eval_path) - Number(a.doc.path === eval_path) || closeness(a.doc) - closeness(b.doc) || a.doc.sources.length - b.doc.sources.length || a.doc.path.localeCompare(b.doc.path);
  const enough = counts.filter((item) => total && item.held.length / total >= EXTEND_MIN_SHARE).sort(order);
  const pick = enough.find((item) => !is_hub_doc(item.doc)) ?? enough[0];
  if (pick) return finish({ kind: 'extend', doc: pick.doc.path, held: pick.held.length, missing_facets: facets.filter((facet) => !pick.held.includes(facet)) });
  // 2. else the most specific non-hub doc that cites the located code (its cited lines, when it says which) and is about the question (#118):
  //    it holds a facet, or shares distinctive question terms; the eval's nearest doc holding a facet counts without citing
  const query_terms = get_distinctive_terms(miss.query);
  const citing = counts.filter(({ doc, held }) => {
    if (is_hub_doc(doc)) return false;
    const eval_pick = doc.path === eval_path && held.length > 0;
    const cites = cited_by.includes(doc.path) && doc.sources.length <= SPECIFIC_MAX_SOURCES && covers_hits(doc, code_hits);
    return (cites && (held.length > 0 || is_relevant_to_query(doc, query_terms))) || eval_pick;
  }).sort((a, b) => b.held.length - a.held.length || order(a, b))[0];
  if (citing) return finish({ kind: 'extend', doc: citing.doc.path, held: citing.held.length, missing_facets: facets.filter((facet) => !citing.held.includes(facet)) });

  // new doc: the folder where the docs about nearby code live
  const votes = new Map<string, number>();
  for (const doc of docs) {
    const folder = doc.path.includes('/') ? doc.path.split('/')[0]! : undefined;
    if (!folder || folder === 'archive' || is_hub_doc(doc)) continue; // an incident or overview is no home for a new doc
    const near = doc.sources.some((source) => source_files.some((file) => dirname(file) === dirname(source)));
    if (near) votes.set(folder, (votes.get(folder) ?? 0) + 1);
  }
  const domain = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  return finish({ kind: 'new', held: ranked[0]?.held.length ?? 0, missing_facets: facets, ...(domain && { domain }) });
}
