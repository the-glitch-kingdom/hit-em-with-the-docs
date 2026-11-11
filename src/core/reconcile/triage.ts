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
import { build_repo_index, extract_references, add_known_symbols, get_symbol_names, load_sibling_index, resolve_references, type RelatedRepo, type ResolvedReference, type SymbolTable } from './references.js';
import { find_body_change, count_sibling_commits, find_staleness_signal, type StalenessSignal } from './staleness.js';
import { compute_content_hash, is_reviewed, build_ledger_entry, type Ledger } from './ledger.js';
import { find_section } from '../links/anchors.js';
import { find_duplicates, type Duplicate } from './duplicates.js';
import { time_stage } from '../graph/timing.js';
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
  // eslint-disable-next-line id-denylist -- serialized key (triage/graph JSON)
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
const format_finding = (finding: SecretFinding): string => `${finding.rule} ${finding.file}:${finding.line} ${finding.masked}`;

async function list_files(dir_path: string, keep: (name: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  const list_tree = async (current_dir: string): Promise<void> => {
    let dirents;
    try { dirents = await readdir(current_dir, { withFileTypes: true }); } catch { return; }
    for (const entry of dirents) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const entry_path = join(current_dir, entry.name);
      if (entry.isDirectory()) await list_tree(entry_path);
      else if (keep(entry.name)) found.push(entry_path);
    }
  };
  await list_tree(dir_path);
  return found;
}

