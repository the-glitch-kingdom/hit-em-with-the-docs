/**
 * Build the `.hewtd/graph.json` v1 object (#65) from the reconcile resolver, ledger,
 * duplicates and git dates. Read-only on the docs tree; deterministic for an unchanged tree.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import type { PluginConfig } from '../../utils/config.js';
import { parse_frontmatter } from '../../utils/frontmatter.js';
import { hash_content, load_ledger } from '../reconcile/ledger.js';
import { assert_no_secrets } from '../reconcile/secrets.js';
import { git_root, md_files, resolve_docs, STALE_COMMITS_BAR, type TriageDoc } from '../reconcile/triage.js';
import { body_changed_dates, last_changed } from './dates.js';
import { GRAPH_VERSION, type GraphDoc, type GraphRef, type GraphRefKind, type GraphSymbol, type GraphV1, type GraphVerdict } from './schema.js';

const posix = (p: string): string => p.split('\\').join('/');
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const KIND: Record<string, GraphRefKind> = { path: 'file', 'doc-link': 'doc' };

function verdict_of(d: TriageDoc, ledger_verified: boolean, in_ledger: boolean): GraphVerdict {
  if (d.lane === 'secret') return 'secret';
  if (d.lane === 'archive-candidate') return 'archive-candidate';
  if (d.lane === 'clean') return 'verified'; // attributed (sources + last_verified) and every ref resolves
  // Never through reconcile: say so instead of guessing check/fields-only (refs still carry resolved:false).
  if (!in_ledger) return 'unreviewed';
  // a pointer or overview member that changed drops the verdict, as in triage
  if (ledger_verified && !d.reasons.some((r) => /^(member changed|pointer target changed)/.test(r))) return 'verified';
  if (d.lane === 'fields-only') return 'fields-only';
  const only_stale = d.reasons.length > 0 && d.reasons.every((r) => /commits to cited files/.test(r)) && (d.staleCommits ?? 0) >= STALE_COMMITS_BAR;
  return only_stale ? 'stale' : 'check';
}

export async function build_graph(opts: { root: string; docs_path: string; config: PluginConfig; dry_run?: boolean }): Promise<GraphV1> {
  const { root, docs_path, config } = opts;
  const repo = git_root(docs_path) ?? root;
  // exactly the set triage judges: the export and triage cannot diverge
  const rels = (await md_files(docs_path)).map((f) => posix(relative(docs_path, f))).sort(cmp);
  const raws = new Map<string, { raw: string; data: Record<string, unknown> }>();
  for (const r of rels) {
    const raw = readFileSync(join(docs_path, r), 'utf-8');
    raws.set(r, { raw, data: parse_frontmatter<Record<string, unknown>>(raw).data });
  }
  const kept = [...raws.keys()];
  const ledger = await load_ledger(resolve(root, config.reconcile.ledger_path));
  const triaged = new Map((await resolve_docs({ root, docs_path, rels: kept, config, ledger })).map((d) => [d.path, d]));
  const body = body_changed_dates(repo, kept.map((r) => ({ path: posix(relative(repo, join(docs_path, r))), content: raws.get(r)!.raw })), { persist: !opts.dry_run });

  const own = last_changed(repo);
  const sibs = new Map(config.reconcile.related_repos.map((r) => [r.name, last_changed(resolve(root, r.path))]));
  const date_of = (where: string): { repo?: string; file: string; date?: string | undefined } => {
    const m = /^([\w.-]+):(.+)$/.exec(where);
    const name = m && sibs.has(m[1]!) ? m[1]! : undefined;
    const file = name ? m![2]! : where;
    return { ...(name && { repo: name }), file, date: (name ? sibs.get(name) : own)?.dates.get(file) };
  };

  const docs: Record<string, GraphDoc> = {};
  const symbols: Record<string, GraphSymbol> = {};
  const owners = new Map<string, Set<string>>();
  const own_ = (doc: string, entry: string): void => { (owners.get(doc) ?? owners.set(doc, new Set()).get(doc)!).add(entry); };

  for (const rel of kept) {
    const t = triaged.get(rel)!;
    const led = ledger.entries[rel];
    const refs = new Map<string, GraphRef>();
    for (const r of t.refs) {
      const kind = KIND[r.kind] ?? (r.kind as GraphRefKind);
      const ref: GraphRef = { kind, target: r.ref, resolved: r.status === 'ok' ? true : r.status === 'missing' ? false : null };
      if (r.status === 'ok' && r.where && (r.kind === 'path' || r.kind === 'symbol' || r.kind === 'env')) {
        const w = date_of(r.where);
        if (r.kind !== 'path') ref.file = w.file;
        if (r.kind === 'symbol' && r.whereKind) ref.file_kind = r.whereKind;
        if (w.repo) ref.repo = w.repo;
        if (w.date) ref.code_changed = w.date;
        if (r.kind === 'symbol') {
          const s = (symbols[r.ref] ??= { file: w.file, ...(r.whereKind && { file_kind: r.whereKind }), cited_by: [] });
          if (!s.cited_by.includes(rel)) s.cited_by.push(rel);
        }
      }
      refs.set(`${kind}\0${r.ref}`, ref);
    }
    // gone frontmatter `sources` are in triage's `missing` but not in its refs
    for (const m of t.missing) if (![...refs.values()].some((x) => x.target === m && x.resolved === false)) refs.set(`file\0${m}`, { kind: 'file', target: m, resolved: false });

    const lv = raws.get(rel)!.data.last_verified;
    const doc_repo_path = posix(relative(repo, join(docs_path, rel)));
    docs[rel] = {
      body_changed: body.dates.get(doc_repo_path) ?? null,
      verdict: verdict_of(t, led?.verdict === 'verify' && led.content_hash === hash_content(raws.get(rel)!.raw), !!led),
      last_verified: typeof lv === 'string' ? lv : lv instanceof Date ? lv.toISOString().slice(0, 10) : null,
      refs: [...refs.values()].sort((a, b) => cmp(a.kind, b.kind) || cmp(a.target, b.target)),
      owner_of: [],
      points_to: led?.pointer ? [{ from: null, to: led.pointer.target }] : [],
      duplicates: (t.duplicates ?? []).map((d) => ({ section: `#${d.section}`, owner: `${d.owner}#${d.section}` })).sort((a, b) => cmp(a.owner, b.owner)),
    };
    if (led?.pointer) own_(led.pointer.target.split('#')[0]!, led.pointer.target);
    for (const d of t.duplicates ?? []) own_(d.owner, `${d.owner}#${d.section}`);
  }
  for (const [doc, set] of owners) if (docs[doc]) docs[doc]!.owner_of = [...set].sort(cmp);
  for (const s of Object.values(symbols)) s.cited_by.sort(cmp);

  let head: string | null = null;
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a repo, or no commits */ }
  return { version: GRAPH_VERSION, source_commit: head, docs, symbols };
}

