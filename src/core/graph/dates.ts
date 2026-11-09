/**
 * Change dates for the graph export: last-change date per file (one git pass
 * per repo) and per-doc body-change date (cached by content hash + HEAD).
 * Read-only on git; never throws outside a repo.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { compute_content_hash } from '../reconcile/ledger.js';
import { find_body_change } from '../reconcile/staleness.js';

const run_git = (working_dir: string, args: string[]): string =>
  // eslint-disable-next-line id-denylist -- child_process option name
  execFileSync('git', args, { cwd: working_dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });

export interface FileDates {
  dates: Map<string, string>; // repo-relative path -> YYYY-MM-DD of its last commit
  /** shallow clone: dates come from the available history only */
  shallow: boolean;
}

/** Last commit date of every file in the repo, one `git log` pass (newest first, first hit wins). Null outside git. */
export function find_file_dates(repo_root: string): FileDates | null {
  try {
    const shallow = run_git(repo_root, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
    const dates = new Map<string, string>();
    let date = '';
    for (const line of run_git(repo_root, ['log', '-z', '--format=%x01%cs', '--name-only']).split(/[\0\n]/)) {
      if (line.startsWith('\x01')) date = line.slice(1);
      else if (line && date && !dates.has(line)) dates.set(line, date);
    }
    return { dates, shallow };
  } catch {
    return null;
  }
}

const CACHE = '.hewtd/graph-cache.json';
interface Cache { head: string; docs: Record<string, { hash: string; body_changed: string | null }> }

/**
 * Body-change date (YYYY-MM-DD) per doc. Entries are reused when HEAD and the
 * doc's content hash are unchanged, so unchanged docs are not walked again.
 * `walked` counts the docs that needed a git walk.
 */
export function find_body_changed_dates(
  repo_root: string,
  docs: Array<{ path: string; content: string }>,
  options: { persist?: boolean } = {}
): { dates: Map<string, string | null>; walked: number } {
  const dates = new Map<string, string | null>();
  let head: string;
  try {
    head = run_git(repo_root, ['rev-parse', 'HEAD']).trim();
  } catch {
    for (const doc of docs) dates.set(doc.path, null);
    return { dates, walked: 0 };
  }
  let old: Cache | null = null;
  let others: Record<string, unknown> = {}; // fields cache.ts owns: kept on write
  try {
    const cache = JSON.parse(readFileSync(join(repo_root, CACHE), 'utf-8')) as Cache;
    if (cache.head === head && cache.docs) old = cache;
    others = cache as unknown as Record<string, unknown>;
  } catch { /* no cache */ }
  const next: Cache = { head, docs: {} };
  let walked = 0;
  for (const doc of docs) {
    const hash = compute_content_hash(doc.content);
    let cached = old?.docs[doc.path];
    if (!cached || cached.hash !== hash) {
      walked++;
      let changed: string | null = null;
      try { changed = find_body_change(repo_root, doc.path)?.date.slice(0, 10) ?? null; } catch { /* leave null */ }
      cached = { hash, body_changed: changed };
    }
    next.docs[doc.path] = cached;
    dates.set(doc.path, cached.body_changed);
  }
  if (options.persist !== false) try {
    mkdirSync(dirname(join(repo_root, CACHE)), { recursive: true });
    writeFileSync(join(repo_root, CACHE), JSON.stringify({ ...others, ...next }));
  } catch { /* cache is best effort */ }
  return { dates, walked };
}
