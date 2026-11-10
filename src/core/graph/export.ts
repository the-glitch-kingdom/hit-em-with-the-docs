/**
 * Build the `.hewtd/graph.json` v1 object (#65) from the reconcile resolver, ledger,
 * duplicates and git dates. Read-only on the docs tree; deterministic for an unchanged tree.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import type { PluginConfig } from '../../utils/config.js';
import { parse_frontmatter } from '../../utils/frontmatter.js';
import { compute_content_hash, load_ledger } from '../reconcile/ledger.js';
import { validate_no_secrets } from '../reconcile/secrets.js';
import { find_git_top, list_markdown_files, resolve_docs, STALE_COMMITS_BAR } from '../reconcile/triage.js';
import { find_duplicates } from '../reconcile/duplicates.js';
import { build_glob_regex, drop_changed_symbols, find_md_mentions, is_path_ref_affected, type SymbolTable } from '../reconcile/references.js';
import { find_body_changed_dates, find_file_dates } from './dates.js';
import { reset_history_memo } from '../reconcile/staleness.js';
import { compute_code_snapshot, list_code_changes, list_committed_changes, compute_fingerprint, compute_link_fingerprint, compute_graph_hash, is_fingerprint_current, load_doc_cache, load_staleness_cache, load_symbol_table, dump_symbol_table, write_cache_fields, type DocEntry, type GraphTriage } from './cache.js';
import { print_timings, time_stage } from './timing.js';
import { GRAPH_VERSION, type GraphDoc, type GraphRef, type GraphRefKind, type GraphSymbol, type GraphV1, type GraphVerdict } from './schema.js';

const format_posix_path = (path_text: string): string => path_text.split('\\').join('/');
const compare_strings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** More changed paths than this and the incremental path is not worth its checks: run everything. */
const MAX_CODE_CHANGES = 2000;
const KIND: Record<string, GraphRefKind> = { path: 'file', 'doc-link': 'doc' };

function get_verdict(doc: GraphTriage, ledger_verified: boolean, in_ledger: boolean): GraphVerdict {
  if (doc.lane === 'secret') return 'secret';
  if (doc.lane === 'archive-candidate') return 'archive-candidate';
  if (doc.lane === 'clean') return 'verified'; // attributed (sources + last_verified) and every ref resolves
  // Never through reconcile: say so instead of guessing check/fields-only (refs still carry resolved:false).
  if (!in_ledger) return 'unreviewed';
  // a pointer or overview member that changed drops the verdict, as in triage
  if (ledger_verified && !doc.reasons.some((reason) => /^(member changed|pointer target changed)/.test(reason))) return 'verified';
  if (doc.lane === 'fields-only') return 'fields-only';
  const only_stale = doc.reasons.length > 0 && doc.reasons.every((reason) => /commits to cited files/.test(reason)) && (doc.staleCommits ?? 0) >= STALE_COMMITS_BAR;
  return only_stale ? 'stale' : 'check';
}

function find_head(git_top: string): string | null {
  // eslint-disable-next-line id-denylist -- child_process option name
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: git_top, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; /* not a repo, or no commits */ }
}

