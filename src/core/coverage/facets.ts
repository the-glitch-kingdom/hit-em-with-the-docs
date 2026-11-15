/**
 * Facets (#113): one fact a correct written answer must contain, given as a regex by the retrieval eval
 * (semantic-memory#101). Facet regexes are untrusted input: compiled behind guards, never run on unbounded text.
 * Shared by `reconcile --gaps` and, later, `hewtd coverage`.
 */

/** A miss to plan: the fields of a gaps.v1 entry / eval question the engine reads (semantic-memory#101). */
export interface CoverageMiss {
  /** The entry's id, or `gaps[<index>]` when it has none. */
  key: string;
  query: string;
  count: number;
  tier?: string;
  blind?: boolean;
  facets: string[];
  missing_facets?: string[];
  nearest_doc?: { path: string; facet_coverage: string; rank: number | null };
  expected?: string[];
}

/** Longest facet source accepted: eval facets are short; a long pattern is almost always a pasted code line. */
export const MAX_FACET_LENGTH = 300;
/** Longest text one facet test sees; the rest is ignored, so a slow pattern cannot run on a huge line or document. */
export const MAX_TEST_TEXT = 20_000;
// shortcut: a nested quantifier is refused by shape, not by timing (JS regexes cannot be interrupted); upgrade to a worker with a timeout if real facets need them
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/;

export interface CompiledFacet { regex?: RegExp; error?: string }

export function compile_facet(source: string): CompiledFacet {
  if (!source.trim()) return { error: 'empty' };
  if (source.length > MAX_FACET_LENGTH) return { error: `longer than ${MAX_FACET_LENGTH} characters` };
  if (NESTED_QUANTIFIER.test(source)) return { error: 'nested quantifier (could match for a very long time)' };
  try {
    return { regex: new RegExp(source, 'i') };
  } catch (error) {
    return { error: `not a valid regex (${(error as Error).message.replace(/^Invalid regular expression: /, '')})` };
  }
}

export const test_facet = (regex: RegExp, text: string): boolean => regex.test(text.length > MAX_TEST_TEXT ? text.slice(0, MAX_TEST_TEXT) : text);

/** Facet copied from a code line (#101 section 3): it will not match prose, so a "coverage" label built on it may be facet shape. */
export const is_code_line_facet = (source: string): boolean =>
  /\s=\s|(?:^|\s)(?:def|class|function|const|let|var|interface)\s|=>|:\s*(?:str|string|int|number|bool|boolean|float)\b|[;{]\s*$/.test(source);
