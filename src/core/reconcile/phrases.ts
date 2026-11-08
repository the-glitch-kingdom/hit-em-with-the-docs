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
export const normalize_query = (q: string): string => q.replace(/\s+/g, ' ').trim().replace(/[\s?!.,;:]+$/, '');

const tokens = (s: string): Set<string> => new Set((s.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((w) => !STOP.has(w)));

/**
 * Token-set Jaccard >= 0.8 (stop words removed), or one set contained in the other when the
 * smaller has >= 2 tokens and the larger adds at most one (so one shared keyword never merges).
 */
export function near_duplicate(a: string, b: string): boolean {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return a.toLowerCase() === b.toLowerCase();
  const inter = [...x].filter((t) => y.has(t)).length;
  const lo = Math.min(x.size, y.size);
  return (inter === lo && lo >= 2 && Math.max(x.size, y.size) - lo <= 1) || inter / (x.size + y.size - inter) >= 0.8;
}

/** `existing` = the doc's current user_phrase/symptoms text; they count toward `max`. */
export function build_phrases(inputs: PhraseInput[], existing: string[], secrets: SecretsConfig, max: number): PhraseResult {
  const dropped: DroppedPhrase[] = [];
  const ok: PhraseInput[] = [];
  for (const i of inputs) {
    const hit = scan_text(i.query, 'gaps', secrets)[0];
    if (hit) { dropped.push({ query: '[redacted]', reason: 'secret', note: `${hit.rule}, ${hit.masked}` }); continue; }
    const query = normalize_query(i.query);
    const n = query.split(' ').filter(Boolean).length;
    if (n < 3) { dropped.push({ query, reason: 'too short' }); continue; }
    if (query.length > 200) { dropped.push({ query, reason: 'too long' }); continue; }
    ok.push({ query, count: i.count });
  }
  // Most frequent wins, then shortest.
  ok.sort((a, b) => (b.count ?? 1) - (a.count ?? 1) || a.query.length - b.query.length);
  const kept: PhraseInput[] = [];
  for (const c of ok) {
    if (existing.some((e) => near_duplicate(e, c.query)) || kept.some((k) => near_duplicate(k.query, c.query))) dropped.push({ query: c.query, reason: 'duplicate' });
    else kept.push(c);
  }
  const room = Math.max(0, max - existing.length);
  for (const c of kept.slice(room)) dropped.push({ query: c.query, reason: 'over cap' });
  return { accepted: kept.slice(0, room), dropped };
}
