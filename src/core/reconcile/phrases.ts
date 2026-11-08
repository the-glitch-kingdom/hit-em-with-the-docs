/**
 * Gap queries -> clean user_phrase candidates (#66): normalize, secret-scan, merge near-duplicates, cap.
 * Pure. A dropped secret query is reported by masked rule note only, never its text.
 */
import { scan_text } from './secrets.js';
import type { SecretsConfig } from '../../utils/config.js';

export interface PhraseInput { query: string; count?: number | undefined }
export type DropReason = 'too short' | 'too long' | 'secret' | 'duplicate' | 'over cap';
export interface DroppedPhrase { query: string; reason: DropReason; note?: string }
export interface PhraseResult { accepted: PhraseInput[]; dropped: DroppedPhrase[] }

const STOP = new Set('a an the is are was were be do does did i we you it of to in on for how what where when why can my our and or with this that'.split(' '));

/** Trim, collapse whitespace, strip trailing punctuation; keeps the reader's casing. */
export const normalize_query = (query: string): string => query.replace(/\s+/g, ' ').trim().replace(/[\s?!.,;:]+$/, '');

const extract_tokens = (text: string): Set<string> => new Set((text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((word) => !STOP.has(word)));

/**
 * Token-set Jaccard >= 0.8 (stop words removed), or one set contained in the other when the
 * smaller has >= 2 tokens and the larger adds at most one (so one shared keyword never merges).
 */
export function is_near_duplicate(a: string, b: string): boolean {
  const left_tokens = extract_tokens(a), right_tokens = extract_tokens(b);
  if (!left_tokens.size || !right_tokens.size) return a.toLowerCase() === b.toLowerCase();
  const shared = [...left_tokens].filter((token) => right_tokens.has(token)).length;
  const smaller = Math.min(left_tokens.size, right_tokens.size);
  return (shared === smaller && smaller >= 2 && Math.max(left_tokens.size, right_tokens.size) - smaller <= 1) || shared / (left_tokens.size + right_tokens.size - shared) >= 0.8;
}

/** `existing` = the doc's current user_phrase/symptoms text; they count toward `max`. */
export function build_phrases(inputs: PhraseInput[], existing: string[], secrets: SecretsConfig, max: number): PhraseResult {
  const dropped: DroppedPhrase[] = [];
  const usable: PhraseInput[] = [];
  for (const input of inputs) {
    const finding = scan_text(input.query, 'gaps', secrets)[0];
    if (finding) { dropped.push({ query: '[redacted]', reason: 'secret', note: `${finding.rule}, ${finding.masked}` }); continue; }
    const query = normalize_query(input.query);
    const word_count = query.split(' ').filter(Boolean).length;
    if (word_count < 3) { dropped.push({ query, reason: 'too short' }); continue; }
    if (query.length > 200) { dropped.push({ query, reason: 'too long' }); continue; }
    usable.push({ query, count: input.count });
  }
  // Most frequent wins, then shortest.
  usable.sort((a, b) => (b.count ?? 1) - (a.count ?? 1) || a.query.length - b.query.length);
  const kept: PhraseInput[] = [];
  for (const phrase of usable) {
    if (existing.some((entry) => is_near_duplicate(entry, phrase.query)) || kept.some((kept_phrase) => is_near_duplicate(kept_phrase.query, phrase.query))) dropped.push({ query: phrase.query, reason: 'duplicate' });
    else kept.push(phrase);
  }
  const room = Math.max(0, max - existing.length);
  for (const phrase of kept.slice(room)) dropped.push({ query: phrase.query, reason: 'over cap' });
  return { accepted: kept.slice(0, room), dropped };
}