export async function build_graph(options: { root: string; docs_root: string; config: PluginConfig; dry_run?: boolean }): Promise<GraphV1> {
  const { root: repo_root, docs_root: docs_root, config } = options;
  reset_history_memo();
  const git_top = find_git_top(docs_root) ?? repo_root;
  // exactly the set triage judges: the export and triage cannot diverge
  const doc_paths = (await list_markdown_files(docs_root)).map((file) => format_posix_path(relative(docs_root, file))).sort(compare_strings);
  const raws = new Map<string, { raw_text: string; data: Record<string, unknown> }>();
  for (const doc_path of doc_paths) {
    const raw_text = readFileSync(join(docs_root, doc_path), 'utf-8');
    raws.set(doc_path, { raw_text, data: parse_frontmatter<Record<string, unknown>>(raw_text).data });
  }
  const kept = [...raws.keys()];
  const ledger = await load_ledger(resolve(repo_root, config.reconcile.ledger_path));
  const head = find_head(git_top);
  let staleness_cache = head ? load_staleness_cache(git_top, head) : undefined;
  const ledger_path = resolve(repo_root, config.reconcile.ledger_path);
  const snapshot = compute_code_snapshot({ git_top, docs_root, config, ledger_path });
  const code_state = snapshot?.state ?? null;
  let prior = load_doc_cache(git_top, code_state);
  const prior_head = prior.head;
  // commits since the cached HEAD name the docs and code files that moved; no known ancestor (amend, rebase, branch switch): full path
  const committed = prior_head && head ? list_committed_changes(git_top, prior_head, head) : null;
  const code_changes = committed && snapshot ? list_code_changes(prior, snapshot, committed) : null;
  const incremental = !!code_changes && code_changes.size <= MAX_CODE_CHANGES && !!prior.bins;
  if (!incremental) prior = { state: '', entries: {}, mentions: {} };
  if (staleness_cache && committed && prior_head !== head) { // a doc's signal holds unless a commit touched the doc or a file it cites
    const carried = Object.entries(load_staleness_cache(git_top, prior_head!).entries).filter(([key]) => { const [doc_path, , cited] = JSON.parse(key) as [string, string, string[]]; return !committed.has(doc_path) && !cited.some((file) => committed.has(file)); });
    staleness_cache = { head: head!, entries: Object.fromEntries(carried) };
  }
  const touched = [...committed ?? []].filter((file) => /\.mdx?$/.test(file)).map((file) => join(git_top, file));
  const duplicates = await time_stage('duplicates', () => find_duplicates(docs_root, config));
  const hashes = new Map(kept.map((doc_path) => [doc_path, compute_content_hash(raws.get(doc_path)!.raw_text)]));
  const ledger_text = (doc_path: string): string => JSON.stringify(ledger.entries[doc_path] ?? null);
  const duplicates_text = (doc_path: string): string => JSON.stringify(duplicates.get(doc_path) ?? null);
  // Reuse an entry while its doc, ledger entry and duplicates are as cached, nothing it points at changed, and the
  // markdown mentions behind its code-less names are the same: then only the other docs are resolved again.
  const changed = new Set<string>(); // absolute paths of docs that are new, edited or gone
  for (const doc_path of kept) if (prior.entries[doc_path]?.hash !== hashes.get(doc_path)) changed.add(join(docs_root, doc_path));
  for (const doc_path of Object.keys(prior.entries)) if (!raws.has(doc_path)) changed.add(join(docs_root, doc_path));
  for (const abs_path of touched) changed.add(abs_path);
  const markdown_moved = changed.size > 0 || [...code_changes ?? []].some((file) => /\.mdx?$/.test(file)); // what the unfound names' markdown mentions depend on
  // Code that moved: a symbol answer it may alter (recomputed whole-repo), and what else a doc's refs read from the repo.
  const symbol_table: SymbolTable = incremental ? load_symbol_table(git_top, code_state) : { state: code_state ?? '', symbols: new Map() };
  const moved = incremental ? code_changes! : new Set<string>();
  const dropped_symbols = drop_changed_symbols(git_top, symbol_table, moved);
  for (const file of moved) changed.add(join(git_top, file));
  const prior_bins = new Set(prior.bins), bins = new Set(snapshot?.bins);
  const moved_bins = new Set([...prior_bins, ...bins].filter((bin) => prior_bins.has(bin) !== bins.has(bin))); // `npx <bin>` resolves against node_modules/.bin
  const schema_globs = config.reconcile.schema_sources.map(build_glob_regex);
  const package_moved = [...moved].some((file) => file === 'package.json' || file.endsWith('/package.json'));
  const schema_moved = [...moved].some((file) => schema_globs.some((schema_glob) => schema_glob.test(file)));
  // triage also reads .gitignore (ignored refs are not checkable), whether the repo has a secret/ folder and, for an env ref, its lowercase settings field (#84)
  const gitignore_moved = [...moved].some((file) => file === '.gitignore' || file.endsWith('/.gitignore'));
  const secret_dir_moved = [...moved].some((file) => file.startsWith('secret/'));
  const reads_moved_code = (doc_path: string, entry: DocEntry): boolean => entry.triage.refs.some((reference) => {
    switch (reference.kind) {
      case 'symbol': return dropped_symbols.has(reference.ref);
      case 'env': return dropped_symbols.has(reference.ref) || dropped_symbols.has(reference.ref.toLowerCase());
      case 'path': {
        const from_doc = /^\.\.?\//.test(reference.ref) ? format_posix_path(relative(git_top, resolve(dirname(join(docs_root, doc_path)), reference.ref))) : undefined;
        return is_path_ref_affected(reference.ref, moved) || (!!from_doc && !from_doc.startsWith('..') && is_path_ref_affected(from_doc, moved))
          || (gitignore_moved && reference.status !== 'ok') || (secret_dir_moved && reference.ref.startsWith('secret/'));
      }
      case 'command': return reference.ref.startsWith('make ') ? moved.has('Makefile') : package_moved || (reference.ref.startsWith('npx ') && moved_bins.has(reference.ref.replace(/^\S+( run)? /, '')));
      case 'table': case 'column': return schema_moved;
      default: return false;
    }
  });
  /** Absolute targets of a doc's doc-links; null when one cannot be decoded. */
  const get_link_targets = (doc_path: string, doc_refs: GraphTriage['refs']): string[] | null => {
    try { return doc_refs.filter((reference) => reference.kind === 'doc-link').map((reference) => resolve(dirname(join(docs_root, doc_path)), decodeURI(reference.ref.split(/[#?]/)[0]!))); } catch { return null; }
  };
  // Link targets that are not kept docs (archive/, INDEX.md, dot-dirs, untracked) are fingerprinted per entry instead.
  const kept_abs = new Set(kept.map((doc_path) => join(docs_root, doc_path)));
  const compute_outside = (targets: string[]): Record<string, string> => Object.fromEntries(targets.filter((target) => !kept_abs.has(target)).map((target) => [format_posix_path(relative(git_top, target)), compute_link_fingerprint(target)]));
  const points_at_changed = (doc_path: string, entry: DocEntry): boolean => {
    const ledger_entry = ledger.entries[doc_path];
    const sources = raws.get(doc_path)!.data.sources;
    const targets = [
      ...(Array.isArray(sources) ? sources.filter((source): source is string => typeof source === 'string').map((source) => resolve(git_top, source)) : []),
      ...Object.keys(ledger_entry?.members ?? {}).map((member) => join(docs_root, member)),
      ...(ledger_entry?.pointer ? [join(docs_root, ledger_entry.pointer.target.split('#')[0]!)] : []),
    ];
    for (const reference of entry.triage.refs) if (reference.kind === 'path') targets.push(resolve(git_top, reference.where ?? reference.ref.replace(/:\d+(?::\d+)?$/, '')));
    const link_targets = get_link_targets(doc_path, entry.triage.refs);
    if (!link_targets) return true;
    return [...targets, ...link_targets].some((target) => changed.has(target)) || JSON.stringify(compute_outside(link_targets)) !== JSON.stringify(entry.outside ?? {});
  };
  // a path-shaped value is not a secret while that file exists (#86): a doc whose text names a changed path is scanned again
  const names_moved_path = (doc_path: string): boolean => { const text = raws.get(doc_path)!.raw_text; return [...moved].some((file) => text.includes(file)); };
  const reusable = kept.filter((doc_path) => {
    const entry = prior.entries[doc_path];
    return !!entry && !changed.has(join(docs_root, doc_path)) && entry.hash === hashes.get(doc_path) && entry.ledger === ledger_text(doc_path) && entry.duplicates === duplicates_text(doc_path) && !points_at_changed(doc_path, entry) && !reads_moved_code(doc_path, entry) && !names_moved_path(doc_path);
  });
  const unfound_names = [...new Set(reusable.flatMap((doc_path) => prior.entries[doc_path]!.unfound))];
  const mentions = markdown_moved && unfound_names.length ? find_md_mentions(git_top, unfound_names) : undefined;
  const reused = new Set(mentions ? reusable.filter((doc_path) => prior.entries[doc_path]!.unfound.every((name) => JSON.stringify([...mentions.get(name) ?? []]) === JSON.stringify(prior.mentions[name] ?? []))) : reusable);
  const to_resolve = kept.filter((doc_path) => !reused.has(doc_path));
  const resolved_docs = to_resolve.length ? await time_stage('triage (total)', () => resolve_docs({ root: repo_root, docs_root: docs_root, rels: to_resolve, config, ledger, duplicates, symbol_table, ...(staleness_cache && { staleness_cache }) })) : [];
  const entries: Record<string, DocEntry> = {};
  for (const doc_path of kept) entries[doc_path] = prior.entries[doc_path]!;
  for (const resolved_doc of resolved_docs) {
    const doc_path = resolved_doc.path;
    entries[doc_path] = {
      outside: compute_outside(get_link_targets(doc_path, resolved_doc.refs) ?? []),
      hash: hashes.get(doc_path)!, ledger: ledger_text(doc_path), duplicates: duplicates_text(doc_path),
      unfound: [...new Set(resolved_doc.refs.filter((item) => (item.kind === 'symbol' || item.kind === 'env') && item.status !== 'ok').map((item) => item.ref))],
      // eslint-disable-next-line id-denylist, @typescript-eslint/naming-convention -- serialized keys (triage/graph JSON)
      triage: { lane: resolved_doc.lane, reasons: resolved_doc.reasons, missing: resolved_doc.missing, refs: resolved_doc.refs, ...(resolved_doc.staleCommits !== undefined && { staleCommits: resolved_doc.staleCommits }), ...(resolved_doc.duplicates && { duplicates: resolved_doc.duplicates }) },
    };
  }
  const triaged = new Map(kept.map((doc_path) => [doc_path, entries[doc_path]!.triage]));
  const body = time_stage('body dates', () => find_body_changed_dates(git_top, kept.map((doc_path) => ({ path: format_posix_path(relative(git_top, join(docs_root, doc_path))), content: raws.get(doc_path)!.raw_text })), { persist: !options.dry_run }));

  const own_dates = time_stage('file dates', () => find_file_dates(git_top));
  const sibling_dates = new Map(config.reconcile.related_repos.map((related_repo) => [related_repo.name, find_file_dates(resolve(repo_root, related_repo.path))]));
  const get_date = (where: string): { repo?: string; file: string; date?: string | undefined } => {
    const match = /^([\w.-]+):(.+)$/.exec(where);
    const name = match && sibling_dates.has(match[1]!) ? match[1]! : undefined;
    const file = name ? match![2]! : where;
    return { ...(name && { repo: name }), file, date: (name ? sibling_dates.get(name) : own_dates)?.dates.get(file) };
  };

  const docs: Record<string, GraphDoc> = {};
  const symbols: Record<string, GraphSymbol> = {};
  const owners = new Map<string, Set<string>>();
  const add_owner = (doc: string, entry: string): void => { (owners.get(doc) ?? owners.set(doc, new Set()).get(doc)!).add(entry); };

  for (const doc_path of kept) {
    const triage_doc = triaged.get(doc_path)!;
    const ledger_entry = ledger.entries[doc_path];
    const references = new Map<string, GraphRef>();
    for (const resolved of triage_doc.refs) {
      const kind = KIND[resolved.kind] ?? (resolved.kind as GraphRefKind);
      const reference: GraphRef = { kind, target: resolved.ref, resolved: resolved.status === 'ok' ? true : resolved.status === 'missing' ? false : null };
      if (resolved.status === 'ok' && resolved.where && (resolved.kind === 'path' || resolved.kind === 'symbol' || resolved.kind === 'env')) {
        const where_date = get_date(resolved.where);
        if (resolved.kind !== 'path') reference.file = where_date.file;
        if (resolved.kind === 'symbol' && resolved.whereKind) reference.file_kind = resolved.whereKind;
        if (where_date.repo) reference.repo = where_date.repo;
        if (where_date.date) reference.code_changed = where_date.date;
        if (resolved.kind === 'symbol') {
          const symbol = (symbols[resolved.ref] ??= { file: where_date.file, ...(resolved.whereKind && { file_kind: resolved.whereKind }), cited_by: [] });
          if (!symbol.cited_by.includes(doc_path)) symbol.cited_by.push(doc_path);
        }
      }
      references.set(`${kind}\0${resolved.ref}`, reference);
    }
    // gone frontmatter `sources` are in triage's `missing` but not in its refs
    for (const match of triage_doc.missing) if (![...references.values()].some((item) => item.target === match && item.resolved === false)) references.set(`file\0${match}`, { kind: 'file', target: match, resolved: false });

    const last_verified_value = raws.get(doc_path)!.data.last_verified;
    const doc_repo_path = format_posix_path(relative(git_top, join(docs_root, doc_path)));
    docs[doc_path] = {
      body_changed: body.dates.get(doc_repo_path) ?? null,
      verdict: get_verdict(triage_doc, ledger_entry?.verdict === 'verify' && ledger_entry.content_hash === compute_content_hash(raws.get(doc_path)!.raw_text), !!ledger_entry),
      last_verified: typeof last_verified_value === 'string' ? last_verified_value : last_verified_value instanceof Date ? last_verified_value.toISOString().slice(0, 10) : null,
      // eslint-disable-next-line id-denylist -- serialized key (triage/graph JSON)
      refs: [...references.values()].sort((a, b) => compare_strings(a.kind, b.kind) || compare_strings(a.target, b.target)),
      owner_of: [],
      points_to: ledger_entry?.pointer ? [{ from: null, to: ledger_entry.pointer.target }] : [],
      duplicates: (triage_doc.duplicates ?? []).map((doc) => ({ section: `#${doc.section}`, owner: `${doc.owner}#${doc.section}` })).sort((a, b) => compare_strings(a.owner, b.owner)),
    };
    if (ledger_entry?.pointer) add_owner(ledger_entry.pointer.target.split('#')[0]!, ledger_entry.pointer.target);
    for (const doc of triage_doc.duplicates ?? []) add_owner(doc.owner, `${doc.owner}#${doc.section}`);
  }
  for (const [doc, set] of owners) if (docs[doc]) docs[doc]!.owner_of = [...set].sort(compare_strings);
  for (const symbol of Object.values(symbols)) symbol.cited_by.sort(compare_strings);

  if (staleness_cache && !options.dry_run) {
    const mention_names = [...new Set(Object.values(entries).flatMap((entry) => entry.unfound))];
    const doc_cache = code_state ? { doc_cache: { state: code_state, head: head!, dirty: snapshot!.dirty, bins: snapshot!.bins, entries, mentions: Object.fromEntries([...find_md_mentions(git_top, mention_names)].map(([name, files]) => [name, [...files]])) } } : {};
    write_cache_fields(git_top, { staleness: { head: head!, entries: staleness_cache.entries }, ...doc_cache, ...(code_state && { symbol_cache: dump_symbol_table(symbol_table) }) });
  }
  print_timings();
  return { version: GRAPH_VERSION, source_commit: head, docs, symbols };
}

/** Sorted keys at every level, 2-space indent, trailing newline: byte-identical for equal graphs. */
export function render_graph(graph: GraphV1): string {
  const sort_keys = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(sort_keys) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort(compare_strings).map((key) => [key, sort_keys((value as Record<string, unknown>)[key])])) : value;
  return JSON.stringify(sort_keys(graph), null, 2) + '\n';
}

export interface WriteGraphResult {
  status: 'disabled' | 'no-git' | 'unchanged' | 'written' | 'would-write';
  file?: string;
  /** True when a new file was created and git does not ignore it (print a hint; never edit .gitignore). */
  hint?: boolean;
}

/** Build and write `<git root>/.hewtd/graph.json`; a byte-identical file is left alone (mtime kept). */
export async function write_graph(options: { root: string; docs_root: string; config: PluginConfig; dry_run?: boolean }): Promise<WriteGraphResult> {
  if (!options.config.graph_export) return { status: 'disabled' };
  const git_top = find_git_top(options.docs_root);
  if (!git_top) return { status: 'no-git' };
  const file = join(git_top, '.hewtd', 'graph.json');
  const had = existsSync(file);
  // Fast path: same inputs as the run that wrote the current graph.json, and that file is untouched.
  const doc_hashes = (await list_markdown_files(options.docs_root)).map((abs_path) => ({ path: format_posix_path(relative(options.docs_root, abs_path)), hash: compute_content_hash(readFileSync(abs_path, 'utf-8')) })).sort((a, b) => compare_strings(a.path, b.path));
  const fingerprint = compute_fingerprint({ git_top, docs_root: options.docs_root, config: options.config, ledger_path: resolve(options.root, options.config.reconcile.ledger_path), docs: doc_hashes });
  if (had && is_fingerprint_current(git_top, fingerprint, readFileSync(file, 'utf-8'))) return { status: 'unchanged', file };
  const graph_text = render_graph(await build_graph(options));
  validate_no_secrets(graph_text, 'the graph export', options.config.reconcile.secrets);
  const remember = (): void => { if (fingerprint && !options.dry_run) write_cache_fields(git_top, { fingerprint: { value: fingerprint, graph_hash: compute_graph_hash(graph_text) } }); };
  if (had && readFileSync(file, 'utf-8') === graph_text) return (remember(), { status: 'unchanged', file });
  if (options.dry_run) return { status: 'would-write', file };
  mkdirSync(join(git_top, '.hewtd'), { recursive: true });
  writeFileSync(file, graph_text);
  remember();
  let ignored = true;
  // eslint-disable-next-line id-denylist -- child_process option name
  try { execFileSync('git', ['check-ignore', '-q', file], { cwd: git_top, stdio: 'ignore' }); } catch { ignored = false; }
  return { status: 'written', file, ...(!had && !ignored && { hint: true }) };
}
