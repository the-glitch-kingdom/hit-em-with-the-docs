/**
 * Reconcile triage (#54): sort in-scope docs into lanes, estimate the judgment
 * pass, plan a serial run or an agent team. Deterministic; writes nothing to
 * the docs tree (the ledger lives elsewhere).
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { readdir } from 'fs/promises';
import { join, relative, resolve } from 'path';
import { parse_frontmatter } from '../../utils/frontmatter.js';
import type { PluginConfig } from '../../utils/config.js';
import { check_retrieval } from '../audit/retrieval.js';
import { find_clusters } from '../links/clusters.js';
import { build_repo_index, extract_references, prime_symbols, related_index, resolve_references, type RelatedRepo, type ResolvedReference } from './references.js';
import { body_change, sibling_commits, staleness_signal } from './staleness.js';
import { hash_content, is_reviewed, record_entry, type Ledger } from './ledger.js';
import { section_of } from '../links/anchors.js';
import { find_duplicates, type Duplicate } from './duplicates.js';
import { find_secrets, scan_file, type SecretFinding } from './secrets.js';

export type Lane = 'clean' | 'fields-only' | 'check' | 'archive-candidate' | 'secret';

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
  /** every reference the resolver found in the body (additive; `missing` also holds gone `sources`) */
  refs: Pick<ResolvedReference, 'kind' | 'ref' | 'status' | 'where' | 'whereKind'>[];
  /** Doc bytes + bytes of the cited files the judgment pass must read. */
  bytes: number;
  staleCommits?: number;
  /** related repo whose docs should own this doc's details (summarize and cross-link) */
  owner?: string;
  /** masked secret findings in the doc itself (never values) */
  findings?: SecretFinding[];
  /** cited files holding a secret: never read by the judgment pass, dropped from the cited list */
  blocked_files?: string[];
  /** sections of this doc that copy another doc's section; the owner should hold the text, this doc a pointer */
  duplicates?: Duplicate[];
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
  /** schema files parsed for table/column checks (empty = tables are unknown) */
  schemaFiles: string[];
  /** masked findings in archive/, the outside lane and .hewtd/: scanned and reported, never judged */
  peripheral: SecretFinding[];
}

const MAX_SCAN_BYTES = 2 * 1024 * 1024;
// Free-text rules: in a cited code file they are too noisy to put the doc in the secret lane.
const WEAK_RULES = new Set(['generic-secret', 'url-password']);
const fmt_finding = (f: SecretFinding): string => `${f.rule} ${f.file}:${f.line} ${f.masked}`;

async function walk_files(dir: string, keep: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let ents;
    try { ents = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (keep(e.name)) out.push(p);
    }
  };
  await walk(dir);
  return out;
}

