/** Mechanical no-loss check (#59): what a `point` removes must survive in the owner section or the pointer summary. */
import { extractReferences } from './references.js';

const FLAG = /(?<![\w-])--?[A-Za-z][\w-]*(?:=\S+)?/g;
const NUM_UNIT = /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds?|mins?|minutes?|h|hours?|days?|[KMGT]i?B|kb|mb|gb|tb|%|x|rpm|rps|qps)\b/gi;
const IDENT = /\b(?:[a-z]+(?:[A-Z][a-z0-9]+)+|[A-Za-z]\w*_\w+|[A-Z][A-Z0-9_]{2,})\b/g;
const CODE_SPAN = /`([^`\n]+)`/g;

/** Tokens a reader would lose: references, flags, numbers with units, identifiers, inline-code spans. */
export function lossTokens(removed: string): string[] {
  const out = new Set<string>();
  for (const r of extractReferences(removed)) if (r.kind !== 'doc-link') out.add(r.ref);
  for (const re of [FLAG, NUM_UNIT, IDENT]) for (const m of removed.matchAll(re)) out.add(m[0].replace(/\s+/g, ' '));
  for (const m of removed.matchAll(CODE_SPAN)) out.add(m[1]!.trim());
  out.delete('');
  return [...out];
}

/** Tokens of `removed` found in neither the owner section nor the pointer summary (empty = nothing lost). */
export function missingTokens(removed: string, ownerSection: string, summary: string): string[] {
  const keep = `${ownerSection}\n${summary}`;
  const norm = (s: string) => s.replace(/\s+/g, ' ');
  const hay = norm(keep);
  return lossTokens(removed).filter((t) => !hay.includes(norm(t)));
}