/** Sorted keys at every level, 2-space indent, trailing newline: byte-identical for equal graphs. */
export function serialize_graph(g: GraphV1): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort(cmp).map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sort(g), null, 2) + '\n';
}

export interface WriteGraphResult {
  status: 'disabled' | 'no-git' | 'unchanged' | 'written' | 'would-write';
  file?: string;
  /** True when a new file was created and git does not ignore it (print a hint; never edit .gitignore). */
  hint?: boolean;
}

/** Build and write `<git root>/.hewtd/graph.json`; a byte-identical file is left alone (mtime kept). */
export async function write_graph(opts: { root: string; docs_path: string; config: PluginConfig; dry_run?: boolean }): Promise<WriteGraphResult> {
  if (!opts.config.graph_export) return { status: 'disabled' };
  const top = git_root(opts.docs_path);
  if (!top) return { status: 'no-git' };
  const file = join(top, '.hewtd', 'graph.json');
  const text = serialize_graph(await build_graph(opts));
  assert_no_secrets(text, 'the graph export', opts.config.reconcile.secrets);
  const had = existsSync(file);
  if (had && readFileSync(file, 'utf-8') === text) return { status: 'unchanged', file };
  if (opts.dry_run) return { status: 'would-write', file };
  mkdirSync(join(top, '.hewtd'), { recursive: true });
  writeFileSync(file, text);
  let ignored = true;
  try { execFileSync('git', ['check-ignore', '-q', file], { cwd: top, stdio: 'ignore' }); } catch { ignored = false; }
  return { status: 'written', file, ...(!had && !ignored && { hint: true }) };
}
