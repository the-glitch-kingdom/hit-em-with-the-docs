/**
 * Reconcile ledger (#54): one entry per doc so a run can stop and resume.
 * A doc whose content hash changed since review counts as unreviewed again.
 */
import { createHash } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { assert_no_secrets } from './secrets.js';

export interface LedgerEntry {
  path: string;
  lane: string;
  verdict?: string;
  reviewed_on?: string;
  applied_commit?: string;
  review_file?: string;
  /** secret verdict: env names the values moved to (never the values). */
  env_names?: string[];
  /** overview verdict: member path -> content hash when the overview was written; triage re-checks them. */
  members?: Record<string, string>;
  /** point verdict: the owner section this doc's pointer line summarizes, and its hash when applied. */
  pointer?: { target: string; section_hash: string };
  content_hash: string;
}

export interface Ledger {
  version: 1;
  entries: Record<string, LedgerEntry>;
}

export const hash_content = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

/** Missing or corrupt ledger loads as empty: never throws. */
export async function load_ledger(file: string): Promise<Ledger> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf-8'));
    if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') {
      return { version: 1, entries: raw.entries };
    }
  } catch {
    /* fall through */
  }
  return { version: 1, entries: {} };
}

/** Atomic: write a unique temp file, then rename over the target. */
export async function save_ledger(file: string, ledger: Ledger): Promise<void> {
  const text = JSON.stringify(ledger, null, 2) + '\n';
  assert_no_secrets(text, 'the reconcile ledger');
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, text, 'utf-8');
  await rename(tmp, file);
}

/** Reviewed = has a verdict and the doc is unchanged since. */
export function is_reviewed(entry: LedgerEntry | undefined, current_hash: string): boolean {
  // A clean doc needs no judgment pass: triage alone settles it, so --next moves past it.
  // A rewrite verdict only records the draft: the doc stays in the queue until the rewrite lands.
  return !!entry && ((!!entry.verdict && entry.verdict !== 'rewrite') || entry.lane === 'clean') && entry.content_hash === current_hash;
}

/** Record a doc's current state; a changed hash drops the old verdict. */
export function record_entry(
  ledger: Ledger,
  entry: Partial<LedgerEntry> & Pick<LedgerEntry, 'path' | 'lane' | 'content_hash'>
): LedgerEntry {
  const prev = ledger.entries[entry.path];
  const base = prev && prev.content_hash === entry.content_hash ? prev : undefined;
  // What a doc points at (pointer target, overview members) is about the doc's links, not its
  // review: it survives a content change (a verify, any edit) so staleness keeps firing.
  const tracking = prev && !base ? { ...(prev.pointer && { pointer: prev.pointer }), ...(prev.members && { members: prev.members }) } : {};
  const next = { ...tracking, ...base, ...entry } as LedgerEntry;
  ledger.entries[entry.path] = next;
  return next;
}

export interface LedgerStatus {
  total: number;
  reviewed: number;
  by_lane: Record<string, number>;
  by_verdict: Record<string, number>;
  next_unreviewed: string[];
}

/** `docs` = every in-scope doc with its current content hash. */
export function ledger_status(
  ledger: Ledger,
  docs: { path: string; hash: string }[],
  next = 10
): LedgerStatus {
  const s: LedgerStatus = { total: docs.length, reviewed: 0, by_lane: {}, by_verdict: {}, next_unreviewed: [] };
  for (const d of docs) {
    const e = ledger.entries[d.path];
    if (e) s.by_lane[e.lane] = (s.by_lane[e.lane] ?? 0) + 1;
    if (is_reviewed(e, d.hash)) {
      s.reviewed++;
      s.by_verdict[e!.verdict!] = (s.by_verdict[e!.verdict!] ?? 0) + 1;
    } else if (s.next_unreviewed.length < next) s.next_unreviewed.push(d.path);
  }
  return s;
}
