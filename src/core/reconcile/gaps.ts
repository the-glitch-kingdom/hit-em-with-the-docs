/**
 * Search gaps (#66): reader for the `gaps.v1` file (schemas/gaps.v1.schema.json, docs/gaps-format.md).
 * Accepts the v1 object, a bare array of gap objects, a JSON array of strings, or one question per line.
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { isAbsolute, join, relative, resolve } from 'path';
import { parse_frontmatter } from '../../utils/frontmatter.js';
import { find_markdown_files } from '../../utils/glob.js';
import type { PluginConfig } from '../../utils/config.js';
import { load_cited_sources } from '../integrate/integrator.js';
import { build_phrases, type DroppedPhrase, type PhraseInput } from './phrases.js';
import { scan_text } from './secrets.js';

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
  docs_root: string;
  /** Repo root, for vault-relative paths like `.documentation/ops/x.md`. Defaults to the docs root's parent. */
  repo_root?: string;
}

/** Resolve a docs-relative, vault-relative or absolute path to a docs-relative one; null when it is not a live doc
 * (a missing file, outside the docs root, not markdown, or `generated: true` such as INDEX.md). */
export function normalize_used_doc(path_text: string, context: GapsContext): string | null {
  const repo_root = context.repo_root ?? resolve(context.docs_root, '..');
  const candidates = isAbsolute(path_text) ? [path_text] : [join(context.docs_root, path_text), join(repo_root, path_text)];
  for (const candidate of candidates) {
    const doc_path = relative(context.docs_root, resolve(candidate));
    if (doc_path.startsWith('..') || isAbsolute(doc_path) || !doc_path) continue;
    if (!candidate.endsWith('.md') || !existsSync(candidate) || !statSync(candidate).isFile()) continue;
    if (parse_frontmatter<Record<string, unknown>>(readFileSync(candidate, 'utf-8')).data.generated === true) continue;
    return doc_path.split('\\').join('/');
  }
  return null;
}

/** Whitespace collapsed, trailing punctuation dropped; the reader's wording is kept. */
const normalize_query = (query: string): string => query.replace(/\s+/g, ' ').trim().replace(/[\s.?!,;:]+$/, '');

export function parse_gaps(text: string, context: GapsContext): GapsRead {
  const read: GapsRead = { gaps: [], errors: [] };
  let items: unknown[];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (json === undefined) {
    // hand-written: one question per line, blank lines and # comments skipped
    items = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  } else if (Array.isArray(json)) {
    items = json;
  } else if (json && typeof json === 'object') {
    const gaps_file = json as Record<string, unknown>;
    if (gaps_file.version !== GAPS_VERSION) {
      throw new Error(`Unsupported gaps file version ${JSON.stringify(gaps_file.version)}; this hewtd reads gaps.v1 (version: ${GAPS_VERSION}).`);
    }
    if (!Array.isArray(gaps_file.gaps)) throw new Error('Invalid gaps file: "gaps" must be an array.');
    if (typeof gaps_file.source === 'string') read.source = gaps_file.source;
    items = gaps_file.gaps;
  } else {
    throw new Error('Invalid gaps file: expected an object, an array, or one question per line.');
  }

  items.forEach((entry, i) => {
    const raw_gap = typeof entry === 'string' ? { query: entry } : entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
    if (!raw_gap || typeof raw_gap.query !== 'string' || !normalize_query(raw_gap.query)) return void read.errors.push(`gaps[${i}]: needs a non-empty "query" string`);
    const gap: Gap = { query: normalize_query(raw_gap.query), used_doc: null };
    if (raw_gap.used_doc != null) {
      if (typeof raw_gap.used_doc !== 'string') return void read.errors.push(`gaps[${i}]: "used_doc" must be a string or null`);
      gap.used_doc = normalize_used_doc(raw_gap.used_doc, context);
      if (!gap.used_doc) read.errors.push(`gaps[${i}]: used_doc "${raw_gap.used_doc}" is not a doc under the docs root; treated as no doc`);
    }
    if (raw_gap.suggested !== undefined) {
      if (raw_gap.suggested !== 'symptoms.user_phrase' && raw_gap.suggested !== 'new doc') return void read.errors.push(`gaps[${i}]: "suggested" must be "symptoms.user_phrase" or "new doc"`);
      gap.suggested = raw_gap.suggested;
    }
    if (raw_gap.count !== undefined) {
      if (!Number.isInteger(raw_gap.count) || (raw_gap.count as number) < 1) return void read.errors.push(`gaps[${i}]: "count" must be an integer >= 1`);
      gap.count = raw_gap.count as number;
    }
    if (raw_gap.last_seen !== undefined) {
      if (typeof raw_gap.last_seen !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw_gap.last_seen)) return void read.errors.push(`gaps[${i}]: "last_seen" must be YYYY-MM-DD`);
      gap.last_seen = raw_gap.last_seen;
    }
    read.gaps.push(gap);
  });
  return read;
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

const normalize_list = (value: unknown): string[] => (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === 'string');

