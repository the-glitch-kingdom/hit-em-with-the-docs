/**
 * Build the `.hewtd/graph.json` v1 object (#65) from the reconcile resolver, ledger,
 * duplicates and git dates. Read-only on the docs tree; deterministic for an unchanged tree.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import type { PluginConfig } from '../../utils/config.js';
import { parseFrontmatter } from '../../utils/frontmatter.js';
import { hashContent, loadLedger } from '../reconcile/ledger.js';
import { assertNoSecrets } from '../reconcile/secrets.js';
import { gitRoot, mdFiles, resolveDocs, STALE_COMMITS_BAR, type TriageDoc } from '../reconcile/triage.js';
import { bodyChangedDates, lastChanged } from './dates.js';
import { GRAPH_VERSION, type GraphDoc, type GraphRef, type GraphRefKind, type GraphSymbol, type GraphV1, type GraphVerdict } from './schema.js';

const posix = (p: string): string => p.split('\\').join('/');
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const KIND: Record<string, GraphRefKind> = { path: 'file', 'doc-link': 'doc' };

function verdictOf(d: TriageDoc, ledgerVerified: boolean): GraphVerdict {
  if (d.lane === 'secret') return 'secret';
  if (d.lane === 'archive-candidate') return 'archive-candidate';
  // a pointer or overview member that changed drops the verdict, as in triage
  if (ledgerVerified && !d.reasons.some((r) => /^(member changed|pointer target changed)/.test(r))) return 'verified';
  if (d.lane === 'clean') return 'verified';
  if (d.lane === 'fields-only') return 'fields-only';
  const onlyStale = d.reasons.length > 0 && d.reasons.every((r) => /commits to cited files/.test(r)) && (d.staleCommits ?? 0) >= STALE_COMMITS_BAR;
  return onlyStale ? 'stale' : 'check';
}

export async function buildGraph(opts: { root: string; docsPath: string; config: PluginConfig }): Promise<GraphV1> {
  const { root, docsPath, config } = opts;
  const repo = gitRoot(docsPath) ?? root;
  const rels = (await mdFiles(docsPath)).map((f) => posix(relative(docsPath, f))).filter((r) => !r.startsWith('drafts/') && !r.includes('/drafts/')).sort(cmp);
  const raws = new Map<string, { raw: string; data: Record<string, unknown> }>();
  for (const r of rels) {
    const raw = readFileSync(join(docsPath, r), 'utf-8');
    const { data } = parseFrontmatter<Record<string, unknown>>(raw);
    if (data.generated === true || data.tier === 'plan') continue;
    raws.set(r, { raw, data });
  }
  const kept = [...raws.keys()];
  const triaged = new Map((await resolveDocs({ root, docsPath, rels: kept, config })).map((d) => [d.path, d]));
  const ledger = await loadLedger(resolve(root, config.reconcile.ledger_path));
  const body = bodyChangedDates(repo, kept.map((r) => ({ path: posix(relative(repo, join(docsPath, r))), content: raws.get(r)!.raw })));

  const own = lastChanged(repo);
  const sibs = new Map(config.reconcile.related_repos.map((r) => [r.name, lastChanged(resolve(root, r.path))]));
  const dateOf = (where: string): { repo?: string; file: string; date?: string | undefined } => {
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
        const w = dateOf(r.where);
        if (r.kind !== 'path') ref.file = w.file;
        if (w.repo) ref.repo = w.repo;
        if (w.date) ref.code_changed = w.date;
        if (r.kind === 'symbol') {
          const s = (symbols[r.ref] ??= { file: w.file, cited_by: [] });
          if (!s.cited_by.includes(rel)) s.cited_by.push(rel);
        }
      }
      refs.set(`${kind}\0${r.ref}`, ref);
    }
    // gone frontmatter `sources` are in triage's `missing` but not in its refs
    for (const m of t.missing) if (![...refs.values()].some((x) => x.target === m && x.resolved === false)) refs.set(`file\0${m}`, { kind: 'file', target: m, resolved: false });

    const lv = raws.get(rel)!.data.last_verified;
    const docRepoPath = posix(relative(repo, join(docsPath, rel)));
    docs[rel] = {
      body_changed: body.dates.get(docRepoPath) ?? null,
      verdict: verdictOf(t, led?.verdict === 'verify' && led.content_hash === hashContent(raws.get(rel)!.raw)),
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
export function serializeGraph(g: GraphV1): string {
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
export async function writeGraph(opts: { root: string; docsPath: string; config: PluginConfig; dryRun?: boolean }): Promise<WriteGraphResult> {
  if (!opts.config.graph_export) return { status: 'disabled' };
  const top = gitRoot(opts.docsPath);
  if (!top) return { status: 'no-git' };
  const file = join(top, '.hewtd', 'graph.json');
  const text = serializeGraph(await buildGraph(opts));
  assertNoSecrets(text, 'the graph export', opts.config.reconcile.secrets);
  const had = existsSync(file);
  if (had && readFileSync(file, 'utf-8') === text) return { status: 'unchanged', file };
  if (opts.dryRun) return { status: 'would-write', file };
  mkdirSync(join(top, '.hewtd'), { recursive: true });
  writeFileSync(file, text);
  let ignored = true;
  try { execFileSync('git', ['check-ignore', '-q', file], { cwd: top, stdio: 'ignore' }); } catch { ignored = false; }
  return { status: 'written', file, ...(!had && !ignored && { hint: true }) };
}
