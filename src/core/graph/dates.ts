/**
 * Change dates for the graph export: last-change date per file (one git pass
 * per repo) and per-doc body-change date (cached by content hash + HEAD).
 * Read-only on git; never throws outside a repo.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { hashContent } from '../reconcile/ledger.js';
import { bodyChange } from '../reconcile/staleness.js';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });

export interface FileDates {
  dates: Map<string, string>; // repo-relative path -> YYYY-MM-DD of its last commit
  /** shallow clone: dates come from the available history only */
  shallow: boolean;
}

/** Last commit date of every file in the repo, one `git log` pass (newest first, first hit wins). Null outside git. */
export function lastChanged(repoRoot: string): FileDates | null {
  try {
    const shallow = git(repoRoot, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
    const dates = new Map<string, string>();
    let date = '';
    for (const line of git(repoRoot, ['log', '-z', '--format=%x01%cs', '--name-only']).split(/[\0\n]/)) {
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
export function bodyChangedDates(
  repoRoot: string,
  docs: Array<{ path: string; content: string }>
): { dates: Map<string, string | null>; walked: number } {
  const dates = new Map<string, string | null>();
  let head: string;
  try {
    head = git(repoRoot, ['rev-parse', 'HEAD']).trim();
  } catch {
    for (const d of docs) dates.set(d.path, null);
    return { dates, walked: 0 };
  }
  let old: Cache | null = null;
  try {
    const c = JSON.parse(readFileSync(join(repoRoot, CACHE), 'utf-8')) as Cache;
    if (c.head === head && c.docs) old = c;
  } catch { /* no cache */ }
  const next: Cache = { head, docs: {} };
  let walked = 0;
  for (const d of docs) {
    const hash = hashContent(d.content);
    let hit = old?.docs[d.path];
    if (!hit || hit.hash !== hash) {
      walked++;
      let changed: string | null = null;
      try { changed = bodyChange(repoRoot, d.path)?.date.slice(0, 10) ?? null; } catch { /* leave null */ }
      hit = { hash, body_changed: changed };
    }
    next.docs[d.path] = hit;
    dates.set(d.path, hit.body_changed);
  }
  try {
    mkdirSync(dirname(join(repoRoot, CACHE)), { recursive: true });
    writeFileSync(join(repoRoot, CACHE), JSON.stringify(next));
  } catch { /* cache is best effort */ }
  return { dates, walked };
}
