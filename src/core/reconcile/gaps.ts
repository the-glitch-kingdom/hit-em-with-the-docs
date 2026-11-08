/**
 * Search gaps (#66): reader for the `gaps.v1` file (schemas/gaps.v1.schema.json, docs/gaps-format.md).
 * Accepts the v1 object, a bare array of gap objects, a JSON array of strings, or one question per line.
 */
import { existsSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';

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

/** Resolve a docs-relative, vault-relative or absolute path to a docs-relative one; null when it is not a live doc. */
export function normalizeUsedDoc(p: string, ctx: GapsContext): string | null {
  const repo = ctx.repoRoot ?? resolve(ctx.docsRoot, '..');
  const candidates = isAbsolute(p) ? [p] : [join(ctx.docsRoot, p), join(repo, p)];
  for (const c of candidates) {
    const rel = relative(ctx.docsRoot, resolve(c));
    if (rel.startsWith('..') || isAbsolute(rel) || !rel) continue;
    if (existsSync(c) && statSync(c).isFile()) return rel.split('\\').join('/');
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
