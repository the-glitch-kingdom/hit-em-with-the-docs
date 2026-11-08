/**
 * Mechanical no-loss check (#59): what a `point` (or a `merge` patch) removes must survive, as whole
 * tokens, in the owner section or the pointer summary. Plain prose words may be reworded; anything a
 * reader acts on may not: every token in code, tables and quotes, and elsewhere every token with a
 * digit, symbol or code-like casing, plus every resolved reference.
 */
import { extract_references } from './references.js';

/** Split on whitespace and markup punctuation; trim sentence punctuation; drop pure-punctuation tokens. */
const extract_tokens = (text: string): string[] =>
  text.split(/[\s()[\]{}<>,;"'`|*“”‘’]+/)
    .map((token) => token.replace(/^[.:!?]+|[.:!?]+$/g, ''))
    .filter((token) => /[\p{L}\p{N}]/u.test(token));

/** Prose tokens that still carry facts: numbers, flags, paths, URLs, ids, CONSTANTS, camelCase. */
const is_fact_like = (token: string): boolean =>
  /\d/.test(token) || /[-_./:@=$~#%+]/.test(token) || /[a-z][A-Z]/.test(token) || /^[A-Z][A-Z0-9]+$/.test(token);

/** Tokens a reader would lose if `removed` disappeared. */
export function extract_loss_tokens(removed: string): string[] {
  const found = new Set<string>();
  let rest = removed;
  // Fenced code: every token matters (a command's plain words are part of it).
  rest = rest.replace(/^(\s*)(```|~~~)[^\n]*\n([\s\S]*?)^\1\2[ \t]*$/gm, (_match, _i, _f, body: string) => { extract_tokens(body).forEach((token) => found.add(token)); return ' '; });
  // Inline code, quoted strings and table rows: every token.
  rest = rest.replace(/`([^`\n]+)`/g, (_match, content: string) => { extract_tokens(content).forEach((token) => found.add(token)); return ' '; });
  rest = rest.replace(/"([^"\n]+)"|“([^”\n]+)”/g, (_match, a?: string, b?: string) => { extract_tokens(a ?? b ?? '').forEach((token) => found.add(token)); return ' '; });
  rest = rest.replace(/^\s*\|.*\|\s*$/gm, (row) => { if (!/^\s*\|[\s:|-]+\|\s*$/.test(row)) extract_tokens(row).forEach((token) => found.add(token)); return ' '; });
  for (const token of extract_tokens(rest)) if (is_fact_like(token)) found.add(token);
  for (const reference of extract_references(removed)) if (reference.kind !== 'doc-link') for (const token of extract_tokens(reference.ref)) found.add(token);
  return [...found];
}

/** Tokens of `removed` found as whole tokens in neither the owner section nor the pointer summary (empty = nothing lost). */
export function find_missing_tokens(removed: string, owner_section: string, summary: string): string[] {
  const keep = new Set(extract_tokens(`${owner_section}\n${summary}`).map((token) => token.toLowerCase()));
  return extract_loss_tokens(removed).filter((token) => !keep.has(token.toLowerCase()));
}
