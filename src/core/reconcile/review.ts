/**
 * Reconcile review files (#54): markdown, one accept checkbox and one fenced
 * JSON block per doc. Agents (or the slash command) write them; only
 * `reconcile --apply` reads them back and touches the docs tree.
 */
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import matter from 'gray-matter';
import { hash_content } from './ledger.js';
import { assert_no_secrets, find_secrets, type RawSecret } from './secrets.js';
import { load_plugin_config } from '../../utils/config.js';
import type { Shard, TriageResult } from './triage.js';

export const VERDICTS = ['verify', 'rewrite', 'archive', 'unverifiable', 'fields', 'integrate', 'delete', 'secret', 'merge', 'point', 'overview', 'phrases'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ReviewEntry {
  /** Docs-relative posix path. */
  path: string;
  /** Hash of the doc when the review was written; apply skips the entry if it changed. */
  content_hash: string;
  /** null = not yet judged; never applied. */
  verdict: Verdict | null;
  /** Frontmatter keys to set (purpose, symptoms, ...). Never last_verified. */
  frontmatter?: Record<string, unknown>;
  /** Exact-text body edits; each `old` must occur exactly once. */
  patch?: { old: string; new: string }[];
  /** rewrite: full proposed body, written under the drafts dir. */
  draft?: string;
  /** Files the agent actually read; written to `sources` as listed. */
  sources?: string[];
  /** archive: reason stamped on the doc. */
  reason?: string;
  /** Outside-tree entry: `path` is project-root-relative; verdicts are integrate | delete. */
  outside?: boolean;
  /** integrate: target domain (default: declared or detected). */
  domain?: string;
  /** secret: masked findings with the proposed env name each value moves to. Never the value. */
  secrets?: { rule: string; line: number; masked: string; fingerprint: string; env: string }[];
  /** merge/point: id other entries may name in `depends_on_merge` (default: the path). */
  id?: string;
  /** merge: anchor of the owner section the patch folds copy-only content into. */
  section?: string;
  /** point: the copied text (exactly once in the doc) that becomes a one-line pointer. */
  remove?: { old: string };
  /** point: one-line summary plus the owner's section, `docs-relative/owner.md#anchor` (a sibling repo's doc may sit outside the docs tree: cross-link only). */
  pointer?: { summary: string; target: string };
  /** point: id (or path) of a merge entry applied first in the same batch. */
  depends_on_merge?: string;
  /** point without depends_on_merge: hash of the owner doc when the review was written. */
  target_hash?: string;
  /** overview: the reconciled docs the overview points at, with the hash each had when it was drafted. `path` is the new overview, `draft` its body, `frontmatter` its fields. */
  members?: { path: string; content_hash: string }[];
  /** overview: allow members that are not reconciled; the draft must mark each link `(unreviewed)`. */
  allow_unreviewed?: boolean;
  /** phrases: search-gap queries to add to the doc's symptoms as user_phrase. */
  phrases?: string[];
  lane?: string;
  reasons?: string[];
}

export interface ReviewFile {
  /** Path as given (used as the ledger's review_file). */
  file: string;
  batch: string;
  shard: number;
  scope: string;
  entries: { entry: ReviewEntry; accepted: boolean }[];
}

/** HEWTD_SECRET_<NAME>: the assignment name on the value's line, else rule + doc slug; unique within `used`. */
export function env_names(text: string, doc: string, raws: RawSecret[], used: Set<string>): Map<string, string> {
  const lines = text.split('\n');
  const slug = doc.replace(/\.md$/, '');
  const out = new Map<string, string>();
  for (const { finding: f } of raws) {
    if (out.has(f.fingerprint)) continue; // same value twice: one name
    const before = (lines[f.line - 1] ?? '').slice(0, f.col - 1);
    const base = /([A-Za-z_][\w.-]*)["'`]?\s*[:=]\s*["'`]?$/.exec(before)?.[1] ?? `${f.rule}_${slug}`;
    const stem = `HEWTD_SECRET_${base.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()}`;
    let name = stem;
    for (let i = 2; used.has(name); i++) name = `${stem}_${i}`;
    used.add(name);
    out.set(f.fingerprint, name);
  }
  return out;
}

export const review_dir = (root: string): string => join(root, '.hewtd', 'reconcile');

export function render_review(meta: { batch: string; shard: number; scope: string }, entries: ReviewEntry[]): string {
  const body = entries
    .map((e) => `## ${e.path}\n\n- [ ] accept\n\n\`\`\`json\n${JSON.stringify(e, null, 2)}\n\`\`\`\n`)
    .join('\n');
  const out = matter.stringify(
    `\n# Reconcile review, batch ${meta.batch} shard ${meta.shard}\n\nSet "verdict" (${VERDICTS.join(' | ')}), fill the fields, tick "accept" on entries to apply.\n\n${body}`,
    meta
  );
  assert_no_secrets(out, `review batch ${meta.batch} shard ${meta.shard}`);
  return out;
}

export async function parse_review(file: string): Promise<ReviewFile> {
  const { data, content } = matter(await readFile(file, 'utf-8'));
  const entries: ReviewFile['entries'] = [];
  for (const sec of content.split(/^## /m).slice(1)) {
    const json = /```json\n([\s\S]*?)\n```/.exec(sec)?.[1];
    if (!json) continue;
    let entry: ReviewEntry;
    try {
      entry = JSON.parse(json);
    } catch {
      throw new Error(`${file}: invalid JSON block under "${sec.split('\n')[0]}"`);
    }
    if (!entry.path || !entry.content_hash) throw new Error(`${file}: entry without path/content_hash`);
    if (entry.verdict !== null && !VERDICTS.includes(entry.verdict as Verdict)) {
      throw new Error(`${file}: ${entry.path}: unknown verdict "${entry.verdict}"`);
    }
    entries.push({ entry, accepted: /^- \[[xX]\] accept/m.test(sec) });
  }
  return { file, batch: String(data.batch ?? ''), shard: Number(data.shard ?? 1), scope: String(data.scope ?? ''), entries };
}

export async function next_batch(dir: string): Promise<string> {
  let max = 0;
  try {
    for (const f of await readdir(dir)) max = Math.max(max, parseInt(/^review-(\d+)-/.exec(f)?.[1] ?? '0', 10));
  } catch {
    /* no dir yet */
  }
  return String(max + 1);
}

/** Turn a triage result into one empty review file per shard (one file in serial mode). */
export async function write_review_skeletons(opts: {
  root: string;
  docs_path: string;
  triage: TriageResult;
  scope: string;
  batch?: string;
}): Promise<string[]> {
  const { root, docs_path, triage, scope } = opts;
  const dir = review_dir(root);
  const batch = opts.batch ?? (await next_batch(dir));
  const judged = triage.docs.filter((d) => d.lane !== 'clean');
  const by_path = new Map(judged.map((d) => [d.path, d]));
  // Shards hold only fields-only/check docs; archive candidates (and serial mode) ride in shard 1.
  const placed = new Set(triage.shards.flatMap((s) => s.docs));
  // Secret-lane docs never ride in a judgment shard's file: they get their own review file (id 0,
  // `review-<batch>-secrets.md`) that is handled before judgment and never handed to an agent.
  const extra = judged.filter((d) => !placed.has(d.path) && d.lane !== 'secret').map((d) => d.path);
  const secret_docs = judged.filter((d) => d.lane === 'secret').map((d) => d.path);
  const shards: Shard[] = triage.shards.length ? triage.shards.map((s) => ({ ...s })) : [{ id: 1, docs: [], bytes: 0 }];
  shards[0]!.docs = [...shards[0]!.docs, ...extra];
  if (secret_docs.length) shards.unshift({ id: 0, docs: secret_docs, bytes: 0 });
  const written: string[] = [];
  const secrets_cfg = (await load_plugin_config(root)).reconcile.secrets;
  const used_env = new Set<string>();
  for (const s of shards) {
    const entries: ReviewEntry[] = [];
    for (const p of s.docs) {
      const d = by_path.get(p);
      const text = await readFile(join(docs_path, p), 'utf-8');
      let secrets: ReviewEntry['secrets'];
      if (d?.lane === 'secret') {
        const raws = find_secrets(text, p, secrets_cfg).filter((r) => r.finding.kind === 'secret');
        const names = env_names(text, p, raws, used_env);
        if (raws.length) secrets = raws.map(({ finding: f }) => ({ rule: f.rule, line: f.line, masked: f.masked, fingerprint: f.fingerprint, env: names.get(f.fingerprint)! }));
      }
      entries.push({
        path: p,
        content_hash: hash_content(text),
        verdict: secrets ? 'secret' : null,
        ...(secrets && { secrets }),
        ...(d && { lane: d.lane, reasons: d.reasons }),
      });
    }
    if (!entries.length) continue;
    const file = join(dir, `review-${batch}-${s.id === 0 ? 'secrets' : s.id}.md`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, render_review({ batch, shard: s.id, scope }, entries), { encoding: 'utf-8', flag: 'wx' });
    written.push(file);
  }
  return written;
}

/** gaps: one unticked `phrases` entry per doc with proposals, as `review-<batch>-gaps.md`. */
export async function write_gaps_review(opts: { root: string; docs_path: string; proposals: { doc: string; accepted: { query: string }[] }[]; batch?: string }): Promise<string | undefined> {
  const { root, docs_path, proposals } = opts;
  if (!proposals.length) return undefined;
  const dir = review_dir(root);
  const batch = opts.batch ?? (await next_batch(dir));
  const entries: ReviewEntry[] = [];
  for (const p of proposals) {
    entries.push({ path: p.doc, content_hash: hash_content(await readFile(join(docs_path, p.doc), 'utf-8')), verdict: 'phrases', phrases: p.accepted.map((a) => a.query) });
  }
  const file = join(dir, `review-${batch}-gaps.md`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, render_review({ batch, shard: 1, scope: 'gaps' }, entries), { encoding: 'utf-8', flag: 'wx' });
  return file;
}
