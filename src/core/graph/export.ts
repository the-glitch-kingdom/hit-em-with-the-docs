/**
 * Build the `.hewtd/graph.json` v1 object (#65) from the reconcile resolver, ledger,
 * duplicates and git dates. Read-only on the docs tree; deterministic for an unchanged tree.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import type { PluginConfig } from '../../utils/config.js';
import { parse_frontmatter } from '../../utils/frontmatter.js';
import { compute_content_hash, load_ledger } from '../reconcile/ledger.js';
import { validate_no_secrets } from '../reconcile/secrets.js';
import { find_git_top, list_markdown_files, resolve_docs, STALE_COMMITS_BAR, type TriageDoc } from '../reconcile/triage.js';
import { find_body_changed_dates, find_file_dates } from './dates.js';
import { GRAPH_VERSION, type GraphDoc, type GraphRef, type GraphRefKind, type GraphSymbol, type GraphV1, type GraphVerdict } from './schema.js';

const format_posix_path = (path_text: string): string => path_text.split('\\').join('/');
const compare_strings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const KIND: Record<string, GraphRefKind> = { path: 'file', 'doc-link': 'doc' };

function get_verdict(doc: TriageDoc, ledger_verified: boolean, in_ledger: boolean): GraphVerdict {
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

export async function build_graph(options: { root: string; docs_path: string; config: PluginConfig; dry_run?: boolean }): Promise<GraphV1> {
  const { root: repo_root, docs_path, config } = options;
  const git_top = find_git_top(docs_path) ?? repo_root;
  // exactly the set triage judges: the export and triage cannot diverge
  const doc_paths = (await list_markdown_files(docs_path)).map((file) => format_posix_path(relative(docs_path, file))).sort(compare_strings);
  const raws = new Map<string, { raw_text: string; data: Record<string, unknown> }>();
  for (const doc_path of doc_paths) {
    const raw_text = readFileSync(join(docs_path, doc_path), 'utf-8');
    raws.set(doc_path, { raw_text, data: parse_frontmatter<Record<string, unknown>>(raw_text).data });
  }
  const kept = [...raws.keys()];
  const ledger = await load_ledger(resolve(repo_root, config.reconcile.ledger_path));
  const triaged = new Map((await resolve_docs({ root: repo_root, docs_path, rels: kept, config, ledger })).map((doc) => [doc.path, doc]));
  const body = find_body_changed_dates(git_top, kept.map((doc_path) => ({ path: format_posix_path(relative(git_top, join(docs_path, doc_path))), content: raws.get(doc_path)!.raw_text })), { persist: !options.dry_run });

  const own_dates = find_file_dates(git_top);
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
    const doc_repo_path = format_posix_path(relative(git_top, join(docs_path, doc_path)));
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

  let head: string | null = null;
  // eslint-disable-next-line id-denylist -- child_process option name
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: git_top, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a repo, or no commits */ }
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
export async function write_graph(options: { root: string; docs_path: string; config: PluginConfig; dry_run?: boolean }): Promise<WriteGraphResult> {
  if (!options.config.graph_export) return { status: 'disabled' };
  const git_top = find_git_top(options.docs_path);
  if (!git_top) return { status: 'no-git' };
  const file = join(git_top, '.hewtd', 'graph.json');
  const graph_text = render_graph(await build_graph(options));
  validate_no_secrets(graph_text, 'the graph export', options.config.reconcile.secrets);
  const had = existsSync(file);
  if (had && readFileSync(file, 'utf-8') === graph_text) return { status: 'unchanged', file };
  if (options.dry_run) return { status: 'would-write', file };
  mkdirSync(join(git_top, '.hewtd'), { recursive: true });
  writeFileSync(file, graph_text);
  let ignored = true;
  // eslint-disable-next-line id-denylist -- child_process option name
  try { execFileSync('git', ['check-ignore', '-q', file], { cwd: git_top, stdio: 'ignore' }); } catch { ignored = false; }
  return { status: 'written', file, ...(!had && !ignored && { hint: true }) };
}
