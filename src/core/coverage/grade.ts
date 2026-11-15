/**
 * Surface grading (#117): how well the docs cover each surface the code declares.
 *   absent     no doc names it
 *   named      some doc names it (whole identifier, split spellings too) but none says what it does or its value
 *   explained  a doc that cites the surface's source has a sentence about it (a verb phrase, or the value for a
 *              constant), or a section under a heading with its name; a constant whose value a doc states
 *              next to its name is explained wherever it is stated
 * Knowledge-base docs count like any doc and are never judged against the code: grading only reports code surfaces.
 * Archive docs do not count. Deterministic: same inputs, same output.
 */
import type { DocText } from './decide.js';
import type { Surface, SurfaceKind } from './surfaces/index.js';

export type Grade = 'absent' | 'named' | 'explained';
export interface GradedSurface extends Surface { grade: Grade; /** Docs naming it, sorted. */ named_in: string[]; explained_by?: string }
export interface GradeCounts { total: number; absent: number; named: number; explained: number }
export interface GradeSummary { total: GradeCounts; by_kind: Record<string, GradeCounts>; /** Code area: the first folder of the source file, `.` for the repo root. */ by_area: Record<string, GradeCounts> }

/** A sentence about a surface needs at least this many other words, and a verb (or this many more). */
export const EXPLAIN_MIN_WORDS = 4;
const EXPLAIN_ANY_WORDS = 7;
const VERB = /\b(?:is|are|was|runs?|ran|sends?|sent|checks?|deletes?|removes?|revokes?|returns?|retr(?:y|ies)|expires?|triggers?|uses?|calls?|writes?|reads?|fires?|fails?|processe[sd]|cleans?|syncs?|refreshe[sd]|handles?|creates?|updates?|limits?|caps?|sets?|means|ensures?|when|if|every|per|controls?|decides?|determines?|keeps?|prevents?|allows?|marks?|emails?|pages?|logs?|stores?|clears?|prunes?|rotates?|starts?|stops?|waits?|blocks?|rejects?|notifies|alerts?)\b/i;
const GENERIC_KINDS = new Set<SurfaceKind>(['ci-job', 'cli-command', 'ci-workflow']);

interface Prepared { doc: DocText; lines: string[]; lower: string; archived: boolean }
const prepare = (doc: DocText): Prepared => ({ doc, lines: doc.text.toLowerCase().split('\n'), lower: doc.text.toLowerCase(), archived: /(^|\/)archive\//.test(doc.path) });

/** The spellings of a name a doc may use: the literal, and for identifiers the split forms. Lower case. */
function list_forms(surface: Surface): string[] {
  const literal = surface.name.toLowerCase();
  const words = surface.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_.-]+/).filter(Boolean);
  if (!/^[a-z0-9_.\- ]+$/i.test(surface.name) || words.length < 1) return [literal];
  const forms = new Set([literal, words.join(' '), words.join('_'), words.join('-'), words.join('')]);
  // a lone word such as `build` is too common in prose to count outside a code span
  if (words.length === 1 && GENERIC_KINDS.has(surface.kind)) return [`\`${literal}\``];
  return [...forms];
}

const is_word_char = (char: string | undefined): boolean => !!char && /[\w]/.test(char);
/** Index of `form` in `text` with whole-identifier boundaries, else -1. */
function find_form(text: string, form: string, route: boolean): number {
  for (let from = text.indexOf(form); from >= 0; from = text.indexOf(form, from + 1)) {
    const before = text[from - 1], after = text[from + form.length];
    const before_ok = !is_word_char(before) && (form[0] !== '-' || before !== '-') && !(/^\w/.test(form) && before === '-');
    const after_ok = !is_word_char(after) && after !== '-' && !(route && after === '/');
    if (before_ok && after_ok) return from;
  }
  return -1;
}

