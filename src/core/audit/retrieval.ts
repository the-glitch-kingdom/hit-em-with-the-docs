/**
 * Retrieval-readiness checks (#50). Advisory only: every issue is a warning and
 * carries no `code`, so neither the exit code nor `audit --strict` changes.
 *
 * Per-doc rules and the corpus-level GENERIC_TITLE pass live here together so a
 * corpus check (RETRIEVAL_NEAR_DUPLICATE, reserved) can be added beside them.
 */

import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { basename, relative } from 'path';
import { parse_frontmatter } from '../../utils/frontmatter.js';
import type { RetrievalConfig } from '../../utils/config.js';
import { KB_ERROR_CODES } from '../metadata/errors.js';
import type { AuditIssue } from './auditor.js';

const error_codes = KB_ERROR_CODES;
const SKIP_DIRS = new Set(['drafts', 'reports', 'archive']);
const GENERATED_NAMES = new Set(['INDEX.md', 'REGISTRY.md']);
const RUNBOOK_RE = /runbook|troubleshoot/i;
const MIGRATE_CMD = '`hewtd fix-retrieval-fields --apply`';

export interface RetrievalDoc {
  /** Path relative to the docs root. */
  doc_path: string;
  data: Record<string, unknown>;
  body: string;
}

export interface RetrievalCoverage {
  total: number;
  withPurpose: number;
  withSymptoms: number;
  withUniqueTitle: number;
}

/** Read the docs the retrieval rules apply to (generated/skipped ones are dropped later). */
export async function load_retrieval_docs(docs_root: string, files: string[]): Promise<RetrievalDoc[]> {
  const docs: RetrievalDoc[] = [];
  for (const file of files) {
    try {
      const { data, content } = parse_frontmatter<Record<string, unknown>>(await readFile(file, 'utf-8'));
      docs.push({ doc_path: relative(docs_root, file), data, body: content });
    } catch {
      // unreadable files are reported by the per-file audit
    }
  }
  return docs;
}

function is_exempt(doc: RetrievalDoc): boolean {
  if (doc.data.generated === true || GENERATED_NAMES.has(basename(doc.doc_path))) return true;
  if (doc.data.tier === 'plan') return true;
  return doc.doc_path.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg));
}

/** The paragraph normalisation behind the near-duplicate hash; reconcile's duplicate detection reuses it. */
export const normalize_block = (block: string): string => block.replace(/\s+/g, ' ').trim().toLowerCase();

const normalize_text = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const get_trimmed_string = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const count_words = (text: string): number => (text ? text.split(/\s+/).length : 0);

/** The weak-purpose rule, shared with `fix-retrieval-fields`. Expects a non-empty value. */
export function is_weak_purpose(value: string, title: string, config: RetrievalConfig): boolean {
  const normalized_value = normalize_text(value);
  const token = normalize_text(title);
  const echoes = token !== '' && normalized_value.startsWith(token) && count_words(normalized_value) <= count_words(token) + 2;
  return echoes || count_words(normalized_value) < config.purpose_min_words || normalized_value.startsWith('documentation for ');
}

function check_purpose(doc: RetrievalDoc, config: RetrievalConfig): 'missing' | 'weak' | null {
  const purpose = get_trimmed_string(doc.data.purpose);
  if (!purpose) return 'missing';
  return is_weak_purpose(purpose, get_trimmed_string(doc.data.title), config) ? 'weak' : null;
}

function is_symptoms_needed(doc: RetrievalDoc): boolean {
  const domains = [doc.doc_path.split(/[\\/]/)[0], ...(Array.isArray(doc.data.domains) ? doc.data.domains : [])];
  return (
    doc.data.tier === 'fact' ||
    domains.some((domain) => domain === 'troubleshooting' || domain === 'procedures') ||
    RUNBOOK_RE.test(basename(doc.doc_path)) ||
    RUNBOOK_RE.test(get_trimmed_string(doc.data.title))
  );
}

const has_symptoms = (doc: RetrievalDoc): boolean => Array.isArray(doc.data.symptoms) && doc.data.symptoms.length > 0;

