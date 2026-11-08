/**
 * Search gaps (#66): reader for the `gaps.v1` file (schemas/gaps.v1.schema.json, docs/gaps-format.md).
 * Accepts the v1 object, a bare array of gap objects, a JSON array of strings, or one question per line.
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { isAbsolute, join, relative, resolve } from 'path';
import { parseFrontmatter } from '../../utils/frontmatter.js';
import { findMarkdownFiles } from '../../utils/glob.js';
import type { PluginConfig } from '../../utils/config.js';
import { citedSources } from '../integrate/integrator.js';
import { buildPhrases, type DroppedPhrase, type PhraseInput } from './phrases.js';
import { scanText } from './secrets.js';

export const GAPS_VERSION = 1;

export interface Gap {
  query: string;
  /** Docs-root-relative posix path of a live doc, or null. */
  used_doc: string | null;
  suggested?: 'symptoms.user_phrase' | 'new doc';
  count?: number;
  last_seen?: string;
}

export interface GapsRead {
  source?: string;
  gaps: Gap[];
  /** Problems found, each naming the entry index (or the file). The remaining entries are kept. */
  errors: string[];
}

export interface GapsContext {
  /** Absolute docs root (e.g. <repo>/.documentation). */
  docsRoot: string;
  /** Repo root, for vault-relative paths like `.documentation/ops/x.md`. Defaults to the docs root's parent. */
  repoRoot?: string;
}

/** Resolve a docs-relative, vault-relative or absolute path to a docs-relative one; null when it is not a live doc
 * (a missing file, outside the docs root, not markdown, or `generated: true` such as INDEX.md). */
export function normalizeUsedDoc(p: string, ctx: GapsContext): string | null {
  const repo = ctx.repoRoot ?? resolve(ctx.docsRoot, '..');
  const candidates = isAbsolute(p) ? [p] : [join(ctx.docsRoot, p), join(repo, p)];
  for (const c of candidates) {
    const rel = relative(ctx.docsRoot, resolve(c));
    if (rel.startsWith('..') || isAbsolute(rel) || !rel) continue;
    if (!c.endsWith('.md') || !existsSync(c) || !statSync(c).isFile()) continue;
    if (parseFrontmatter<Record<string, unknown>>(readFileSync(c, 'utf-8')).data.generated === true) continue;
    return rel.split('\\').join('/');
  }
  return null;
}

/** Whitespace collapsed, trailing punctuation dropped; the reader's wording is kept. */
const cleanQuery = (q: string): string => q.replace(/\s+/g, ' ').trim().replace(/[\s.?!,;:]+$/, '');

export function parseGaps(text: string, ctx: GapsContext): GapsRead {
  const out: GapsRead = { gaps: [], errors: [] };
  let items: unknown[];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    // hand-written: one question per line, blank lines and # comments skipped
    items = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } else if (Array.isArray(json)) {
    items = json;
  } else if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    if (o.version !== GAPS_VERSION) {
      throw new Error(`Unsupported gaps file version ${JSON.stringify(o.version)}; this hewtd reads gaps.v1 (version: ${GAPS_VERSION}).`);
    }
    if (!Array.isArray(o.gaps)) throw new Error('Invalid gaps file: "gaps" must be an array.');
    if (typeof o.source === 'string') out.source = o.source;
    items = o.gaps;
  } else {
    throw new Error('Invalid gaps file: expected an object, an array, or one question per line.');
  }

  items.forEach((it, i) => {
    const o = typeof it === 'string' ? { query: it } : it && typeof it === 'object' && !Array.isArray(it) ? (it as Record<string, unknown>) : null;
    if (!o || typeof o.query !== 'string' || !cleanQuery(o.query)) return void out.errors.push(`gaps[${i}]: needs a non-empty "query" string`);
    const gap: Gap = { query: cleanQuery(o.query), used_doc: null };
    if (o.used_doc != null) {
      if (typeof o.used_doc !== 'string') return void out.errors.push(`gaps[${i}]: "used_doc" must be a string or null`);
      gap.used_doc = normalizeUsedDoc(o.used_doc, ctx);
      if (!gap.used_doc) out.errors.push(`gaps[${i}]: used_doc "${o.used_doc}" is not a doc under the docs root; treated as no doc`);
    }
    if (o.suggested !== undefined) {
      if (o.suggested !== 'symptoms.user_phrase' && o.suggested !== 'new doc') return void out.errors.push(`gaps[${i}]: "suggested" must be "symptoms.user_phrase" or "new doc"`);
      gap.suggested = o.suggested;
    }
    if (o.count !== undefined) {
      if (!Number.isInteger(o.count) || (o.count as number) < 1) return void out.errors.push(`gaps[${i}]: "count" must be an integer >= 1`);
      gap.count = o.count as number;
    }
    if (o.last_seen !== undefined) {
      if (typeof o.last_seen !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.last_seen)) return void out.errors.push(`gaps[${i}]: "last_seen" must be YYYY-MM-DD`);
      gap.last_seen = o.last_seen;
    }
    out.gaps.push(gap);
  });
  return out;
}

// ---------- classification ----------

