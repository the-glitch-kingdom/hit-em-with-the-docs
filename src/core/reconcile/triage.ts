/**
 * Reconcile triage (#54): sort in-scope docs into lanes, estimate the judgment
 * pass, plan a serial run or an agent team. Deterministic; writes nothing to
 * the docs tree (the ledger lives elsewhere).
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { readdir } from 'fs/promises';
import { join, relative, resolve } from 'path';
import { parseFrontmatter } from '../../utils/frontmatter.js';
import type { PluginConfig } from '../../utils/config.js';
import { checkRetrieval } from '../audit/retrieval.js';
import { findClusters } from '../links/clusters.js';
import { buildRepoIndex, extractReferences, primeSymbols, resolveReferences, type ResolvedReference } from './references.js';
import { stalenessSignal } from './staleness.js';
import { hashContent, isReviewed, recordEntry, type Ledger } from './ledger.js';

export type Lane = 'clean' | 'fields-only' | 'check' | 'archive-candidate';

/** Commits to cited files since the doc last changed that push a doc to `check`. */
export const STALE_COMMITS_BAR = 10;
const LOCKFILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock)$/;
const ARCHIVE_MIN_CHECKABLE = 3;
const ARCHIVE_MISSING_SHARE = 0.6;

export interface TriageDoc {
  /** Relative to the docs path, posix. */
  path: string;
  lane: Lane;
  reasons: string[];
  missing: string[];
  /** Doc bytes + bytes of the cited files the judgment pass must read. */
  bytes: number;
  staleCommits?: number;
}

export interface Shard {
  id: number;
  docs: string[];
  bytes: number;
}

export interface TriageResult {
  docs: TriageDoc[];
  totals: { docs: number; bytes: number; byLane: Record<Lane, number>; judgmentDocs: number; judgmentBytes: number };
  mode: 'serial' | 'team';
  shards: Shard[];
  warnings: string[];
}

const posix = (p: string): string => p.split('\\').join('/');

async function mdFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.name === 'archive' || e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.md') && e.name !== 'INDEX.md' && e.name !== 'REGISTRY.md') out.push(p);
    }
  };
  await walk(dir);
  return out;
}

/**
 * Scope args: a file, a folder or a domain name (a folder under the docs path).
 * With `next`, only the first N docs the ledger has not reviewed (or that changed since).
 * No args and no `next` is an error: never the whole tree by default.
 */
export async function resolveScope(
  docsPath: string,
  args: string[],
  opts: { next?: number; ledger?: Ledger } = {}
): Promise<string[]> {
  if (!args.length && !opts.next) throw new Error('Name a scope (domain, folder or files) or pass --next <n>; reconcile never runs on the whole tree by default.');
  const set = new Set<string>();
  if (!args.length) for (const f of await mdFiles(docsPath)) set.add(f);
  for (const a of args) {
    const cands = [resolve(a), resolve(docsPath, a)];
    const hit = cands.find((c) => existsSync(c) && (c === docsPath || c.startsWith(docsPath + '/')));
    if (!hit) throw new Error(`Scope "${a}" is not a file, folder or domain under ${docsPath}`);
    if (statSync(hit).isDirectory()) for (const f of await mdFiles(hit)) set.add(f);
    else set.add(hit);
  }
  let rels = [...set].map((f) => posix(relative(docsPath, f))).sort();
  if (opts.next) {
    rels = rels
      .filter((r) => !isReviewed(opts.ledger?.entries[r], hashContent(readFileSync(join(docsPath, r), 'utf-8'))))
      .slice(0, opts.next);
  }
  return rels;
}

