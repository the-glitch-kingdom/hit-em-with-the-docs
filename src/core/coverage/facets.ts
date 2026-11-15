/**
 * Facets (#113): one fact a correct written answer must contain, given as a regex by the retrieval eval
 * (semantic-memory#101). Facet regexes are untrusted input: compiled behind guards, never run on unbounded text.
 * Shared by `reconcile --gaps` and, later, `hewtd coverage`.
 */
import vm from 'vm';

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
// a fast first filter for the obvious catastrophic shapes; match_facets' time limit catches the rest
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*|](?:[^()\\]|\\.)*\)[+*{]/; // a `|` group under a quantifier counts: (a|aa)*b backtracks exponentially

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

/** Time one match_facets call may take: a regex runs inside a vm context, whose timeout interrupts a runaway pattern. */
export const FACET_TIME_LIMIT_MS = 500;
const match_context = vm.createContext({});
vm.runInContext('globalThis.run = (regexes, lines, limit) => regexes.map((regex) => { const found = []; for (let i = 0; i < lines.length && found.length < limit; i++) if (regex.test(lines[i])) found.push(i); return found; })', match_context);
const match_script = new vm.Script('run(regexes, lines, limit)');
/** Facet sources that ran out of time once: they are not run again in this process. */
const timed_out = new Set<string>();

function run_matching(regexes: RegExp[], lines: string[], limit: number): number[][] {
  Object.assign(match_context, { regexes, lines, limit });
  try {
    return (match_script.runInContext(match_context, { timeout: FACET_TIME_LIMIT_MS }) as number[][]).map((found) => [...found]);
  } finally {
    Object.assign(match_context, { regexes: undefined, lines: undefined });
  }
}

/**
 * For each regex: the indexes of the lines it matches, at most `limit`, or null when it ran out of time (it is
 * then treated as matching nothing and never run again). Lines are cut at MAX_TEST_TEXT.
 */
export function match_facets(regexes: RegExp[], lines: string[], limit: number): (number[] | null)[] {
  const cut = lines.map((line) => (line.length > MAX_TEST_TEXT ? line.slice(0, MAX_TEST_TEXT) : line));
  const live = regexes.filter((regex) => !timed_out.has(regex.source));
  let found: Map<RegExp, number[] | null>;
  try {
    const batch = live.length ? run_matching(live, cut, limit) : [];
    found = new Map(live.map((regex, i) => [regex, batch[i]!]));
  } catch {
    // the batch ran out of time: run each regex alone to find the slow one(s)
    found = new Map(live.map((regex) => {
      try { return [regex, run_matching([regex], cut, limit)[0]!]; } catch { timed_out.add(regex.source); return [regex, null]; }
    }));
  }
  return regexes.map((regex) => (timed_out.has(regex.source) ? null : found.get(regex) ?? null));
}

/** Facet sources that ran out of time in this process, for the run's warnings. */
export const list_timed_out_facets = (): string[] => [...timed_out];

/** Facet copied from a code line (#101 section 3): it will not match prose, so a "coverage" label built on it may be facet shape. */
export const is_code_line_facet = (source: string): boolean =>
  /\s=\s|(?:^|\s)(?:def|class|function|const|let|var|interface)\s|=>|:\s*(?:str|string|int|number|bool|boolean|float)\b|[;{]\s*$/.test(source);

/** Fewer word characters than this (regex syntax stripped) makes a facet weak: it matches half the codebase (#115). */
export const WEAK_MIN_WORD_CHARS = 4;
/** A facet too short, numeric or punctuation-only to locate code on its own: `410`, `30\\.0`, `\\b5\\b`. */
export function is_weak_facet(source: string): boolean {
  const text = source.replace(/\\[a-zA-Z]/g, '').replace(/\\/g, '').replace(/[\^$.*+?()[\]{}|]/g, '');
  return (text.match(/\w/g) ?? []).length < WEAK_MIN_WORD_CHARS || !/[a-z_]/i.test(text);
}
