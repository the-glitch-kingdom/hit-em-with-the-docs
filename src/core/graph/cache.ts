/**
 * Warm-run cache for the graph export, kept in `.hewtd/graph-cache.json` next to the body-date cache
 * (dates.ts keeps its own `head`/`docs` fields; this module owns `fingerprint` and `staleness`).
 * Anything unreadable, malformed or from another cache version is ignored, never an error.
 */
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { PluginConfig } from '../../utils/config.js';
import type { StalenessSignal } from '../reconcile/staleness.js';

const CACHE_FILE = '.hewtd/graph-cache.json';
const GRAPH_FILE = '.hewtd/graph.json';
const CACHE_VERSION = 1;
const hewtd_version = (createRequire(import.meta.url)('../../../package.json') as { version: string }).version;

export interface Fingerprint { value: string; graph_hash: string }
export interface StalenessCache { head: string; entries: Record<string, StalenessSignal> }
interface CacheFile { cache_version?: number; fingerprint?: Fingerprint; staleness?: StalenessCache; [key: string]: unknown }

const hash_text = (text: string): string => createHash('sha1').update(text).digest('hex');
const run_git = (working_dir: string, args: string[]): string =>
  // eslint-disable-next-line id-denylist -- child_process option name
  execFileSync('git', args, { cwd: working_dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });

function load_cache_file(git_top: string): CacheFile {
  try {
    const cache = JSON.parse(readFileSync(join(git_top, CACHE_FILE), 'utf-8')) as CacheFile;
    return cache && typeof cache === 'object' && !Array.isArray(cache) && cache.cache_version === CACHE_VERSION ? cache : {};
  } catch { return {}; }
}

/** Merge `changes` into the cache file (dates.ts's own fields are kept). Best effort. */
export function write_cache_fields(git_top: string, changes: Pick<CacheFile, 'fingerprint' | 'staleness'>): void {
  try {
    let existing: CacheFile = {};
    try { existing = JSON.parse(readFileSync(join(git_top, CACHE_FILE), 'utf-8')) as CacheFile; } catch { /* none yet */ }
    mkdirSync(dirname(join(git_top, CACHE_FILE)), { recursive: true });
    writeFileSync(join(git_top, CACHE_FILE), JSON.stringify({ ...existing, ...changes, cache_version: CACHE_VERSION }));
  } catch { /* cache is best effort */ }
}

/** Staleness signals reusable at this HEAD (empty when the cache is missing, stale or malformed). */
export function load_staleness_cache(git_top: string, head: string): StalenessCache {
  const cache = load_cache_file(git_top).staleness;
  return cache && cache.head === head && cache.entries && typeof cache.entries === 'object' ? cache : { head, entries: {} };
}

/**
 * Everything the graph is a function of, hashed: HEAD, the working-tree changes (path + content of each),
 * every doc under the docs root (ignored ones too), the ledger, the config, the hewtd version.
 * Null when it cannot be known (no commits, related repos configured): then nothing is skipped.
 */
export function compute_fingerprint(options: { git_top: string; docs_root: string; config: PluginConfig; ledger_path: string; docs: Array<{ path: string; hash: string }> }): string | null {
  const { git_top, config } = options;
  if (config.reconcile.related_repos.length) return null; // a sibling checkout changing is not seen from here
  try {
    const head = run_git(git_top, ['rev-parse', 'HEAD']).trim();
    const dirty = run_git(git_top, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0').filter(Boolean)
      .filter((entry) => entry.slice(3) !== GRAPH_FILE && entry.slice(3) !== CACHE_FILE) // our own output is not an input
      .map((entry) => {
        const file = entry.slice(3);
        let content = '';
        try { content = hash_text(readFileSync(join(git_top, file), 'utf-8')); } catch { /* deleted or a rename's old path */ }
        return `${entry}\0${content}`;
      });
    const ledger = existsSync(options.ledger_path) ? hash_text(readFileSync(options.ledger_path, 'utf-8')) : '';
    return hash_text(JSON.stringify([hewtd_version, head, dirty, ledger, config, options.docs_root, options.docs]));
  } catch { return null; }
}

/** True when the cache holds this fingerprint and `graph_text` is still the file it was computed for. */
export function is_fingerprint_current(git_top: string, value: string | null, graph_text: string): boolean {
  const cached = load_cache_file(git_top).fingerprint;
  return !!value && !!cached && cached.value === value && cached.graph_hash === hash_text(graph_text);
}

export const compute_graph_hash = hash_text;
