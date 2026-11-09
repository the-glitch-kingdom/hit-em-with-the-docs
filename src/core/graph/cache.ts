/**
 * Warm-run cache for the graph export, kept in `.hewtd/graph-cache.json` next to the body-date cache
 * (dates.ts keeps its own `head`/`docs` fields; this module owns `fingerprint` and `staleness`).
 * Anything unreadable, malformed or from another cache version is ignored, never an error.
 */
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import type { PluginConfig } from '../../utils/config.js';
import type { StalenessSignal } from '../reconcile/staleness.js';
import type { TriageDoc } from '../reconcile/triage.js';
import type { SymbolTable } from '../reconcile/references.js';

const CACHE_FILE = '.hewtd/graph-cache.json';
const GRAPH_FILE = '.hewtd/graph.json';
const CACHE_VERSION = 2;
const hewtd_version = (createRequire(import.meta.url)('../../../package.json') as { version: string }).version;

export interface Fingerprint { value: string; graph_hash: string }
export interface StalenessCache { head: string; entries: Record<string, StalenessSignal> }
/** What the graph reads from triage for one doc. */
export type GraphTriage = Pick<TriageDoc, 'lane' | 'reasons' | 'missing' | 'refs' | 'staleCommits' | 'duplicates'>;
/** One doc's reusable result, valid while its inputs (content, ledger entry, duplicates, `outside` link-target fingerprints) are the same. */
export interface DocEntry { hash: string; ledger: string; duplicates: string; unfound: string[]; outside?: Record<string, string>; triage: GraphTriage }
/**
 * Per-doc entries valid for one code state (hewtd version, config, docs root), written at `head` with the working-tree
 * `dirty` non-doc files (path -> status + content hash) and the `bins` listing; what changed since is worked out from those
 * (`list_committed_changes`, `list_code_changes`). Plus the markdown mentions that made code-less names `unknown`.
 */
export interface DocCache { state: string; head?: string; dirty?: Record<string, string>; bins?: string[]; entries: Record<string, DocEntry>; mentions: Record<string, string[]> }
interface CacheFile { cache_version?: number; fingerprint?: Fingerprint; staleness?: StalenessCache; doc_cache?: DocCache; symbol_cache?: { state: string; symbols: Array<[string, string | null, string | null]> }; [key: string]: unknown }

const hash_text = (text: string): string => createHash('sha1').update(text).digest('hex');
/** What a doc-link's status depends on for a target that is not a kept doc: absent, a directory or a file (anchor mismatches are advisory only, never a status). */
export function compute_link_fingerprint(abs_path: string): string {
  try { return statSync(abs_path).isFile() ? 'file' : 'dir'; } catch { return 'absent'; }
}
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
export function write_cache_fields(git_top: string, changes: Pick<CacheFile, 'fingerprint' | 'staleness' | 'doc_cache' | 'symbol_cache'>): void {
  try {
    let existing: CacheFile = {};
    try { existing = JSON.parse(readFileSync(join(git_top, CACHE_FILE), 'utf-8')) as CacheFile; } catch { /* none yet */ }
    mkdirSync(dirname(join(git_top, CACHE_FILE)), { recursive: true });
    writeFileSync(join(git_top, CACHE_FILE), JSON.stringify({ ...existing, ...changes, cache_version: CACHE_VERSION }));
  } catch { /* cache is best effort */ }
}

/**
 * Paths touched by the commits from `from` to `to`, renames as delete + add: the net diff plus every path any commit in
 * the range names (a change and its revert still add commits to a cited file); null when `from` is not an ancestor of `to`
 * (amend, rebase, branch switch) or unknown.
 */
export function list_committed_changes(git_top: string, from: string, to: string): Set<string> | null {
  try {
    if (from === to) return new Set();
    run_git(git_top, ['merge-base', '--is-ancestor', from, to]);
    const range = `${from}..${to}`;
    return new Set([...run_git(git_top, ['diff', '--name-only', '--no-renames', '-z', from, to]).split('\0'), ...run_git(git_top, ['log', '--name-only', '--no-renames', '-z', '--format=', range]).split('\0')].filter(Boolean));
  } catch { return null; }
}

/** Every path whose content may differ from the cached run: committed since its head plus dirty files that are new, gone or changed (both directions). */
export function list_code_changes(prior: DocCache, snapshot: CodeSnapshot, committed: Set<string>): Set<string> {
  const changes = new Set(committed);
  const old_dirty = prior.dirty ?? {};
  for (const file of new Set([...Object.keys(old_dirty), ...Object.keys(snapshot.dirty)])) if (old_dirty[file] !== snapshot.dirty[file]) changes.add(file);
  return changes;
}