/** Findings (kind secret or personal) in archive/, tracked markdown outside the docs root, and .hewtd/. */
export async function scan_peripheral(root: string, docs_path: string, config: PluginConfig): Promise<SecretFinding[]> {
  const cfg = config.reconcile.secrets;
  const top = git_root(docs_path) ?? root;
  const files = new Map<string, string>(); // abs -> label
  for (const f of await walk_files(join(docs_path, 'archive'), (n) => n.endsWith('.md'))) files.set(f, posix(relative(top, f)));
  for (const f of await walk_files(join(top, '.hewtd'), () => true)) files.set(f, posix(relative(top, f)));
  try {
    const docs_rel = posix(relative(top, docs_path));
    const tracked = execFileSync('git', ['ls-files', '*.md'], { cwd: top, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
    for (const f of tracked) if (f && !(docs_rel && (f === docs_rel || f.startsWith(`${docs_rel}/`)))) files.set(join(top, f), f);
  } catch { /* not a git repo: no outside lane */ }
  const out: SecretFinding[] = [];
  for (const [abs, label] of [...files].sort((a, b) => a[1].localeCompare(b[1]))) {
    try { if (statSync(abs).size > MAX_SCAN_BYTES) continue; } catch { continue; }
    out.push(...(await scan_file(abs, label, cfg)));
  }
  return out;
}

/** Standalone masked scan for `reconcile --secrets`: no scope = the whole docs root (archive included) plus the periphery. */
export async function scan_secrets(opts: { root: string; docsPath: string; config: PluginConfig; scope?: string[] }): Promise<SecretFinding[]> {
  const { root, docsPath: docs_path, config } = opts;
  const cfg = config.reconcile.secrets;
  const abs = opts.scope?.length
    ? (await resolve_scope(docs_path, opts.scope)).map((r) => join(docs_path, r))
    : (await walk_files(docs_path, (n) => n.endsWith('.md'))).filter((f) => !f.startsWith(join(docs_path, 'archive') + '/')); // archive/ comes with the periphery
  const out: SecretFinding[] = [];
  for (const f of abs.sort()) out.push(...(await scan_file(f, posix(relative(docs_path, f)), cfg)));
  if (!opts.scope?.length) out.push(...(await scan_peripheral(root, docs_path, config)));
  return out;
}

const posix = (p: string): string => p.split('\\').join('/');

export async function md_files(dir: string): Promise<string[]> {
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
export async function resolve_scope(
  docs_path: string,
  args: string[],
  opts: { next?: number; ledger?: Ledger } = {}
): Promise<string[]> {
  if (!args.length && !opts.next) throw new Error('Name a scope (domain, folder or files) or pass --next <n>; reconcile never runs on the whole tree by default.');
  const set = new Set<string>();
  if (!args.length) for (const f of await md_files(docs_path)) set.add(f);
  for (const a of args) {
    const cands = [resolve(a), resolve(docs_path, a)];
    const hit = cands.find((c) => existsSync(c) && (c === docs_path || c.startsWith(docs_path + '/')));
    if (!hit) throw new Error(`Scope "${a}" is not a file, folder or domain under ${docs_path}`);
    if (statSync(hit).isDirectory()) for (const f of await md_files(hit)) set.add(f);
    else set.add(hit);
  }
  let rels = [...set].map((f) => posix(relative(docs_path, f))).sort();
  if (opts.next) {
    rels = rels
      .filter((r) => !is_reviewed(opts.ledger?.entries[r], hash_content(readFileSync(join(docs_path, r), 'utf-8'))))
      .slice(0, opts.next);
  }
  return rels;
}

export function git_root(dir: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

/** Scope files with uncommitted changes (tracked or untracked). Empty outside a git repo. */
export function dirty_in_scope(docs_path: string, rels: string[]): string[] {
  const root = git_root(docs_path);
  if (!root || !rels.length) return [];
  const out = execFileSync('git', ['status', '--porcelain', '--', ...rels.map((r) => join(docs_path, r))], {
    cwd: root, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.split('\n').filter(Boolean).map((l) => l.slice(3));
}

const non_empty = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : !!v);

function is_attributed(data: Record<string, unknown>): boolean {
  const sym = Array.isArray(data.symptoms) ? data.symptoms : [];
  const cited =
    non_empty(data.sources) || non_empty(data.provenance) || non_empty(data.cites) ||
    sym.some((s) => s && typeof s === 'object' && non_empty((s as { cites?: unknown }).cites));
  return cited && non_empty(data.last_verified);
}

export async function triage(opts: {
  root: string;
  docsPath: string;
  rels: string[];
  config: PluginConfig;
  mode?: 'serial' | 'team';
  ledger?: Ledger;
}): Promise<TriageResult> {
  const { docsPath: docs_path, rels, config } = opts;
  const repo = git_root(docs_path) ?? opts.root;
  const idx = build_repo_index(repo, config.reconcile.schema_sources);
  const warnings: string[] = [];
  const related: RelatedRepo[] = config.reconcile.related_repos.map((r) => ({ name: r.name, root: resolve(opts.root, r.path) }));
  for (const r of related) {
    if (!existsSync(r.root)) warnings.push(`related repo "${r.name}" is not checked out at ${r.root}: its references stay unknown`);
  }
  const rel_of = (where: string | undefined): RelatedRepo | undefined => {
    const name = where && /^[\w.-]+:/.exec(where)?.[0].slice(0, -1);
    return name ? related.find((r) => r.name === name) : undefined;
  };

  const loaded = rels.map((rel) => {
    const raw = readFileSync(join(docs_path, rel), 'utf-8');
    const { data, content } = parse_frontmatter<Record<string, unknown>>(raw);
    return { rel, raw, data, body: content, refs: extract_references(content) };
  });
  prime_symbols(idx, loaded.flatMap((d) => d.refs.filter((r) => r.kind === 'symbol' || r.kind === 'env').map((r) => r.ref)));

  const retrieval = check_retrieval(
    loaded.map((d) => ({ rel: d.rel, data: d.data, body: d.body })),
    config.retrieval
  );
  const needs_fields = new Set(retrieval.filter((i) => /MISSING_PURPOSE|WEAK_PURPOSE|MISSING_SYMPTOMS/.test(i.rule)).map((i) => i.file));

  const cfg = config.reconcile.secrets;
  // A file a judgment agent would read is scanned once; a finding blocks it (masked results only).
  const file_scans = new Map<string, Promise<SecretFinding[]>>();
  const scan_cited = (abs: string, label: string): Promise<SecretFinding[]> => {
    if (LOCKFILE.test(label)) return Promise.resolve([]); // never read by the pass
    let p = file_scans.get(abs);
    if (!p) {
      let big = false;
      try { big = statSync(abs).size > MAX_SCAN_BYTES; } catch { /* gone: scanFile yields [] */ }
      file_scans.set(abs, (p = big ? Promise.resolve([]) : scan_file(abs, label, cfg)));
    }
    return p;
  };
  const peripheral = await scan_peripheral(opts.root, docs_path, config);

  const dups = await find_duplicates(docs_path, config);
  const docs: TriageDoc[] = [];
  let stale_warned = false;
  for (const d of loaded) {
    const abs = join(docs_path, d.rel);
    const resolved: ResolvedReference[] = await resolve_references(idx, d.refs, { docFile: abs, docsPath: docs_path, related });
    const sources = Array.isArray(d.data.sources) ? d.data.sources.filter((s): s is string => typeof s === 'string') : [];
    // Only path-like sources are checkable; URLs and prose citations are not claims about the repo.
    // `<name>:<path>` names a file in a related repo (read-only); checked there, not in this repo.
    const rel_sources = sources.filter((s) => !/\s|:\/\//.test(s) && !!rel_of(s));
    const gone_rel = rel_sources.filter((s) => {
      const sib = related_index(rel_of(s)!);
      return !!sib && !sib.files.has(s.slice(s.indexOf(':') + 1));
    });
    const path_sources = sources.filter((s) => !rel_of(s)).filter((s) => !/^[a-z]+:\/\//i.test(s) && !/\s/.test(s) && /\.\w+$/.test(s));
    const gone_sources = path_sources.filter((s) => !idx.files.has(s));
    const missing = [...new Set([...resolved.filter((r) => r.status === 'missing').map((r) => r.ref), ...gone_sources, ...gone_rel])];
    const checkable = resolved.filter((r) => r.status !== 'unknown').length + path_sources.length + rel_sources.filter((s) => related_index(rel_of(s)!)).length;

    // Symbol hits are not cited files: a common name living in a data file must not add bytes or staleness.
    let cited = [...new Set([...resolved.filter((r) => r.kind === 'path').map((r) => r.where), ...sources].filter((p): p is string => !!p && idx.files.has(p)))].sort();
    const own_findings = find_secrets(d.raw, d.rel, cfg).map((r) => r.finding).filter((f) => f.kind === 'secret');
    const blocked = new Map<string, SecretFinding[]>();
    const withheld = new Map<string, SecretFinding[]>(); // weak hits in cited code: not read, but the doc keeps its lane
    const hold = (c: string, fs: SecretFinding[]) => {
      if (!fs.length) return;
      (/\.(md|mdx)$/i.test(c) || fs.some((f) => !WEAK_RULES.has(f.rule)) ? blocked : withheld).set(c, fs);
    };
    for (const c of cited) hold(c, (await scan_cited(join(repo, c), c)).filter((f) => f.kind === 'secret'));
    cited = cited.filter((c) => !blocked.has(c) && !withheld.has(c));
    let bytes = Buffer.byteLength(d.raw);
    for (const c of cited) {
      if (LOCKFILE.test(c)) continue; // a symbol hit in a lockfile is not something the pass reads
      try { bytes += statSync(join(repo, c)).size; } catch { /* deleted or unreadable */ }
    }

    // Related-repo files the pass reads: bytes count, staleness = sibling commits since the doc's last body change.
    const rel_cited = new Map<RelatedRepo, string[]>();
    for (const w of [...resolved.filter((r) => r.kind === 'path').map((r) => r.where), ...rel_sources]) {
      const rel = rel_of(w);
      if (rel && w) {
        const fs = (await scan_cited(join(rel.root, w.slice(w.indexOf(':') + 1)), w)).filter((f) => f.kind === 'secret');
        if (fs.length) { hold(w, fs); if (blocked.has(w) || withheld.has(w)) continue; }
      }
      if (rel && w) rel_cited.set(rel, [...(rel_cited.get(rel) ?? []), w.slice(w.indexOf(':') + 1)]);
    }
    for (const [rel, paths] of rel_cited) {
      for (const p of paths) { try { bytes += statSync(join(rel.root, p)).size; } catch { /* gone */ } }
    }

    let stale_commits: number | undefined;
    const doc_rel = posix(relative(repo, abs));
    const sig = cited.length ? staleness_signal(repo, doc_rel, cited) : ({ status: 'none' } as const);
    if (sig.status === 'signal') stale_commits = sig.commits;
    if (rel_cited.size) {
      let since = sig.status === 'signal' ? sig.docDate : undefined;
      if (!since) { try { since = body_change(repo, doc_rel)?.date; } catch { /* not in git */ } }
      if (since) stale_commits = (stale_commits ?? 0) + [...rel_cited].reduce((n, [rel, ps]) => n + sibling_commits(rel.root, since!, [...new Set(ps)]), 0);
    }
    if (sig.status === 'unknown' && !stale_warned) (warnings.push(sig.warning), (stale_warned = true));

    const reasons: string[] = [];
    let lane: Lane;
    const attributed = is_attributed(d.data);
    if (own_findings.length || blocked.size) {
      lane = 'secret';
      for (const f of own_findings) reasons.push(`secret: ${fmt_finding(f)}`);
      for (const [c, fs] of blocked) reasons.push(`cited file blocked: ${c} (${fs.map(fmt_finding).join('; ')})`);
    } else if (checkable >= ARCHIVE_MIN_CHECKABLE && missing.length / checkable >= ARCHIVE_MISSING_SHARE) {
      lane = 'archive-candidate';
      reasons.push(`${missing.length} of ${checkable} checkable references are missing`);
    } else if (!attributed || missing.length || (stale_commits ?? 0) >= STALE_COMMITS_BAR) {
      lane = 'check';
      if (!attributed) reasons.push('no sources/provenance/cites with last_verified');
      if (missing.length) reasons.push(`missing references: ${missing.join(', ')}`);
      if ((stale_commits ?? 0) >= STALE_COMMITS_BAR) reasons.push(`${stale_commits} commits to cited files since the doc last changed`);
    } else if (needs_fields.has(d.rel)) {
      lane = 'fields-only';
      reasons.push('purpose or symptoms missing or weak');
    } else {
      lane = 'clean';
    }

    // Details owned by a sibling: most checkable refs resolve there and the doc does not cross-link into its docs.
    let owner: string | undefined;
    const checked = resolved.filter((r) => r.status !== 'unknown');
    for (const rel of related) {
      const hits = checked.filter((r) => r.status === 'ok' && rel_of(r.where) === rel);
      const linked = resolved.some((r) => r.kind === 'doc-link' && r.status === 'ok' && rel_of(r.where) === rel);
      if (hits.length >= 2 && hits.length / checked.length > 0.5 && !linked) owner = rel.name;
    }
    for (const [c, fs] of withheld) reasons.push(`cited file withheld: ${c} (${fs.map((f) => f.masked).join('; ')})`);
    if (owner && lane !== 'secret') {
      if (lane === 'clean' || lane === 'fields-only') lane = 'check';
      reasons.push(`details owned by ${owner}: summarize and cross-link`);
    }
    const copies = lane === 'secret' ? undefined : dups.get(d.rel);
    if (copies) {
      if (lane === 'clean' || lane === 'fields-only') lane = 'check';
      for (const c of copies) reasons.push(`copy of ${c.owner}#${c.section}${c.tie ? ` (tie: ${c.tie.join(', ')})` : ''}`);
    }
    // An overview whose members changed since it was written goes back to check; the verdict is dropped so it stays queued.
    const led = opts.ledger?.entries[d.rel];
    if (led?.members) {
      const changed = Object.entries(led.members).filter(([p, h]) => { try { return hash_content(readFileSync(join(docs_path, p), 'utf-8')) !== h; } catch { return true; } }).map(([p]) => p);
      if (changed.length && lane !== 'secret') {
        if (lane === 'clean' || lane === 'fields-only') lane = 'check';
        reasons.push(`member changed: ${changed.join(', ')}`);
        delete led.verdict;
      }
    }
    // A pointer written by reconcile: re-verify the summary when the owner section changed or vanished.
    if (led?.pointer && lane !== 'secret') {
      const [tp, anchor = ''] = led.pointer.target.split('#');
      let now: string | undefined;
      try { const sec = section_of(parse_frontmatter<Record<string, unknown>>(readFileSync(resolve(docs_path, tp!), 'utf-8')).content, anchor); now = sec === null ? undefined : hash_content(sec); } catch { /* owner gone */ }
      if (now !== led.pointer.section_hash) {
        if (lane === 'clean' || lane === 'fields-only') lane = 'check';
        reasons.push(now === undefined ? `pointer target changed: ${led.pointer.target} (section missing)` : `pointer target changed: ${led.pointer.target}`);
        delete led.verdict;
      }
    }
    docs.push({ path: d.rel, lane, reasons, missing, refs: resolved.map(({ kind, ref, status, where, whereKind: where_kind }) => ({ kind, ref, status, ...(where !== undefined && { where }), ...(where_kind && { whereKind: where_kind }) })), bytes, ...(stale_commits !== undefined && { staleCommits: stale_commits }), ...(owner && { owner }), ...(copies && { duplicates: copies }), ...(own_findings.length && { findings: own_findings }), ...(blocked.size + withheld.size > 0 && { blocked_files: [...blocked.keys(), ...withheld.keys()].sort() }) });

    if (opts.ledger) record_entry(opts.ledger, { path: d.rel, lane, content_hash: hash_content(d.raw) });
  }
  docs.sort((a, b) => a.path.localeCompare(b.path));

  const by_lane: Record<Lane, number> = { clean: 0, 'fields-only': 0, check: 0, 'archive-candidate': 0, secret: 0 };
  for (const d of docs) by_lane[d.lane]++;
  const judged = docs.filter((d) => d.lane === 'fields-only' || d.lane === 'check');
  const judgment_bytes = judged.reduce((s, d) => s + d.bytes, 0);
  const t = config.reconcile.team;
  const auto = judged.length >= t.min_docs || judgment_bytes >= t.min_bytes ? 'team' : 'serial';
  let mode = opts.mode ?? auto;
  let shards = mode === 'team' ? await plan_shards(docs_path, judged, config) : [];
  // One shard is just a serial run with agent overhead.
  if (mode === 'team' && !opts.mode && shards.length < 2) (mode = 'serial'), (shards = []);

  return {
    docs,
    totals: { docs: docs.length, bytes: docs.reduce((s, d) => s + d.bytes, 0), byLane: by_lane, judgmentDocs: judged.length, judgmentBytes: judgment_bytes },
    mode,
    shards,
    warnings,
    schemaFiles: idx.schemaFiles,
    peripheral,
  };
}

/** Read-only resolution of some docs for the graph export: no ledger, no dirty-tree check (that lives in the CLI). */
export async function resolve_docs(opts: { root: string; docsPath: string; rels: string[]; config: PluginConfig; ledger?: Ledger }): Promise<TriageDoc[]> {
  // A copy, so the ledger-driven reasons (pointer target / member changed) fire without recording anything.
  const { ledger, ...rest } = opts;
  return (await triage({ ...rest, ...(ledger && { ledger: structuredClone(ledger) }) })).docs;
}

/**
 * Group judged docs so linked docs share a shard (overview clusters, merged if they overlap;
 * the rest chunked per domain), split any group larger than a fair share, then bin-pack by
 * bytes into at most `max_agents` shards.
 */
export async function plan_shards(docs_path: string, judged: Pick<TriageDoc, 'path' | 'bytes'>[], config: PluginConfig): Promise<Shard[]> {
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
    for (const c of await find_clusters(docs_path, config.overview)) {
      const in_scope = c.members.filter((m) => bytes.has(m));
      for (const m of in_scope.slice(1)) parent.set(find(m), find(in_scope[0]!));
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