/** Findings (kind secret or personal) in archive/, tracked markdown outside the docs root, and .hewtd/. */
export async function scan_peripheral(repo_root: string, docs_root: string, config: PluginConfig): Promise<SecretFinding[]> {
  const secrets_config = config.reconcile.secrets;
  const git_top = find_git_top(docs_root) ?? repo_root;
  const files = new Map<string, string>(); // abs -> label
  for (const file of await list_files(join(docs_root, 'archive'), (name) => name.endsWith('.md'))) files.set(file, format_posix_path(relative(git_top, file)));
  for (const file of await list_files(join(git_top, '.hewtd'), () => true)) files.set(file, format_posix_path(relative(git_top, file)));
  try {
    const docs_rel = format_posix_path(relative(git_top, docs_root));
    // eslint-disable-next-line id-denylist -- child_process option name
    const tracked = execFileSync('git', ['ls-files', '*.md'], { cwd: git_top, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
    for (const file of tracked) if (file && !(docs_rel && (file === docs_rel || file.startsWith(`${docs_rel}/`)))) files.set(join(git_top, file), file);
  } catch { /* not a git repo: no outside lane */ }
  const found: SecretFinding[] = [];
  for (const [abs_path, label] of [...files].sort((a, b) => a[1].localeCompare(b[1]))) {
    try { if (statSync(abs_path).size > MAX_SCAN_BYTES) continue; } catch { continue; }
    found.push(...(await scan_file(abs_path, label, secrets_config)));
  }
  return found;
}

/** Standalone masked scan for `reconcile --secrets`: no scope = the whole docs root (archive included) plus the periphery. */
export async function scan_secrets(options: { root: string; docs_root: string; config: PluginConfig; scope?: string[] }): Promise<SecretFinding[]> {
  const { root: repo_root, docs_root: docs_root, config } = options;
  const secrets_config = config.reconcile.secrets;
  const abs_paths = options.scope?.length
    ? (await resolve_scope(docs_root, options.scope)).map((doc_path) => join(docs_root, doc_path))
    : (await list_files(docs_root, (name) => name.endsWith('.md'))).filter((file) => !file.startsWith(join(docs_root, 'archive') + '/')); // archive/ comes with the periphery
  const found: SecretFinding[] = [];
  for (const file of abs_paths.sort()) found.push(...(await scan_file(file, format_posix_path(relative(docs_root, file)), secrets_config)));
  if (!options.scope?.length) found.push(...(await scan_peripheral(repo_root, docs_root, config)));
  return found;
}

const format_posix_path = (path_text: string): string => path_text.split('\\').join('/');

export async function list_markdown_files(dir_path: string): Promise<string[]> {
  const found: string[] = [];
  const list_tree = async (doc: string): Promise<void> => {
    for (const entry of await readdir(doc, { withFileTypes: true })) {
      if (entry.name === 'archive' || entry.name.startsWith('.')) continue;
      const path_text = join(doc, entry.name);
      if (entry.isDirectory()) await list_tree(path_text);
      else if (entry.name.endsWith('.md') && entry.name !== 'INDEX.md' && entry.name !== 'REGISTRY.md') found.push(path_text);
    }
  };
  await list_tree(dir_path);
  return found;
}

/**
 * Scope args: a file, a folder or a domain name (a folder under the docs path).
 * With `next`, only the first N docs the ledger has not reviewed (or that changed since).
 * No args and no `next` is an error: never the whole tree by default.
 */
export async function resolve_scope(
  docs_root: string,
  args: string[],
  options: { next?: number; ledger?: Ledger } = {}
): Promise<string[]> {
  if (!args.length && !options.next) throw new Error('Name a scope (domain, folder or files) or pass --next <n>; reconcile never runs on the whole tree by default.');
  const scope_files = new Set<string>();
  if (!args.length) for (const file of await list_markdown_files(docs_root)) scope_files.add(file);
  for (const scope_arg of args) {
    const candidates = [resolve(scope_arg), resolve(docs_root, scope_arg)];
    const scope_match = candidates.find((candidate) => existsSync(candidate) && (candidate === docs_root || candidate.startsWith(docs_root + '/')));
    if (!scope_match) throw new Error(`Scope "${scope_arg}" is not a file, folder or domain under ${docs_root}`);
    if (statSync(scope_match).isDirectory()) for (const file of await list_markdown_files(scope_match)) scope_files.add(file);
    else scope_files.add(scope_match);
  }
  let doc_paths = [...scope_files].map((file) => format_posix_path(relative(docs_root, file))).sort();
  if (options.next) {
    doc_paths = doc_paths
      .filter((doc_path) => !is_reviewed(options.ledger?.entries[doc_path], compute_content_hash(readFileSync(join(docs_root, doc_path), 'utf-8'))))
      .slice(0, options.next);
  }
  return doc_paths;
}

export function find_git_top(dir_path: string): string | undefined {
  try {
    // eslint-disable-next-line id-denylist -- child_process option name
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir_path, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

/** Scope files with uncommitted changes (tracked or untracked). Empty outside a git repo. */
export function find_dirty_in_scope(docs_root: string, doc_paths: string[]): string[] {
  const git_top = find_git_top(docs_root);
  if (!git_top || !doc_paths.length) return [];
  const status_output = execFileSync('git', ['status', '--porcelain', '--', ...doc_paths.map((doc_path) => join(docs_root, doc_path))], {
    // eslint-disable-next-line id-denylist -- child_process option name
    cwd: git_top, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return status_output.split('\n').filter(Boolean).map((line) => line.slice(3));
}

const is_non_empty = (value: unknown): boolean => (Array.isArray(value) ? value.length > 0 : typeof value === 'string' ? value.trim() !== '' : !!value);

function is_attributed(data: Record<string, unknown>): boolean {
  const symptoms = Array.isArray(data.symptoms) ? data.symptoms : [];
  const cited =
    is_non_empty(data.sources) || is_non_empty(data.provenance) || is_non_empty(data.cites) ||
    symptoms.some((symptom) => symptom && typeof symptom === 'object' && is_non_empty((symptom as { cites?: unknown }).cites));
  return cited && is_non_empty(data.last_verified);
}

export async function triage_docs(options: {
  root: string;
  docs_root: string;
  rels: string[];
  config: PluginConfig;
  mode?: 'serial' | 'team';
  ledger?: Ledger;
  /** Reused staleness signals (graph export): a hit needs the same doc content and cited files at the same HEAD. */
  staleness_cache?: { entries: Record<string, StalenessSignal> };
  /** Whole-tree duplicates when the caller already has them (the graph export), so a few-doc run skips the tree pass. */
  duplicates?: Map<string, Duplicate[]>;
  /** Code-derived symbol answers kept between runs (graph export), valid for one code state. */
  symbol_table?: SymbolTable;
  /** Repo-relative docs that are the same doc as one under triage (integrate's source copy): not mention evidence (#98). */
  ignore_mentions?: string[];
}): Promise<TriageResult> {
  const { docs_root: docs_root, rels: doc_paths, config } = options;
  const git_top = find_git_top(docs_root) ?? options.root;
  const index = time_stage('repo index', () => build_repo_index(git_top, config.reconcile.schema_sources));
  const warnings: string[] = [];
  for (const pattern of index.unmatched_schema_sources) warnings.push(`schema_sources pattern "${pattern}" matches no tracked file: its tables and columns stay unknown (the file must be tracked by git; untracked and ignored files are never indexed)`);
  const sibling_repos: RelatedRepo[] = config.reconcile.related_repos.map((related_repo) => ({ name: related_repo.name, root: resolve(options.root, related_repo.path) }));
  for (const sibling_repo of sibling_repos) {
    if (!existsSync(sibling_repo.root)) warnings.push(`related repo "${sibling_repo.name}" is not checked out at ${sibling_repo.root}: its references stay unknown`);
  }
  const find_sibling_repo = (where: string | undefined): RelatedRepo | undefined => {
    const name = where && /^[\w.-]+:/.exec(where)?.[0].slice(0, -1);
    return name ? sibling_repos.find((sibling_repo) => sibling_repo.name === name) : undefined;
  };

  const loaded = doc_paths.map((doc_path) => {
    const raw_text = readFileSync(join(docs_root, doc_path), 'utf-8');
    const { data, content } = parse_frontmatter<Record<string, unknown>>(raw_text);
    return { doc_path, raw_text, data, body: content, references: extract_references(content) };
  });
  time_stage('symbol priming', () => add_known_symbols(index, loaded.flatMap((doc) => get_symbol_names(doc.references)), options.symbol_table));

  const retrieval = check_retrieval(
    loaded.map((doc) => ({ doc_path: doc.doc_path, data: doc.data, body: doc.body })),
    config.retrieval
  );
  const needs_fields = new Set(retrieval.filter((issue) => /MISSING_PURPOSE|WEAK_PURPOSE|MISSING_SYMPTOMS/.test(issue.rule)).map((issue) => issue.file));

  const config_item = config.reconcile.secrets;
  // A file a judgment agent would read is scanned once; a finding blocks it (masked results only).
  const file_scans = new Map<string, Promise<SecretFinding[]>>();
  const scan_cited = (abs_path: string, label: string): Promise<SecretFinding[]> => {
    if (LOCKFILE.test(label)) return Promise.resolve([]); // never read by the pass
    let scan_promise = file_scans.get(abs_path);
    if (!scan_promise) {
      let big = false;
      try { big = statSync(abs_path).size > MAX_SCAN_BYTES; } catch { /* gone: scanFile yields [] */ }
      file_scans.set(abs_path, (scan_promise = big ? Promise.resolve([]) : scan_file(abs_path, label, config_item)));
    }
    return scan_promise;
  };
  const peripheral = await time_stage('peripheral scan', () => scan_peripheral(options.root, docs_root, config));

  const dups = options.duplicates ?? await time_stage('duplicates', () => find_duplicates(docs_root, config));
  const docs: TriageDoc[] = [];
  let stale_warned = false;
  for (const doc of loaded) {
    const abs_path = join(docs_root, doc.doc_path);
    const resolved: ResolvedReference[] = await time_stage('resolve refs', () => resolve_references(index, doc.references, { doc_file: abs_path, docs_root: docs_root, related: sibling_repos, external_refs: Array.isArray(doc.data.external_refs) ? doc.data.external_refs.filter((item): item is string => typeof item === 'string') : [], ...(options.ignore_mentions && { ignore_mentions: options.ignore_mentions }) }));
    const sources = Array.isArray(doc.data.sources) ? doc.data.sources.filter((source): source is string => typeof source === 'string') : [];
    // Only path-like sources are checkable; URLs and prose citations are not claims about the repo.
    // `<name>:<path>` names a file in a related repo (read-only); checked there, not in this repo.
    const rel_sources = sources.filter((source) => !/\s|:\/\//.test(source) && !!find_sibling_repo(source));
    const gone_rel = rel_sources.filter((rel_source) => {
      const sibling_repo_item = load_sibling_index(find_sibling_repo(rel_source)!);
      return !!sibling_repo_item && !sibling_repo_item.files.has(rel_source.slice(rel_source.indexOf(':') + 1));
    });
    const path_sources = sources.filter((source) => !find_sibling_repo(source)).filter((source) => !/^[a-z]+:\/\//i.test(source) && !/\s/.test(source) && /\.\w+$/.test(source));
    const gone_sources = path_sources.filter((path_source) => !index.files.has(path_source));
    const missing = [...new Set([...resolved.filter((result) => result.status === 'missing').map((result) => result.ref), ...gone_sources, ...gone_rel])];
    const checkable = resolved.filter((result) => result.status !== 'unknown').length + path_sources.length + rel_sources.filter((rel_source) => load_sibling_index(find_sibling_repo(rel_source)!)).length;

    // Symbol hits are not cited files: a common name living in a data file must not add bytes or staleness.
    let cited = [...new Set([...resolved.filter((result) => result.kind === 'path').map((result) => result.where), ...sources].filter((path_text): path_text is string => !!path_text && index.files.has(path_text)))].sort();
    const own_findings = time_stage('secret scan', () => find_secrets(doc.raw_text, doc.doc_path, config_item)).map((raw_secret) => raw_secret.finding).filter((finding) => finding.kind === 'secret');
    const blocked = new Map<string, SecretFinding[]>();
    const withheld = new Map<string, SecretFinding[]>(); // weak hits in cited code: not read, but the doc keeps its lane
    const add_held_finding = (file_path: string, fs: SecretFinding[]) => {
      if (!fs.length) return;
      // A cited doc is judged on its own: withheld here, never the reason this doc is in the secret lane.
      (!/\.(md|mdx)$/i.test(file_path) && fs.some((finding) => !WEAK_RULES.has(finding.rule)) ? blocked : withheld).set(file_path, fs);
    };
    for (const cited_path of cited) add_held_finding(cited_path, (await time_stage('cited scan', () => scan_cited(join(git_top, cited_path), cited_path))).filter((finding) => finding.kind === 'secret'));
    cited = cited.filter((cited_path) => !blocked.has(cited_path) && !withheld.has(cited_path));
    let bytes = Buffer.byteLength(doc.raw_text);
    for (const cited_path of cited) {
      if (LOCKFILE.test(cited_path)) continue; // a symbol hit in a lockfile is not something the pass reads
      try { bytes += statSync(join(git_top, cited_path)).size; } catch { /* deleted or unreadable */ }
    }

    // Related-repo files the pass reads: bytes count, staleness = sibling commits since the doc's last body change.
    const rel_cited = new Map<RelatedRepo, string[]>();
    for (const sibling_source of [...resolved.filter((result) => result.kind === 'path').map((result) => result.where), ...rel_sources]) {
      const sibling_repo = find_sibling_repo(sibling_source);
      if (sibling_repo && sibling_source) {
        const findings = (await scan_cited(join(sibling_repo.root, sibling_source.slice(sibling_source.indexOf(':') + 1)), sibling_source)).filter((finding) => finding.kind === 'secret');
        if (findings.length) { add_held_finding(sibling_source, findings); if (blocked.has(sibling_source) || withheld.has(sibling_source)) continue; }
      }
      if (sibling_repo && sibling_source) rel_cited.set(sibling_repo, [...(rel_cited.get(sibling_repo) ?? []), sibling_source.slice(sibling_source.indexOf(':') + 1)]);
    }
    for (const [sibling_repo, sibling_paths] of rel_cited) {
      for (const sibling_path of sibling_paths) { try { bytes += statSync(join(sibling_repo.root, sibling_path)).size; } catch { /* gone */ } }
    }

    let stale_commits: number | undefined;
    const repo_path = format_posix_path(relative(git_top, abs_path));
    const find_signal = (): StalenessSignal => {
      const entries = options.staleness_cache?.entries;
      if (!entries) return find_staleness_signal(git_top, repo_path, cited);
      const key = JSON.stringify([repo_path, compute_content_hash(doc.raw_text), cited]);
      return (entries[key] ??= find_staleness_signal(git_top, repo_path, cited));
    };
    const staleness_signal = cited.length ? time_stage('staleness', find_signal) : ({ status: 'none' } as const);
    if (staleness_signal.status === 'signal') stale_commits = staleness_signal.commits;
    if (rel_cited.size) {
      let since = staleness_signal.status === 'signal' ? staleness_signal.doc_date : undefined;
      if (!since) { try { since = find_body_change(git_top, repo_path)?.date; } catch { /* not in git */ } }
      if (since) stale_commits = (stale_commits ?? 0) + [...rel_cited].reduce((count, [doc_path, ps]) => count + count_sibling_commits(doc_path.root, since!, [...new Set(ps)]), 0);
    }
    if (staleness_signal.status === 'unknown' && !stale_warned) (warnings.push(staleness_signal.warning), (stale_warned = true));

    const reasons: string[] = [];
    let lane: Lane;
    const attributed = is_attributed(doc.data);
    if (own_findings.length || blocked.size) {
      lane = 'secret';
      for (const finding of own_findings) reasons.push(`secret: ${format_finding(finding)}`);
      for (const [file_path, findings] of blocked) reasons.push(`cited file blocked: ${file_path} (${findings.map(format_finding).join('; ')})`);
    } else if (checkable >= ARCHIVE_MIN_CHECKABLE && missing.length / checkable >= ARCHIVE_MISSING_SHARE) {
      lane = 'archive-candidate';
      reasons.push(`${missing.length} of ${checkable} checkable references are missing`);
    } else if (!attributed || missing.length || (stale_commits ?? 0) >= STALE_COMMITS_BAR) {
      lane = 'check';
      if (!attributed) reasons.push('no sources/provenance/cites with last_verified');
      if (missing.length) reasons.push(`missing references: ${missing.join(', ')}`);
      if ((stale_commits ?? 0) >= STALE_COMMITS_BAR) reasons.push(`${stale_commits} commits to cited files since the doc last changed`);
    } else if (needs_fields.has(doc.doc_path)) {
      lane = 'fields-only';
      reasons.push('purpose or symptoms missing or weak');
    } else {
      lane = 'clean';
    }

    // Details owned by a sibling: most checkable refs resolve there and the doc does not cross-link into its docs.
    let owner: string | undefined;
    const checked = resolved.filter((result) => result.status !== 'unknown');
    for (const sibling_repo of sibling_repos) {
      const matches = checked.filter((result) => result.status === 'ok' && find_sibling_repo(result.where) === sibling_repo);
      const linked = resolved.some((result) => result.kind === 'doc-link' && result.status === 'ok' && find_sibling_repo(result.where) === sibling_repo);
      if (matches.length >= 2 && matches.length / checked.length > 0.5 && !linked) owner = sibling_repo.name;
    }
    for (const [file_path, findings] of withheld) reasons.push(`cited file withheld: ${file_path} (${findings.map((file) => file.masked).join('; ')})`);
    if (owner && lane !== 'secret') {
      if (lane === 'clean' || lane === 'fields-only') lane = 'check';
      reasons.push(`details owned by ${owner}: summarize and cross-link`);
    }
    const copies = lane === 'secret' ? undefined : dups.get(doc.doc_path);
    if (copies) {
      if (lane === 'clean' || lane === 'fields-only') lane = 'check';
      for (const copy of copies) reasons.push(`copy of ${copy.owner}#${copy.section}${copy.tie ? ` (tie: ${copy.tie.join(', ')})` : ''}`);
    }
    // An overview whose members changed since it was written goes back to check; the verdict is dropped so it stays queued.
    const ledger_entry = options.ledger?.entries[doc.doc_path];
    if (ledger_entry?.members) {
      const changed = Object.entries(ledger_entry.members).filter(([member_path, member_hash]) => { try { return compute_content_hash(readFileSync(join(docs_root, member_path), 'utf-8')) !== member_hash; } catch { return true; } }).map(([member_path]) => member_path);
      if (changed.length && lane !== 'secret') {
        if (lane === 'clean' || lane === 'fields-only') lane = 'check';
        reasons.push(`member changed: ${changed.join(', ')}`);
        delete ledger_entry.verdict;
      }
    }
    // A pointer written by reconcile: re-verify the summary when the owner section changed or vanished.
    if (ledger_entry?.pointer && lane !== 'secret') {
      const [owner_doc_path, anchor = ''] = ledger_entry.pointer.target.split('#');
      let owner_section_hash: string | undefined;
      try { const owner_section = find_section(parse_frontmatter<Record<string, unknown>>(readFileSync(resolve(docs_root, owner_doc_path!), 'utf-8')).content, anchor); owner_section_hash = owner_section === null ? undefined : compute_content_hash(owner_section); } catch { /* owner gone */ }
      if (owner_section_hash !== ledger_entry.pointer.section_hash) {
        if (lane === 'clean' || lane === 'fields-only') lane = 'check';
        reasons.push(owner_section_hash === undefined ? `pointer target changed: ${ledger_entry.pointer.target} (section missing)` : `pointer target changed: ${ledger_entry.pointer.target}`);
        delete ledger_entry.verdict;
      }
    }
    // eslint-disable-next-line id-denylist -- serialized key (triage/graph JSON)
    docs.push({ path: doc.doc_path, lane, reasons, missing, refs: resolved.map(({ kind, ref: reference, status, where, whereKind: where_kind }) => ({ kind, ref: reference, status, ...(where !== undefined && { where }), ...(where_kind && { whereKind: where_kind }) })), bytes, ...(stale_commits !== undefined && { staleCommits: stale_commits }), ...(owner && { owner }), ...(copies && { duplicates: copies }), ...(own_findings.length && { findings: own_findings }), ...(blocked.size + withheld.size > 0 && { blocked_files: [...blocked.keys(), ...withheld.keys()].sort() }) });

    if (options.ledger) build_ledger_entry(options.ledger, { path: doc.doc_path, lane, content_hash: compute_content_hash(doc.raw_text) });
  }
  docs.sort((a, b) => a.path.localeCompare(b.path));

  const by_lane: Record<Lane, number> = { clean: 0, 'fields-only': 0, check: 0, 'archive-candidate': 0, secret: 0 };
  for (const doc of docs) by_lane[doc.lane]++;
  const judged = docs.filter((doc) => doc.lane === 'fields-only' || doc.lane === 'check');
  const judgment_bytes = judged.reduce((total, doc) => total + doc.bytes, 0);
  const team_config = config.reconcile.team;
  const auto = judged.length >= team_config.min_docs || judgment_bytes >= team_config.min_bytes ? 'team' : 'serial';
  let mode = options.mode ?? auto;
  let shards = mode === 'team' ? await build_shards(docs_root, judged, config) : [];
  // One shard is just a serial run with agent overhead.
  if (mode === 'team' && !options.mode && shards.length < 2) (mode = 'serial'), (shards = []);

  return {
    docs,
    totals: { docs: docs.length, bytes: docs.reduce((total, doc) => total + doc.bytes, 0), byLane: by_lane, judgmentDocs: judged.length, judgmentBytes: judgment_bytes },
    mode,
    shards,
    warnings,
    schemaFiles: index.schema_files,
    peripheral,
  };
}

/**
 * `reconcile --changed` (#98): the docs created or changed since their last review. Not reviewed (see `is_reviewed`) and
 * either edited after the ledger last saw them, or triaging outside the clean lane (a new doc). Writes nothing, the ledger included:
 * saving the new hashes would make an edited doc look reviewed. Dirty docs are expected here, so there is no clean-tree check.
 */
export async function select_changed(options: { root: string; docs_root: string; config: PluginConfig; ledger: Ledger; scope?: string[] }): Promise<{ doc_paths: string[]; triage: TriageResult }> {
  const { docs_root, ledger } = options;
  const everything = options.scope?.length ? await resolve_scope(docs_root, options.scope) : (await list_markdown_files(docs_root)).map((file) => format_posix_path(relative(docs_root, file))).sort();
  const hash_of = (doc_path: string): string => compute_content_hash(readFileSync(join(docs_root, doc_path), 'utf-8'));
  const candidates = everything.filter((doc_path) => !is_reviewed(ledger.entries[doc_path], hash_of(doc_path)));
  const run = (rels: string[]): Promise<TriageResult> => triage_docs({ root: options.root, docs_root, rels, config: options.config, ledger: structuredClone(ledger) });
  let triage = await run(candidates);
  const lane = new Map(triage.docs.map((doc) => [doc.path, doc.lane]));
  const doc_paths = candidates.filter((doc_path) => lane.get(doc_path) !== 'clean' || (ledger.entries[doc_path] && ledger.entries[doc_path]!.content_hash !== hash_of(doc_path)));
  if (doc_paths.length !== candidates.length) triage = await run(doc_paths);
  return { doc_paths, triage };
}

/** Read-only resolution of some docs for the graph export: no ledger, no dirty-tree check (that lives in the CLI). */
export async function resolve_docs(options: { root: string; docs_root: string; rels: string[]; config: PluginConfig; ledger?: Ledger; staleness_cache?: { entries: Record<string, StalenessSignal> }; duplicates?: Map<string, Duplicate[]>; symbol_table?: SymbolTable }): Promise<TriageDoc[]> {
  // A copy, so the ledger-driven reasons (pointer target / member changed) fire without recording anything.
  const { ledger, ...rest } = options;
  return (await triage_docs({ ...rest, ...(ledger && { ledger: structuredClone(ledger) }) })).docs;
}

/**
 * Group judged docs so linked docs share a shard (overview clusters, merged if they overlap;
 * the rest chunked per domain), split any group larger than a fair share, then bin-pack by
 * bytes into at most `max_agents` shards.
 */
export async function build_shards(docs_root: string, judged: Pick<TriageDoc, 'path' | 'bytes'>[], config: PluginConfig): Promise<Shard[]> {
  if (!judged.length) return [];
  const { max_agents, docs_per_agent, min_bytes } = config.reconcile.team;
  const bytes = new Map(judged.map((doc) => [doc.path, doc.bytes]));

  // union-find over cluster members
  const parent = new Map<string, string>();
  const find_root = (item: string): string => {
    let root = item;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(item, root);
    return root;
  };
  for (const doc_path of bytes.keys()) parent.set(doc_path, doc_path);
  try {
    for (const cluster of await find_clusters(docs_root, config.overview)) {
      const in_scope = cluster.members.filter((member) => bytes.has(member));
      for (const member of in_scope.slice(1)) parent.set(find_root(member), find_root(in_scope[0]!));
    }
  } catch { /* no link graph: domain chunks only */ }

  const groups = new Map<string, string[]>();
  for (const doc_path of [...bytes.keys()].sort()) (groups.get(find_root(doc_path)) ?? groups.set(find_root(doc_path), []).get(find_root(doc_path))!).push(doc_path);

  // singletons (not in a cluster) are chunked per domain, so a big domain still splits
  const units: string[][] = [];
  const loose = new Map<string, string[]>();
  for (const group of groups.values()) {
    if (group.length > 1) units.push(group);
    else (loose.get(group[0]!.split('/')[0]!) ?? loose.set(group[0]!.split('/')[0]!, []).get(group[0]!.split('/')[0]!)!).push(group[0]!);
  }
  for (const loose_group of loose.values()) for (let i = 0; i < loose_group.length; i += docs_per_agent) units.push(loose_group.slice(i, i + docs_per_agent));

  const shard_count = Math.max(1, Math.min(max_agents, judged.length, Math.max(Math.ceil(judged.length / docs_per_agent), Math.ceil(judged.reduce((total, doc) => total + doc.bytes, 0) / min_bytes))));
  const shards: Shard[] = Array.from({ length: shard_count }, (_, id) => ({ id: id + 1, docs: [], bytes: 0 }));
  const compute_size = (unit: string[]): number => unit.reduce((total, doc_path) => total + bytes.get(doc_path)!, 0);
  // A cluster bigger than a fair share is split in path order (same-folder docs stay together),
  // or one agent would carry most of a big job. Safe: apply is serial and hash-checked.
  const fair = Math.ceil(judged.length / shard_count);
  const fitted = units.flatMap((unit) => (unit.length <= fair ? [unit] : Array.from({ length: Math.ceil(unit.length / fair) }, (_, i) => unit.slice(i * fair, (i + 1) * fair))));
  for (const unit of fitted.sort((a, b) => compute_size(b) - compute_size(a) || a[0]!.localeCompare(b[0]!))) {
    const target_shard = shards.reduce((smallest, shard) => (shard.bytes < smallest.bytes ? shard : smallest));
    target_shard.docs.push(...unit);
    target_shard.bytes += compute_size(unit);
  }
  for (const shard of shards) shard.docs.sort();
  return shards.filter((shard) => shard.docs.length);
}
