/**
 * Reconcile ledger (#54): one entry per doc so a run can stop and resume.
 * A doc whose content hash changed since review counts as unreviewed again.
 */
import { createHash } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { assertNoSecrets } from './secrets.js';

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

export const hashContent = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

/** Missing or corrupt ledger loads as empty: never throws. */
export async function loadLedger(file: string): Promise<Ledger> {
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
export async function saveLedger(file: string, ledger: Ledger): Promise<void> {
  const text = JSON.stringify(ledger, null, 2) + '\n';
  assertNoSecrets(text, 'the reconcile ledger');
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, text, 'utf-8');
  await rename(tmp, file);
}

/** Reviewed = has a verdict and the doc is unchanged since. */
export function isReviewed(entry: LedgerEntry | undefined, currentHash: string): boolean {
  // A clean doc needs no judgment pass: triage alone settles it, so --next moves past it.
  // A rewrite verdict only records the draft: the doc stays in the queue until the rewrite lands.
  return !!entry && ((!!entry.verdict && entry.verdict !== 'rewrite') || entry.lane === 'clean') && entry.content_hash === currentHash;
}

/** Record a doc's current state; a changed hash drops the old verdict. */
export function recordEntry(
  ledger: Ledger,
  entry: Partial<LedgerEntry> & Pick<LedgerEntry, 'path' | 'lane' | 'content_hash'>
): LedgerEntry {
  const prev = ledger.entries[entry.path];
  const base = prev && prev.content_hash === entry.content_hash ? prev : undefined;
  const next = { ...base, ...entry } as LedgerEntry;
  ledger.entries[entry.path] = next;
  return next;
}

export interface LedgerStatus {
  total: number;
  reviewed: number;
  byLane: Record<string, number>;
  byVerdict: Record<string, number>;
  nextUnreviewed: string[];
}

/** `docs` = every in-scope doc with its current content hash. */
export function ledgerStatus(
  ledger: Ledger,
  docs: { path: string; hash: string }[],
  next = 10
): LedgerStatus {
  const s: LedgerStatus = { total: docs.length, reviewed: 0, byLane: {}, byVerdict: {}, nextUnreviewed: [] };
  for (const d of docs) {
    const e = ledger.entries[d.path];
    if (e) s.byLane[e.lane] = (s.byLane[e.lane] ?? 0) + 1;
    if (isReviewed(e, d.hash)) {
      s.reviewed++;
      s.byVerdict[e!.verdict!] = (s.byVerdict[e!.verdict!] ?? 0) + 1;
    } else if (s.nextUnreviewed.length < next) s.nextUnreviewed.push(d.path);
  }
  return s;
}