export function gitRoot(dir: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

/** Scope files with uncommitted changes (tracked or untracked). Empty outside a git repo. */
export function dirtyInScope(docsPath: string, rels: string[]): string[] {
  const root = gitRoot(docsPath);
  if (!root || !rels.length) return [];
  const out = execFileSync('git', ['status', '--porcelain', '--', ...rels.map((r) => join(docsPath, r))], {
    cwd: root, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.split('\n').filter(Boolean).map((l) => l.slice(3));
}

const nonEmpty = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : !!v);

function isAttributed(data: Record<string, unknown>): boolean {
  const sym = Array.isArray(data.symptoms) ? data.symptoms : [];
  const cited =
    nonEmpty(data.sources) || nonEmpty(data.provenance) || nonEmpty(data.cites) ||
    sym.some((s) => s && typeof s === 'object' && nonEmpty((s as { cites?: unknown }).cites));
  return cited && nonEmpty(data.last_verified);
}

export async function triage(opts: {
  root: string;
  docsPath: string;
  rels: string[];
  config: PluginConfig;
  mode?: 'serial' | 'team';
  ledger?: Ledger;
}): Promise<TriageResult> {
  const { docsPath, rels, config } = opts;
  const repo = gitRoot(docsPath) ?? opts.root;
  const idx = buildRepoIndex(repo, config.reconcile.schema_sources);
  const warnings: string[] = [];

  const loaded = rels.map((rel) => {
    const raw = readFileSync(join(docsPath, rel), 'utf-8');
    const { data, content } = parseFrontmatter<Record<string, unknown>>(raw);
    return { rel, raw, data, body: content, refs: extractReferences(content) };
  });
  primeSymbols(idx, loaded.flatMap((d) => d.refs.filter((r) => r.kind === 'symbol' || r.kind === 'env').map((r) => r.ref)));

  const retrieval = checkRetrieval(
    loaded.map((d) => ({ rel: d.rel, data: d.data, body: d.body })),
    config.retrieval
  );
  const needsFields = new Set(retrieval.filter((i) => /MISSING_PURPOSE|WEAK_PURPOSE|MISSING_SYMPTOMS/.test(i.rule)).map((i) => i.file));

  const docs: TriageDoc[] = [];
  let staleWarned = false;
  for (const d of loaded) {
    const abs = join(docsPath, d.rel);
    const resolved: ResolvedReference[] = await resolveReferences(idx, d.refs, { docFile: abs, docsPath });
    const sources = Array.isArray(d.data.sources) ? d.data.sources.filter((s): s is string => typeof s === 'string') : [];
    // Only path-like sources are checkable; URLs and prose citations are not claims about the repo.
    const pathSources = sources.filter((s) => !/^[a-z]+:\/\//i.test(s) && !/\s/.test(s) && /\.\w+$/.test(s));
    const goneSources = pathSources.filter((s) => !idx.files.has(s));
    const missing = [...new Set([...resolved.filter((r) => r.status === 'missing').map((r) => r.ref), ...goneSources])];
    const checkable = resolved.filter((r) => r.status !== 'unknown').length + pathSources.length;

    const cited = [...new Set([...resolved.map((r) => r.where), ...sources].filter((p): p is string => !!p && idx.files.has(p)))].sort();
    let bytes = Buffer.byteLength(d.raw);
    for (const c of cited) {
      if (LOCKFILE.test(c)) continue; // a symbol hit in a lockfile is not something the pass reads
      try { bytes += statSync(join(repo, c)).size; } catch { /* deleted or unreadable */ }
    }

    let staleCommits: number | undefined;
    const sig = cited.length ? stalenessSignal(repo, posix(relative(repo, abs)), cited) : ({ status: 'none' } as const);
    if (sig.status === 'signal') staleCommits = sig.commits;
    else if (sig.status === 'unknown' && !staleWarned) (warnings.push(sig.warning), (staleWarned = true));

    const reasons: string[] = [];
    let lane: Lane;
    const attributed = isAttributed(d.data);
    if (checkable >= ARCHIVE_MIN_CHECKABLE && missing.length / checkable >= ARCHIVE_MISSING_SHARE) {
      lane = 'archive-candidate';
      reasons.push(`${missing.length} of ${checkable} checkable references are missing`);
    } else if (!attributed || missing.length || (staleCommits ?? 0) >= STALE_COMMITS_BAR) {
      lane = 'check';
      if (!attributed) reasons.push('no sources/provenance/cites with last_verified');
      if (missing.length) reasons.push(`missing references: ${missing.join(', ')}`);
      if ((staleCommits ?? 0) >= STALE_COMMITS_BAR) reasons.push(`${staleCommits} commits to cited files since the doc last changed`);
    } else if (needsFields.has(d.rel)) {
      lane = 'fields-only';
      reasons.push('purpose or symptoms missing or weak');
    } else {
      lane = 'clean';
    }
    docs.push({ path: d.rel, lane, reasons, missing, bytes, ...(staleCommits !== undefined && { staleCommits }) });

    if (opts.ledger) recordEntry(opts.ledger, { path: d.rel, lane, content_hash: hashContent(d.raw) });
  }
  docs.sort((a, b) => a.path.localeCompare(b.path));

  const byLane: Record<Lane, number> = { clean: 0, 'fields-only': 0, check: 0, 'archive-candidate': 0 };
  for (const d of docs) byLane[d.lane]++;
  const judged = docs.filter((d) => d.lane === 'fields-only' || d.lane === 'check');
  const judgmentBytes = judged.reduce((s, d) => s + d.bytes, 0);
  const t = config.reconcile.team;
  const auto = judged.length >= t.min_docs || judgmentBytes >= t.min_bytes ? 'team' : 'serial';
  let mode = opts.mode ?? auto;
  let shards = mode === 'team' ? await planShards(docsPath, judged, config) : [];
  // One shard is just a serial run with agent overhead.
  if (mode === 'team' && !opts.mode && shards.length < 2) (mode = 'serial'), (shards = []);

  return {
    docs,
    totals: { docs: docs.length, bytes: docs.reduce((s, d) => s + d.bytes, 0), byLane, judgmentDocs: judged.length, judgmentBytes },
    mode,
    shards,
    warnings,
  };
}

/**
 * Group judged docs so linked docs share a shard (overview clusters, merged if they overlap;
 * the rest chunked per domain), split any group larger than a fair share, then bin-pack by
 * bytes into at most `max_agents` shards.
 */
export async function planShards(docsPath: string, judged: Pick<TriageDoc, 'path' | 'bytes'>[], config: PluginConfig): Promise<Shard[]> {
  if (!judged.length) return [];
  const { max_agents, docs_per_agent, min_bytes } = config.reconcile.team;
  const bytes = new Map(judged.map((d) => [d.path, d.bytes]));

  // union-find over cluster members
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const p of bytes.keys()) parent.set(p, p);
  try {
    for (const c of await findClusters(docsPath, config.overview)) {
      const inScope = c.members.filter((m) => bytes.has(m));
      for (const m of inScope.slice(1)) parent.set(find(m), find(inScope[0]!));
    }
  } catch { /* no link graph: domain chunks only */ }

  const groups = new Map<string, string[]>();
  for (const p of [...bytes.keys()].sort()) (groups.get(find(p)) ?? groups.set(find(p), []).get(find(p))!).push(p);

  // singletons (not in a cluster) are chunked per domain, so a big domain still splits
  const units: string[][] = [];
  const loose = new Map<string, string[]>();
  for (const g of groups.values()) {
    if (g.length > 1) units.push(g);
    else (loose.get(g[0]!.split('/')[0]!) ?? loose.set(g[0]!.split('/')[0]!, []).get(g[0]!.split('/')[0]!)!).push(g[0]!);
  }
  for (const list of loose.values()) for (let i = 0; i < list.length; i += docs_per_agent) units.push(list.slice(i, i + docs_per_agent));

  const n = Math.max(1, Math.min(max_agents, judged.length, Math.max(Math.ceil(judged.length / docs_per_agent), Math.ceil(judged.reduce((x, d) => x + d.bytes, 0) / min_bytes))));
  const shards: Shard[] = Array.from({ length: n }, (_, id) => ({ id: id + 1, docs: [], bytes: 0 }));
  const size = (u: string[]): number => u.reduce((s, p) => s + bytes.get(p)!, 0);
  // A cluster bigger than a fair share is split in path order (same-folder docs stay together),
  // or one agent would carry most of a big job. Safe: apply is serial and hash-checked.
  const fair = Math.ceil(judged.length / n);
  const fitted = units.flatMap((u) => (u.length <= fair ? [u] : Array.from({ length: Math.ceil(u.length / fair) }, (_, i) => u.slice(i * fair, (i + 1) * fair))));
  for (const u of fitted.sort((a, b) => size(b) - size(a) || a[0]!.localeCompare(b[0]!))) {
    const s = shards.reduce((m, x) => (x.bytes < m.bytes ? x : m));
    s.docs.push(...u);
    s.bytes += size(u);
  }
  for (const s of shards) s.docs.sort();
  return shards.filter((s) => s.docs.length);
}