function count_titles(docs: RetrievalDoc[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const doc of docs) {
    const token = normalize_text(get_trimmed_string(doc.data.title));
    if (token) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/** Coverage counts for the health report. Generated and skipped docs are excluded. */
export function compute_retrieval_coverage(all_docs: RetrievalDoc[], config: RetrievalConfig): RetrievalCoverage {
  const docs = all_docs.filter((doc) => !is_exempt(doc));
  const counts = count_titles(docs);
  return {
    total: docs.length,
    withPurpose: docs.filter((doc) => check_purpose(doc, config) === null).length,
    withSymptoms: docs.filter(has_symptoms).length,
    withUniqueTitle: docs.filter((doc) => {
      const token = normalize_text(get_trimmed_string(doc.data.title));
      return token !== '' && counts.get(token) === 1;
    }).length,
  };
}

interface DuplicatePair {
  a: RetrievalDoc;
  b: RetrievalDoc;
  shared: number;
  snippet: string;
}

/**
 * Doc pairs sharing an identical normalised paragraph of >= minChars. One hash map pass,
 * no pairwise body compare. shortcut: paragraph blocks only, so a passage straddling a
 * blank line is missed; switch to rolling-hash shingles if users report misses.
 */
function find_near_duplicates(docs: RetrievalDoc[], min_chars: number): DuplicatePair[] {
  const by_hash = new Map<string, { docs: Set<number>; snippet: string }>();
  docs.forEach((doc, i) => {
    for (const block of doc.body.split(/\n\s*\n/)) {
      const text = normalize_block(block);
      if (text.length < min_chars) continue;
      const heading = createHash('sha1').update(text).digest('hex');
      const entry = by_hash.get(heading) ?? { docs: new Set<number>(), snippet: text.slice(0, 80) };
      entry.docs.add(i);
      by_hash.set(heading, entry);
    }
  });
  const pairs = new Map<string, DuplicatePair>();
  for (const { docs: set, snippet } of by_hash.values()) {
    const ids = [...set].sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}:${ids[j]}`;
        const pair = pairs.get(key);
        if (pair) pair.shared++;
        else pairs.set(key, { a: docs[ids[i]!]!, b: docs[ids[j]!]!, shared: 1, snippet });
      }
    }
  }
  return [...pairs.values()];
}

export function check_retrieval(all_docs: RetrievalDoc[], config: RetrievalConfig): AuditIssue[] {
  const docs = all_docs.filter((doc) => !is_exempt(doc));
  const issues: AuditIssue[] = [];
  const add_warning = (doc: RetrievalDoc, code: string, message: string, suggestion: string): void => {
    if (config.disabled.includes(code)) return;
    issues.push({ file: doc.doc_path, rule: code, severity: 'warning', message, fixable: false, suggestion });
  };

  const counts = count_titles(docs);
  const denied = new Set(config.generic_titles.map(normalize_text));

  for (const doc of docs) {
    const problem = check_purpose(doc, config);
    if (problem === 'missing') {
      const legacy = get_trimmed_string(doc.data.summary) ? 'summary' : get_trimmed_string(doc.data.description) ? 'description' : '';
      add_warning(
        doc,
        error_codes.RETRIEVAL_MISSING_PURPOSE,
        legacy ? `No purpose, but it has a ${legacy}` : 'No purpose: search tools have nothing to match intent against',
        legacy
          ? `Run ${MIGRATE_CMD} to copy ${legacy} into purpose (dry run without --apply)`
          : 'Add a one-sentence `purpose:` saying when to read this doc'
      );
    } else if (problem === 'weak') {
      add_warning(
        doc,
        error_codes.RETRIEVAL_WEAK_PURPOSE,
        'Purpose echoes the title, is under ' + config.purpose_min_words + ' words, or is a "Documentation for" placeholder',
        'Rewrite `purpose:` as a sentence about what question this doc answers'
      );
    }

    const token = normalize_text(get_trimmed_string(doc.data.title));
    if (token && (denied.has(token) || (counts.get(token) ?? 0) > 1)) {
      add_warning(
        doc,
        error_codes.RETRIEVAL_GENERIC_TITLE,
        denied.has(token) ? `Title "${get_trimmed_string(doc.data.title)}" is generic` : `Title "${get_trimmed_string(doc.data.title)}" is shared by ${counts.get(token)} docs`,
        'Give the doc a title that names its specific subject'
      );
    }

    if (is_symptoms_needed(doc) && !has_symptoms(doc)) {
      add_warning(
        doc,
        error_codes.RETRIEVAL_MISSING_SYMPTOMS,
        'Troubleshooting/runbook doc has no symptoms',
        'Add `symptoms:` with the phrases a user would search when hitting this problem'
      );
    }

    // shortcut: counts "## " lines inside code fences too; upgrade if fenced shell comments cause noise.
    const h2 = (doc.body.match(/^## /gm) ?? []).length;
    if (doc.body.length > config.oversized_chars || h2 > config.oversized_headings) {
      add_warning(
        doc,
        error_codes.RETRIEVAL_OVERSIZED,
        `Body is ${doc.body.length} chars with ${h2} H2 sections`,
        'Split into self-contained docs, one topic each'
      );
    }
  }

  if (config.near_duplicate) {
    for (const pair of find_near_duplicates(docs, config.near_duplicate_min_chars)) {
      add_warning(
        pair.b,
        error_codes.RETRIEVAL_NEAR_DUPLICATE,
        `Shares ${pair.shared} passage(s) of ${config.near_duplicate_min_chars}+ chars with ${pair.a.doc_path}: "${pair.snippet}..."`,
        `Merge into one doc or archive one of ${pair.a.doc_path} and ${pair.b.doc_path}`
      );
    }
  }
  return issues;
}