/** Staleness signals reusable at this HEAD (empty when the cache is missing, stale or malformed). */
export function load_staleness_cache(git_top: string, head: string): StalenessCache {
  const cache = load_cache_file(git_top).staleness;
  return cache && cache.head === head && cache.entries && typeof cache.entries === 'object' ? cache : { head, entries: {} };
}

/** The gitignored `node_modules/.bin` listing, sorted: triage resolves `npx <bin>` against it. */
function list_bins(git_top: string): string[] {
  try { return readdirSync(join(git_top, 'node_modules/.bin')).sort(); } catch { return []; }
}

/**
 * Everything the graph is a function of, hashed: HEAD, the working-tree changes (path + content of each),
 * every doc under the docs root (ignored ones too), the ledger, the config, the hewtd version, the `.bin` listing.
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
    return hash_text(JSON.stringify([hewtd_version, head, dirty, ledger, config, options.docs_root, options.docs, list_bins(git_top)]));
  } catch { return null; }
}

/** True when the cache holds this fingerprint and `graph_text` is still the file it was computed for. */
export function is_fingerprint_current(git_top: string, value: string | null, graph_text: string): boolean {
  const cached = load_cache_file(git_top).fingerprint;
  return !!value && !!cached && cached.value === value && cached.graph_hash === hash_text(graph_text);
}

export const compute_graph_hash = hash_text;

/** Per-doc entries reusable under this code state (empty when the state differs or the cache is missing or malformed). */
export function load_doc_cache(git_top: string, state: string | null): DocCache {
  const cache = load_cache_file(git_top).doc_cache;
  return state && cache && cache.state === state && cache.entries && typeof cache.entries === 'object' ? cache : { state: state ?? '', entries: {}, mentions: {} };
}

/** Symbol answers reusable under this code state (empty when the state differs or the cache is missing or malformed). */
export function load_symbol_table(git_top: string, state: string | null): SymbolTable {
  const cache = load_cache_file(git_top).symbol_cache;
  const table: SymbolTable = { state: state ?? '', symbols: new Map() };
  if (!state || !cache || cache.state !== state || !Array.isArray(cache.symbols)) return table;
  for (const row of cache.symbols) {
    if (Array.isArray(row) && typeof row[0] === 'string' && (row[1] === null || typeof row[1] === 'string') && (row[2] === null || row[2] === 'definition' || row[2] === 'reference')) table.symbols.set(row[0], [row[1], row[2]]);
  }
  return table;
}

export const dump_symbol_table = (table: SymbolTable): NonNullable<CacheFile['symbol_cache']> => ({ state: table.state, symbols: [...table.symbols].map(([name, [file, kind]]) => [name, file, kind]) });

/** What a run's cache entries are valid for: the key (`state`) plus the code HEAD, dirty non-doc files and `node_modules/.bin` listing they were computed at. */
export interface CodeSnapshot { state: string; head: string; dirty: Record<string, string>; bins: string[] }

/**
 * The code state of this run. `state` keeps only what invalidates every entry: the hewtd version, config and docs root.
 * HEAD, the dirty non-doc files (path -> status + content; markdown under the docs root counts only when the git index differs
 * from HEAD for it, their content is the per-doc hash; our own output and the ledger are left out) and the `.bin` listing
 * (triage resolves `npx <bin>` against it) are stored beside the entries and diffed next run. Null when it cannot be known (no commits, related repos).
 */
export function compute_code_snapshot(options: { git_top: string; docs_root: string; config: PluginConfig; ledger_path: string }): CodeSnapshot | null {
  const { git_top, config } = options;
  if (config.reconcile.related_repos.length) return null;
  try {
    const head = run_git(git_top, ['rev-parse', 'HEAD']).trim(); // no commits: unknown
    const docs_prefix = relative(git_top, options.docs_root).split('\\').join('/');
    const ledger_file = relative(git_top, options.ledger_path).split('\\').join('/');
    const tokens = run_git(git_top, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0');
    const dirty: Record<string, string> = {};
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i]!;
      if (!entry) continue;
      const status = entry.slice(0, 2);
      const file = entry.slice(3);
      if (/[RC]/.test(status)) dirty[tokens[++i]!] = 'gone'; // a rename's old path
      if (file === GRAPH_FILE || file === CACHE_FILE || file === ledger_file) continue;
      if (file.endsWith('.md') && (!docs_prefix || file.startsWith(`${docs_prefix}/`))) { if ('ADRC'.includes(status[0]!)) dirty[file] = status[0]!; continue; } // only a change to the index matters
      let content = '';
      try { content = hash_text(readFileSync(join(git_top, file), 'utf-8')); } catch { /* deleted */ }
      dirty[file] = `${status}\0${content}`;
    }
    return { state: hash_text(JSON.stringify([hewtd_version, config, options.docs_root])), head, dirty, bins: list_bins(git_top) };
  } catch { return null; }
}