/** Current symptom text of a doc: plain symptoms plus playbook `user_phrase` values. */
export function extract_symptom_text(data: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const text of Array.isArray(data.symptoms) ? data.symptoms : []) {
    if (typeof text === 'string') found.push(text);
    else if (text && typeof text === 'object') found.push(...normalize_list((text as Record<string, unknown>).user_phrase ?? []));
  }
  return found;
}

/** Bare identifier/path-like tokens of a query, wrapped in backticks so `extractReferences` sees them. */
const extract_identifier_body = (query: string): string =>
  (query.match(/[\w$./-]+(?:\(\))?/g) ?? []).filter((token) => /[a-z][A-Z]|_|\/|\.[A-Za-z]{1,5}$|\(\)$/.test(token.replace(/\.$/, ''))).map((token) => `\`${token.replace(/\.$/, '')}\``).join(' ');

/** Every gap lands in exactly one outcome. Read-only: nothing in the docs tree changes. */
export async function classify_gaps(gaps: Gap[], options: { root: string; docs_root: string; config: PluginConfig }): Promise<GapsClassification> {
  const { root: repo_root, docs_root, config } = options;
  const secrets = config.reconcile.secrets;
  const classification: GapsClassification = { proposals: [], candidates: [], questions: [], dropped: [] };

  // same query (case-insensitive) across entries: counts add up
  const merged = new Map<string, { query: string; count: number; doc: string | null }>();
  for (const gap of gaps) {
    const finding = scan_text(gap.query, 'gaps', secrets)[0];
    if (finding) { classification.dropped.push({ query: '[redacted]', reason: 'secret', note: `${finding.rule}, ${finding.masked}` }); continue; }
    const key = `${gap.used_doc ?? ''}\0${gap.query.toLowerCase()}`;
    const merged_gap = merged.get(key);
    if (merged_gap) merged_gap.count += gap.count ?? 1;
    else merged.set(key, { query: gap.query, count: gap.count ?? 1, doc: gap.used_doc });
  }

  // docs that can take a phrase: live (not archived) and free of secrets
  const doc_state = new Map<string, { ok: boolean; existing: string[] }>();
  const load_doc_info = async (doc_path: string): Promise<{ ok: boolean; existing: string[] }> => {
    let state = doc_state.get(doc_path);
    if (!state) {
      const raw_text = await readFile(join(docs_root, doc_path), 'utf-8');
      const ok = !/^archive\//.test(doc_path) && !scan_text(raw_text, doc_path, secrets).length;
      state = { ok, existing: ok ? extract_symptom_text(parse_frontmatter(raw_text).data) : [] };
      doc_state.set(doc_path, state);
    }
    return state;
  };

  const by_doc = new Map<string, PhraseInput[]>();
  const rest: Array<{ query: string; count: number }> = [];
  for (const gap of merged.values()) {
    if (gap.doc && (await load_doc_info(gap.doc)).ok) by_doc.set(gap.doc, [...(by_doc.get(gap.doc) ?? []), { query: gap.query, count: gap.count }]);
    else rest.push(gap);
  }
  for (const [doc, inputs] of [...by_doc].sort((a, b) => a[0].localeCompare(b[0]))) {
    const { existing } = await load_doc_info(doc);
    const phrases = build_phrases(inputs, existing, secrets, config.reconcile.gaps.max_phrases_per_doc);
    classification.dropped.push(...phrases.dropped);
    if (phrases.accepted.length) classification.proposals.push({ doc, accepted: phrases.accepted, existing });
  }

  let owners: Map<string, string> | undefined; // source file -> top-level domain folder of the first doc citing it
  const find_owner = async (file: string): Promise<string | undefined> => {
    if (!owners) {
      owners = new Map();
      for (const markdown_path of await find_markdown_files(docs_root)) {
        const doc_path = relative(docs_root, markdown_path).split('\\').join('/');
        if (doc_path.startsWith('archive/') || !doc_path.includes('/')) continue;
        const source = parse_frontmatter(await readFile(markdown_path, 'utf-8')).data.sources;
        for (const source_entry of Array.isArray(source) ? source : []) {
          const source_path = typeof source_entry === 'string' ? source_entry : (source_entry as { path?: unknown } | null)?.path;
          if (typeof source_path === 'string' && !owners.has(source_path)) owners.set(source_path, doc_path.split('/')[0]!);
        }
      }
    }
    return owners.get(file);
  };
  for (const gap of rest) {
    const body = extract_identifier_body(gap.query);
    const cited_list = body ? await load_cited_sources(body, repo_root, config, undefined, true) : [];
    if (!cited_list.length) { classification.questions.push({ query: gap.query, count: gap.count }); continue; }
    const sources = cited_list.map((cited) => cited.path);
    const domain = (await Promise.all(sources.map(find_owner))).find(Boolean);
    classification.candidates.push({ query: gap.query, count: gap.count, sources, ...(domain && { domain }) });
  }
  const compare_by_count = (a: { count: number }, b: { count: number }): number => b.count - a.count;
  classification.candidates.sort(compare_by_count);
  classification.questions.sort(compare_by_count);
  return classification;
}