const strip_markup = (text: string): string => text.replace(/^\s*(?:#+|[-*+]|\d+[.)])\s*/, '').replace(/[|`*_]/g, ' ');
const count_words = (text: string): number => (text.match(/[a-z][a-z'-]*/gi) ?? []).length;
const normalize_value = (text: string): string => text.toLowerCase().replace(/[\s_,]/g, '');

function cites(doc: DocText, surface: Surface): boolean {
  return doc.sources.some((source) => source === surface.file || surface.file.startsWith(source.replace(/\/?$/, '/'))) || doc.text.includes(surface.file);
}

/** Every sentence of the doc that holds the name, without the name itself. */
function list_sentences(prepared: Prepared, forms: string[], route: boolean): string[] {
  const found: string[] = [];
  for (const line of prepared.lines) {
    if (!forms.some((form) => line.includes(form))) continue;
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const at = forms.map((form) => ({ form, index: find_form(sentence, form, route) })).find((item) => item.index >= 0);
      if (at) found.push(sentence.slice(0, at.index) + ' ' + sentence.slice(at.index + at.form.length));
    }
  }
  return found;
}

/** A section under a heading holding the name, with a body of real words. */
function has_named_section(prepared: Prepared, forms: string[], route: boolean): boolean {
  const { lines } = prepared;
  for (let i = 0; i < lines.length; i++) {
    const heading = /^(#+)\s+(.*)$/.exec(lines[i]!);
    if (!heading || !forms.some((form) => find_form(heading[2]!, form, route) >= 0)) continue;
    let words = 0;
    for (let j = i + 1; j < lines.length && !/^#+\s/.test(lines[j]!); j++) words += count_words(lines[j]!.replace(/[|`*_]/g, ' '));
    if (words >= EXPLAIN_MIN_WORDS + 1) return true;
  }
  return false;
}

function states_purpose(rest: string): boolean {
  const words = count_words(strip_markup(rest));
  return words >= EXPLAIN_ANY_WORDS || (words >= EXPLAIN_MIN_WORDS && VERB.test(rest));
}

function states_value(rest: string, value: string): boolean {
  const target = normalize_value(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${target}(?![\\d])`).test(normalize_value(rest));
}

export function grade_surfaces(surfaces: Surface[], docs: DocText[]): GradedSurface[] {
  const prepared = docs.map(prepare).filter((item) => !item.archived).sort((a, b) => a.doc.path.localeCompare(b.doc.path));
  return surfaces.map((surface): GradedSurface => {
    const forms = list_forms(surface);
    const route = surface.kind === 'http-route';
    const named = prepared.filter((item) => forms.some((form) => item.lower.includes(form) && find_form(item.lower, form, route) >= 0));
    const named_in = named.map((item) => item.doc.path);
    const explainer = named.find((item) => {
      const sentences = list_sentences(item, forms, route);
      if (surface.value !== undefined && sentences.some((rest) => states_value(rest, surface.value!))) return true;
      if (!cites(item.doc, surface)) return false;
      return sentences.some(states_purpose) || has_named_section(item, forms, route);
    });
    return { ...surface, grade: explainer ? 'explained' : named.length ? 'named' : 'absent', named_in, ...(explainer && { explained_by: explainer.doc.path }) };
  });
}

const empty_counts = (): GradeCounts => ({ total: 0, absent: 0, named: 0, explained: 0 });
function count_into(table: Record<string, GradeCounts>, key: string, grade: Grade): void {
  const counts = (table[key] ??= empty_counts());
  counts.total++;
  counts[grade]++;
}

/** Counts per surface kind and per code area (the source file's first folder), plus a total. */
export function summarize_grades(graded: GradedSurface[]): GradeSummary {
  const summary: GradeSummary = { total: empty_counts(), by_kind: {}, by_area: {} };
  for (const item of graded) {
    summary.total.total++;
    summary.total[item.grade]++;
    count_into(summary.by_kind, item.kind, item.grade);
    count_into(summary.by_area, item.file.includes('/') ? item.file.split('/')[0]! : '.', item.grade);
  }
  const sort = (table: Record<string, GradeCounts>): Record<string, GradeCounts> => Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)));
  return { ...summary, by_kind: sort(summary.by_kind), by_area: sort(summary.by_area) };
}
