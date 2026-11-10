/**
 * Reconcile ledger (#54): one entry per doc so a run can stop and resume.
 * A doc whose content hash changed since review counts as unreviewed again.
 */
import { createHash } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { validate_no_secrets } from './secrets.js';

export interface LedgerEntry {
  path: string;
  lane: string;
  verdict?: string;
  reviewed_on?: string;
  /** A metadata-only verdict (fields, phrases) touched a doc whose earlier review still holds; the review itself is untouched. */
  fields_on?: string;
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

export const compute_content_hash = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

/** Missing or corrupt ledger loads as empty: never throws. */
export async function load_ledger(file: string): Promise<Ledger> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      return { version: 1, entries: parsed.entries };
    }
  } catch {
    /* fall through */
  }
  return { version: 1, entries: {} };
}

/** Atomic: write a unique temp file, then rename over the target. */
export async function write_ledger(file: string, ledger: Ledger): Promise<void> {
  const text = JSON.stringify(ledger, null, 2) + '\n';
  validate_no_secrets(text, 'the reconcile ledger');
  await mkdir(dirname(file), { recursive: true });
  const temp_path = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temp_path, text, 'utf-8');
  await rename(temp_path, file);
}

/** Reviewed = has a verdict and the doc is unchanged since. */
export function is_reviewed(entry: LedgerEntry | undefined, current_hash: string): boolean {
  // A clean doc needs no judgment pass: triage alone settles it, so --next moves past it.
  // A rewrite verdict only records the draft: the doc stays in the queue until the rewrite lands.
  return !!entry && ((!!entry.verdict && entry.verdict !== 'rewrite') || entry.lane === 'clean') && entry.content_hash === current_hash;
}

/** Record a doc's current state; a changed hash drops the old verdict. */
export function build_ledger_entry(
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
  /** Reviewed docs whose metadata was updated after their review. */
  metadata_updated: number;
  next_unreviewed: string[];
}

/** `docs` = every in-scope doc with its current content hash. */
export function get_ledger_status(
  ledger: Ledger,
  docs: { path: string; hash: string }[],
  next = 10
): LedgerStatus {
  const status: LedgerStatus = { total: docs.length, reviewed: 0, by_lane: {}, by_verdict: {}, metadata_updated: 0, next_unreviewed: [] };
  for (const doc of docs) {
    const entry = ledger.entries[doc.path];
    if (entry) status.by_lane[entry.lane] = (status.by_lane[entry.lane] ?? 0) + 1;
    if (is_reviewed(entry, doc.hash)) {
      status.reviewed++;
      if (entry!.fields_on && entry!.fields_on > (entry!.reviewed_on ?? '')) status.metadata_updated++;
      status.by_verdict[entry!.verdict!] = (status.by_verdict[entry!.verdict!] ?? 0) + 1;
    } else if (status.next_unreviewed.length < next) status.next_unreviewed.push(doc.path);
  }
  return status;
}

export interface ExternalRefsStatus {
  /** refs the reviewed docs declare in `external_refs` */
  covered: number;
  /** refs still unresolved (graph `resolved: false`) in reviewed docs */
  still_missing: number;
  docs_still_missing: number;
}

/** Reviewed docs only; `graph` is `.hewtd/graph.json`, `frontmatters` maps doc path to its parsed frontmatter. Throws on a malformed graph. */
export function get_external_refs_status(
  graph: unknown,
  frontmatters: Record<string, Record<string, unknown>>,
  reviewed_paths: string[]
): ExternalRefsStatus {
  // eslint-disable-next-line id-denylist -- serialized key (graph JSON)
  const graph_docs = (graph as { docs?: unknown } | null)?.docs;
  if (typeof graph_docs !== 'object' || graph_docs === null || Array.isArray(graph_docs)) throw new Error('graph.json has no docs map');
  // eslint-disable-next-line id-denylist -- serialized key (graph JSON)
  const docs = graph_docs as Record<string, { refs?: unknown } | undefined>;
  const status: ExternalRefsStatus = { covered: 0, still_missing: 0, docs_still_missing: 0 };
  for (const doc_path of reviewed_paths) {
    const declared = frontmatters[doc_path]?.external_refs;
    if (Array.isArray(declared)) status.covered += new Set(declared.filter((item): item is string => typeof item === 'string')).size;
    // eslint-disable-next-line id-denylist -- serialized key (graph JSON)
    const ref_list = docs[doc_path]?.refs;
    if (ref_list !== undefined && !Array.isArray(ref_list)) throw new Error(`graph.json refs of ${doc_path} is not a list`);
    const missing = (ref_list as { resolved?: unknown }[] | undefined)?.filter((item) => item?.resolved === false).length ?? 0;
    status.still_missing += missing;
    if (missing) status.docs_still_missing++;
  }
  return status;
}
