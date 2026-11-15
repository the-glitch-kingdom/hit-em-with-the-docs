/**
 * Nearest doc and decision (#113): for a miss with facets, exactly one outcome.
 *   extend <doc>       one doc holds most facets, or already cites the located code: add the missing details
 *   new                no doc holds more than a small share and none cites the code: a new doc, sources named
 *   covered            a doc holds every facet: the fault is ranking or phrasing, not the docs
 *   instruction-only   the fact exists only in an agent instruction file that search cannot reach
 * Deterministic: same inputs, same output (ties break on doc path).
 */
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
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
const PATH_LIST_MIN_LINES = 5;
const PATH_LIST_SHARE = 0.5;
/** A citing doc with no facet qualifies as relevant when its title, purpose or path share a distinctive question term, or its body shares this many (and at least half of all of them) (#118). */
const RELEVANT_BODY_TERMS = 2;
const FILE_EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|php|sh|ya?ml|json|toml|sql|tf|conf|ini|env|md|cron)$/i;
const URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
/** A brand written with a dot (`Node.js`, `Next.js`) is a word, not a file. */
const BRAND_WORD = /^[A-Z][a-z]+\.(?:js|ts)$/;
/** A path token has a file extension, or two or more slashes, or sits in backticks or link syntax; a URL, a folder-first word pair (`api/gateway`) or a brand (`Node.js`) in prose is not one (#118). */
export function has_path_token(line: string): boolean {
  const text = line.replace(URL_TEXT, ' ');
  const marked = [...text.matchAll(/`([^`]+)`|\]\(([^)]+)\)/g)].map((found) => found[1] ?? found[2]!);
  if (marked.some((token) => /[\w.@-]\/[\w.@-]/.test(token) || FILE_EXTENSION.test(token))) return true;
  return (text.match(/[\w.@-]+(?:\/[\w.@-]+)+|\b[\w-]+\.[a-z]+\b/gi) ?? []).some((token) => (token.split('/').length > 2 || FILE_EXTENSION.test(token)) && !BRAND_WORD.test(token));
}
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)]|\|)\s*/;

const HUB_NAME = /^(index|readme|overview)/i;
const HUB_TIERS = new Set(['overview', 'reference', 'index', 'incident-narrative', 'incident-facts']);
/** Institutional knowledge: never extended from code (a covered outcome still counts it). */
const is_knowledge_base = (doc: DocText): boolean => /(^|\/)knowledge-base\//.test(doc.path);
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
  if (!hub) {
    const { data, content } = parse_frontmatter<Record<string, unknown>>(doc.text);
    // #120: a title, keyword or tag that says file map or inventory is a hub signal
    hub = FILE_MAP_SIGNAL.test([data.title, data.keywords, data.tags].flat().filter((value) => typeof value === 'string').join(' ')) || is_path_list(content);
  }
  hub_cache.set(doc, hub);
  return hub;
}

const FILE_MAP_SIGNAL = /file[\s_-]?map|inventory|index of files/i;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
/** A table row is a path row when its first cell is a path: a path token, or a bare `dir/name`. */
function is_path_row(line: string): boolean {
  const cell = line.trim().replace(/^\|/, '').split('|')[0]!.trim();
  return has_path_token(cell) || /^`?[\w.@-]+(?:\/[\w.@-]*)+`?$/.test(cell);
}

/** A body that is mostly a list of paths (a file map or inventory, as list items or table rows) names code without explaining any of it. */
function is_path_list(body: string): boolean {
  const lines = body.split('\n').filter((line) => line.trim() && !/^\s*#/.test(line) && !TABLE_SEPARATOR.test(line));
  const path_lines = lines.filter((line) => (/^\s*\|/.test(line) ? is_path_row(line) : LIST_LINE.test(line) && has_path_token(line))).length;
  return path_lines >= PATH_LIST_MIN_LINES && path_lines / lines.length >= PATH_LIST_SHARE;
}

/** A `sources` entry that says which lines it cites; absent `lines` means the whole file. */
export interface SourceRef { path: string; lines?: [number, number][] }
export interface DocText { path: string; text: string; sources: string[]; /** Only for entries that carry line granularity. */ source_refs?: SourceRef[] }

const STOP_TERMS = new Set('a an and are as at be by can do does for from how i if in is it its of on or so that the their there these this to was what when where which who why will with work works used use uses using value values code file files data system service function method class'.split(' '));
/** Distinctive words of a text: identifiers split, lower-cased, stop and generic words dropped, a plural `s` folded. */
function get_distinctive_terms(text: string): Set<string> {
  const words = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [];
  return new Set(words.map((word) => (word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word)).filter((word) => !STOP_TERMS.has(word)));
}
/** Common nouns that name half the codebase: they never make a doc relevant on their own (#118). */
const GENERIC_TERMS = new Set('email mail schedule job task config configuration limit service api data user file page request response error log name type key list time date setting option feature app server client default rate number count message event queue worker process handler helper util info status result check test run set get add update create delete send provider'.split(' '));
/** Terms that are identifier-like in the raw text (an underscore, camelCase or a digit): one shared is enough. */
function get_identifier_terms(text: string): Set<string> {
  const tokens = (text.match(/[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z]+\d[A-Za-z0-9]*/g) ?? []);
  return get_distinctive_terms(tokens.join(' '));
}
function is_relevant_to_query(doc: DocText, query_terms: Set<string>, strong_terms: Set<string>): boolean {
  if (!query_terms.size) return false;
  const { data, content } = parse_frontmatter<Record<string, unknown>>(doc.text);
  const label = get_distinctive_terms([doc.path.replace(/\.md$/, ''), data.title, data.purpose].filter((part): part is string => typeof part === 'string').join(' '));
  const shared_label = [...query_terms].filter((term) => label.has(term));
  if (shared_label.some((term) => strong_terms.has(term)) || shared_label.filter((term) => !GENERIC_TERMS.has(term)).length >= 2) return true;
  const body = get_distinctive_terms(content);
  const shared = [...query_terms].filter((term) => body.has(term));
  return shared.filter((term) => !GENERIC_TERMS.has(term)).length >= RELEVANT_BODY_TERMS && shared.length / query_terms.size >= 0.5;
}
/** The doc's frontmatter title shares a non-generic question term (one generic noun, `email`, is no relevance: #118). */
function has_title_term(doc: DocText, query_terms: Set<string>): boolean {
  const { data } = parse_frontmatter<Record<string, unknown>>(doc.text);
  const title = typeof data.title === 'string' ? get_distinctive_terms(data.title) : new Set<string>();
  return [...query_terms].some((term) => title.has(term) && !GENERIC_TERMS.has(term));
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
  /** new: deepest folder common to the docs about nearby code (the domain or a subfolder of it). */
  folder?: string;
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
  if (!existsSync(docs_root)) return docs; // a repo with no docs yet: every surface is absent
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

/** The deepest folder that more than half of the given folders sit in (posix, docs-relative); all of them share the first segment. */
function find_majority_folder(folders: string[]): string {
  const chosen = [folders[0]!.split('/')[0]!];
  for (;;) {
    const next = new Map<string, number>();
    for (const folder of folders) {
      const parts = folder.split('/');
      if (parts.length > chosen.length && chosen.every((part, i) => parts[i] === part)) next.set(parts[chosen.length]!, (next.get(parts[chosen.length]!) ?? 0) + 1);
    }
    const top = [...next].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (!top || top[1] * 2 <= folders.length) return chosen.join('/');
    chosen.push(top[0]);
  }
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

  // a named surface (a doc names it, none explains it) is never covered: the doc that names it is extended with what it does
  const best = miss.named ? undefined : holds_all;
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
  const names_source = (doc: DocText): number => (miss.named && cited_by.includes(doc.path) ? 0 : 1);
  const order = (a: (typeof counts)[number], b: (typeof counts)[number]): number =>
    b.held.length - a.held.length || Number(b.doc.path === eval_path) - Number(a.doc.path === eval_path) || names_source(a.doc) - names_source(b.doc) || closeness(a.doc) - closeness(b.doc) || a.doc.sources.length - b.doc.sources.length || a.doc.path.localeCompare(b.doc.path);
  const enough = counts.filter((item) => !is_knowledge_base(item.doc) && total && item.held.length / total >= EXTEND_MIN_SHARE).sort(order);
  const pick = enough.find((item) => !is_hub_doc(item.doc)) ?? enough[0];
  if (pick) return finish({ kind: 'extend', doc: pick.doc.path, held: pick.held.length, missing_facets: miss.named ? facets : facets.filter((facet) => !pick.held.includes(facet)) });
  // 2. else the most specific non-hub doc that cites the located code (its cited lines, when it says which) and is about the question (#118):
  //    it holds a facet, or shares distinctive question terms; the eval's nearest doc holding a facet counts without citing
  const query_terms = get_distinctive_terms(miss.query);
  const strong_terms = new Set([...get_identifier_terms(miss.query), ...get_distinctive_terms(facets.join(' '))]);
  // the eval's nearest doc is preferred only when it holds a facet that names code (not weak, located or identifier-like) and is cited or relevant
  const is_distinctive = (facet: string): boolean => !is_weak(facet) && (!!located.code.get(facet)?.length || /[A-Za-z0-9]_[A-Za-z0-9]|[a-z][A-Z]|\d/.test(facet.replace(/\\./g, '')));
  const qualifies = ({ doc, held }: (typeof counts)[number]): { ok: boolean; preferred: boolean } => {
    if (is_hub_doc(doc) || is_knowledge_base(doc)) return { ok: false, preferred: false };
    const cites = cited_by.includes(doc.path) && doc.sources.length <= SPECIFIC_MAX_SOURCES && covers_hits(doc, code_hits);
    const relevant = is_relevant_to_query(doc, query_terms, strong_terms);
    // #120: a doc that lists the located file itself (a file few docs cite) and is titled for the question qualifies, whatever else it cites
    const lists_file = doc.sources.some((source) => source_files.includes(source) && counts.filter((other) => other.doc.sources.includes(source)).length <= SPECIFIC_MAX_SOURCES);
    const titled = lists_file && has_title_term(doc, query_terms);
    const preferred = doc.path === eval_path && held.some(is_distinctive) && (cites || relevant);
    return { ok: (cites && (held.length > 0 || relevant)) || titled || preferred, preferred };
  };
  const citing = counts.map((item) => ({ item, ...qualifies(item) })).filter(({ ok }) => ok)
    .sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.item.held.length - a.item.held.length || order(a.item, b.item))[0]?.item;
  if (citing) return finish({ kind: 'extend', doc: citing.doc.path, held: citing.held.length, missing_facets: facets.filter((facet) => !citing.held.includes(facet)) });

  // new doc: the folder where the docs about nearby code live
  const votes = new Map<string, DocText[]>();
  for (const doc of docs) {
    const domain_dir = doc.path.includes('/') ? doc.path.split('/')[0]! : undefined;
    if (!domain_dir || domain_dir === 'archive' || domain_dir === 'knowledge-base' || is_hub_doc(doc)) continue; // an incident, overview or knowledge-base fact is no home for a new doc (#118)
    const near = doc.sources.some((source) => source_files.some((file) => dirname(file) === dirname(source)));
    if (near) votes.set(domain_dir, [...(votes.get(domain_dir) ?? []), doc]);
  }
  const winner = [...votes].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  const domain = winner?.[0];
  // the deepest folder most voting docs of the winning domain sit in (#120)
  const folder = winner && find_majority_folder(winner[1].map((doc) => dirname(doc.path)));
  return finish({ kind: 'new', held: ranked[0]?.held.length ?? 0, missing_facets: facets, ...(domain && { domain }), ...(folder && { folder }) });
}
