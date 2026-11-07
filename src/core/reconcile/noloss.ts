/**
 * Mechanical no-loss check (#59): what a `point` (or a `merge` patch) removes must survive, as whole
 * tokens, in the owner section or the pointer summary. Plain prose words may be reworded; anything a
 * reader acts on may not: every token in code, tables and quotes, and elsewhere every token with a
 * digit, symbol or code-like casing, plus every resolved reference.
 */
import { extractReferences } from './references.js';

/** Split on whitespace and markup punctuation; trim sentence punctuation; drop pure-punctuation tokens. */
const tokens = (text: string): string[] =>
  text.split(/[\s()[\]{}<>,;"'`|*“”‘’]+/)
    .map((t) => t.replace(/^[.:!?]+|[.:!?]+$/g, ''))
    .filter((t) => /[\p{L}\p{N}]/u.test(t));

/** Prose tokens that still carry facts: numbers, flags, paths, URLs, ids, CONSTANTS, camelCase. */
const factLike = (t: string): boolean =>
  /\d/.test(t) || /[-_./:@=$~#%+]/.test(t) || /[a-z][A-Z]/.test(t) || /^[A-Z][A-Z0-9]+$/.test(t);

/** Tokens a reader would lose if `removed` disappeared. */
export function lossTokens(removed: string): string[] {
  const out = new Set<string>();
  let rest = removed;
  // Fenced code: every token matters (a command's plain words are part of it).
  rest = rest.replace(/^(\s*)(```|~~~)[^\n]*\n([\s\S]*?)^\1\2[ \t]*$/gm, (_m, _i, _f, body: string) => { tokens(body).forEach((t) => out.add(t)); return ' '; });
  // Inline code, quoted strings and table rows: every token.
  rest = rest.replace(/`([^`\n]+)`/g, (_m, c: string) => { tokens(c).forEach((t) => out.add(t)); return ' '; });
  rest = rest.replace(/"([^"\n]+)"|“([^”\n]+)”/g, (_m, a?: string, b?: string) => { tokens(a ?? b ?? '').forEach((t) => out.add(t)); return ' '; });
  rest = rest.replace(/^\s*\|.*\|\s*$/gm, (row) => { if (!/^\s*\|[\s:|-]+\|\s*$/.test(row)) tokens(row).forEach((t) => out.add(t)); return ' '; });
  for (const t of tokens(rest)) if (factLike(t)) out.add(t);
  for (const r of extractReferences(removed)) if (r.kind !== 'doc-link') for (const t of tokens(r.ref)) out.add(t);
  return [...out];
}

/** Tokens of `removed` found as whole tokens in neither the owner section nor the pointer summary (empty = nothing lost). */
export function missingTokens(removed: string, ownerSection: string, summary: string): string[] {
  const keep = new Set(tokens(`${ownerSection}\n${summary}`).map((t) => t.toLowerCase()));
  return lossTokens(removed).filter((t) => !keep.has(t.toLowerCase()));
}