export interface PhraseProposal { doc: string; accepted: PhraseInput[]; existing: string[] }
export interface NewDocCandidate { query: string; count: number; sources: string[]; domain?: string }
export interface OpenQuestion { query: string; count: number }
export interface GapsClassification {
  proposals: PhraseProposal[];
  candidates: NewDocCandidate[];
  questions: OpenQuestion[];
  dropped: DroppedPhrase[];
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');

/** Current symptom text of a doc: plain symptoms plus playbook `user_phrase` values. */
export function symptomText(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const s of Array.isArray(data.symptoms) ? data.symptoms : []) {
    if (typeof s === 'string') out.push(s);
    else if (s && typeof s === 'object') out.push(...asList((s as Record<string, unknown>).user_phrase ?? []));
  }
  return out;
}

/** Bare identifier/path-like tokens of a query, wrapped in backticks so `extractReferences` sees them. */
const identifierBody = (q: string): string =>
  (q.match(/[\w$./-]+(?:\(\))?/g) ?? []).filter((t) => /[a-z][A-Z]|_|\/|\.[A-Za-z]{1,5}$|\(\)$/.test(t.replace(/\.$/, ''))).map((t) => `\`${t.replace(/\.$/, '')}\``).join(' ');

/** Every gap lands in exactly one outcome. Read-only: nothing in the docs tree changes. */
export async function classifyGaps(gaps: Gap[], opts: { root: string; docsRoot: string; config: PluginConfig }): Promise<GapsClassification> {
  const { root, docsRoot, config } = opts;
  const secrets = config.reconcile.secrets;
  const res: GapsClassification = { proposals: [], candidates: [], questions: [], dropped: [] };

  // same query (case-insensitive) across entries: counts add up
  const merged = new Map<string, { query: string; count: number; doc: string | null }>();
  for (const g of gaps) {
    const hit = scanText(g.query, 'gaps', secrets)[0];
    if (hit) { res.dropped.push({ query: '[redacted]', reason: 'secret', note: `${hit.rule}, ${hit.masked}` }); continue; }
    const k = `${g.used_doc ?? ''}\0${g.query.toLowerCase()}`;
    const m = merged.get(k);
    if (m) m.count += g.count ?? 1;
    else merged.set(k, { query: g.query, count: g.count ?? 1, doc: g.used_doc });
  }

  // docs that can take a phrase: live (not archived) and free of secrets
  const docState = new Map<string, { ok: boolean; existing: string[] }>();
  const docInfo = async (rel: string): Promise<{ ok: boolean; existing: string[] }> => {
    let s = docState.get(rel);
    if (!s) {
      const raw = await readFile(join(docsRoot, rel), 'utf-8');
      const ok = !/^archive\//.test(rel) && !scanText(raw, rel, secrets).length;
      s = { ok, existing: ok ? symptomText(parseFrontmatter(raw).data) : [] };
      docState.set(rel, s);
    }
    return s;
  };

  const byDoc = new Map<string, PhraseInput[]>();
  const rest: Array<{ query: string; count: number }> = [];
  for (const m of merged.values()) {
    if (m.doc && (await docInfo(m.doc)).ok) byDoc.set(m.doc, [...(byDoc.get(m.doc) ?? []), { query: m.query, count: m.count }]);
    else rest.push(m);
  }
  for (const [doc, inputs] of [...byDoc].sort((a, b) => a[0].localeCompare(b[0]))) {
    const { existing } = await docInfo(doc);
    const r = buildPhrases(inputs, existing, secrets, config.reconcile.gaps.max_phrases_per_doc);
    res.dropped.push(...r.dropped);
    if (r.accepted.length) res.proposals.push({ doc, accepted: r.accepted, existing });
  }

  let owners: Map<string, string> | undefined; // source file -> top-level domain folder of the first doc citing it
  const ownerOf = async (file: string): Promise<string | undefined> => {
    if (!owners) {
      owners = new Map();
      for (const f of await findMarkdownFiles(docsRoot)) {
        const rel = relative(docsRoot, f).split('\\').join('/');
        if (rel.startsWith('archive/') || !rel.includes('/')) continue;
        const src = parseFrontmatter(await readFile(f, 'utf-8')).data.sources;
        for (const s of Array.isArray(src) ? src : []) {
          const p = typeof s === 'string' ? s : (s as { path?: unknown } | null)?.path;
          if (typeof p === 'string' && !owners.has(p)) owners.set(p, rel.split('/')[0]!);
        }
      }
    }
    return owners.get(file);
  };
  for (const g of rest) {
    const body = identifierBody(g.query);
    const found = body ? await citedSources(body, root, config, undefined, true) : [];
    if (!found.length) { res.questions.push({ query: g.query, count: g.count }); continue; }
    const sources = found.map((s) => s.path);
    const domain = (await Promise.all(sources.map(ownerOf))).find(Boolean);
    res.candidates.push({ query: g.query, count: g.count, sources, ...(domain && { domain }) });
  }
  const byCount = (a: { count: number }, b: { count: number }): number => b.count - a.count;
  res.candidates.sort(byCount);
  res.questions.sort(byCount);
  return res;
}
