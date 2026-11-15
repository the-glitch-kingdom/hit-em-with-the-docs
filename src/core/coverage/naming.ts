/**
 * Name and place a new doc (#118 section 3). Deterministic.
 * The name is the subject: the dominant identifier across the miss's facets and questions, else the source module,
 * else the question's noun phrase. The folder is where the docs about nearby code live; never the knowledge-base root.
 */
import { basename } from 'path';

/** A doc name is cut at a whole word, never mid-phrase. */
export const MAX_SLUG_LENGTH = 40;
/** The most words a phrase-based name keeps. */
const MAX_PHRASE_WORDS = 4;
/** Domain for a new doc when no doc cites nearby code. */
export const FALLBACK_DOMAIN = 'features';

const GENERIC_SUFFIX = new Set(['service', 'manager', 'handler', 'controller', 'helper', 'helpers', 'util', 'utils', 'impl', 'factory', 'provider']);
const GENERIC_PREFIX = new Set(['get', 'set', 'is', 'has', 'max', 'min', 'default']);
const GENERIC_MODULE = new Set(['index', 'main', 'init', 'utils', 'util', 'helpers', 'constants', 'config', 'settings', 'base', 'types', 'common', 'mod', 'lib', 'app']);
const QUESTION_WORDS = new Set('a an and are as at be by can could do does did for from get gets got how i if in is it its many much of on or so than that the their there these this to was were what when where which who whom whose why will with would long large big often often new number'.split(' '));

/** Identifier-shaped tokens: camelCase, PascalCase, snake_case or CONSTANT_CASE. Plain words are not identifiers. */
function find_identifiers(text: string): string[] {
  return (text.replace(/\\[a-zA-Z]/g, ' ').match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []).filter((token) => /[a-z][A-Z]/.test(token) || /^[A-Z][a-z0-9]+[A-Z]/.test(token) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(token));
}
const split_name = (name: string): string[] => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** Whole words joined by dashes while they fit. */
function make_slug(words: string[]): string {
  const kept: string[] = [];
  for (const word of words) {
    if (kept.length && [...kept, word].join('-').length > MAX_SLUG_LENGTH) break;
    kept.push(word);
  }
  return kept.join('-').slice(0, MAX_SLUG_LENGTH);
}
/** A subject name as words, without generic edges (`ChunkedUploadService` -> chunked, upload). */
function strip_generic(words: string[]): string[] {
  const kept_words = [...words];
  while (kept_words.length > 1 && GENERIC_PREFIX.has(kept_words[0]!)) kept_words.shift();
  while (kept_words.length > 1 && GENERIC_SUFFIX.has(kept_words[kept_words.length - 1]!)) kept_words.pop();
  return kept_words;
}

export function name_new_doc(options: { queries: string[]; facets: string[]; source_files: string[] }): string {
  // 1. the most frequent identifier; a tie goes to the longer name, then the alphabet
  const counts = new Map<string, number>();
  for (const text of [...options.facets, ...options.queries]) for (const identifier of find_identifiers(text)) counts.set(identifier, (counts.get(identifier) ?? 0) + 1);
  const dominant = [...counts].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))[0]?.[0];
  if (dominant) return make_slug(strip_generic(split_name(dominant)));
  // 2. the source module the facets were found in
  const modules = new Map<string, number>();
  for (const file of options.source_files) {
    const stem = basename(file).replace(/\.[^.]+$/, '');
    if (!GENERIC_MODULE.has(stem.toLowerCase())) modules.set(stem, (modules.get(stem) ?? 0) + 1);
  }
  const module_name = [...modules].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  if (module_name) return make_slug(split_name(module_name));
  // 3. the question's noun phrase
  const phrase = (options.queries[0]?.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []).filter((word) => !QUESTION_WORDS.has(word)).slice(0, MAX_PHRASE_WORDS);
  return make_slug(phrase) || 'topic';
}

/** Where a new doc goes: the folder of the nearby docs, else the domain, else the fallback. Never the knowledge-base root; a fact goes in knowledge-base/facts. */
export function place_new_doc(options: { folder?: string; domain?: string; tier: string }): { dir: string; fallback: boolean } {
  if (options.tier === 'fact') return { dir: 'knowledge-base/facts', fallback: false };
  const dir = options.folder ?? options.domain;
  if (!dir || dir === 'knowledge-base' || dir.startsWith('knowledge-base/')) return { dir: FALLBACK_DOMAIN, fallback: true };
  return { dir, fallback: false };
}
