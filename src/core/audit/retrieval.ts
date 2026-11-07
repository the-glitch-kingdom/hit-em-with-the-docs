/**
 * Retrieval-readiness checks (#50). Advisory only: every issue is a warning and
 * carries no `code`, so neither the exit code nor `audit --strict` changes.
 *
 * Per-doc rules and the corpus-level GENERIC_TITLE pass live here together so a
 * corpus check (RETRIEVAL_NEAR_DUPLICATE, reserved) can be added beside them.
 */

import { readFile } from 'fs/promises';
import { basename, relative } from 'path';
import { parseFrontmatter } from '../../utils/frontmatter.js';
import type { RetrievalConfig } from '../../utils/config.js';
import { KB_ERROR_CODES } from '../metadata/errors.js';
import type { AuditIssue } from './auditor.js';

const R = KB_ERROR_CODES;
const SKIP_DIRS = new Set(['drafts', 'reports', 'archive']);
const GENERATED_NAMES = new Set(['INDEX.md', 'REGISTRY.md']);
const RUNBOOK_RE = /runbook|troubleshoot/i;
const MIGRATE_CMD = '`hewtd fix-retrieval-fields --apply`';

export interface RetrievalDoc {
  /** Path relative to the docs root. */
  rel: string;
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
export async function collectRetrievalDocs(docsPath: string, files: string[]): Promise<RetrievalDoc[]> {
  const docs: RetrievalDoc[] = [];
  for (const file of files) {
    try {
      const { data, content } = parseFrontmatter<Record<string, unknown>>(await readFile(file, 'utf-8'));
      docs.push({ rel: relative(docsPath, file), data, body: content });
    } catch {
      // unreadable files are reported by the per-file audit
    }
  }
  return docs;
}

function isExempt(d: RetrievalDoc): boolean {
  if (d.data.generated === true || GENERATED_NAMES.has(basename(d.rel))) return true;
  if (d.data.tier === 'plan') return true;
  return d.rel.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg));
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const wordCount = (s: string): number => (s ? s.split(/\s+/).length : 0);

function purposeProblem(d: RetrievalDoc, cfg: RetrievalConfig): 'missing' | 'weak' | null {
  const purpose = str(d.data.purpose);
  if (!purpose) return 'missing';
  const p = norm(purpose);
  const t = norm(str(d.data.title));
  const echoes = t !== '' && p.startsWith(t) && wordCount(p) <= wordCount(t) + 2;
  return echoes || wordCount(p) < cfg.purpose_min_words || p.startsWith('documentation for ') ? 'weak' : null;
}

function needsSymptoms(d: RetrievalDoc): boolean {
  const domains = [d.rel.split(/[\\/]/)[0], ...(Array.isArray(d.data.domains) ? d.data.domains : [])];
  return (
    d.data.tier === 'fact' ||
    domains.some((x) => x === 'troubleshooting' || x === 'procedures') ||
    RUNBOOK_RE.test(basename(d.rel)) ||
    RUNBOOK_RE.test(str(d.data.title))
  );
}

const hasSymptoms = (d: RetrievalDoc): boolean => Array.isArray(d.data.symptoms) && d.data.symptoms.length > 0;

function titleCounts(docs: RetrievalDoc[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const d of docs) {
    const t = norm(str(d.data.title));
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

/** Coverage counts for the health report. Generated and skipped docs are excluded. */
export function retrievalCoverage(allDocs: RetrievalDoc[], cfg: RetrievalConfig): RetrievalCoverage {
  const docs = allDocs.filter((d) => !isExempt(d));
  const counts = titleCounts(docs);
  return {
    total: docs.length,
    withPurpose: docs.filter((d) => purposeProblem(d, cfg) === null).length,
    withSymptoms: docs.filter(hasSymptoms).length,
    withUniqueTitle: docs.filter((d) => {
      const t = norm(str(d.data.title));
      return t !== '' && counts.get(t) === 1;
    }).length,
  };
}

export function checkRetrieval(allDocs: RetrievalDoc[], cfg: RetrievalConfig): AuditIssue[] {
  const docs = allDocs.filter((d) => !isExempt(d));
  const issues: AuditIssue[] = [];
  const warn = (d: RetrievalDoc, code: string, message: string, suggestion: string): void => {
    if (cfg.disabled.includes(code)) return;
    issues.push({ file: d.rel, rule: code, severity: 'warning', message, fixable: false, suggestion });
  };

  const counts = titleCounts(docs);
  const denied = new Set(cfg.generic_titles.map(norm));

  for (const d of docs) {
    const problem = purposeProblem(d, cfg);
    if (problem === 'missing') {
      const legacy = str(d.data.summary) ? 'summary' : str(d.data.description) ? 'description' : '';
      warn(
        d,
        R.RETRIEVAL_MISSING_PURPOSE,
        legacy ? `No purpose, but it has a ${legacy}` : 'No purpose: search tools have nothing to match intent against',
        legacy
          ? `Run ${MIGRATE_CMD} to copy ${legacy} into purpose (dry run without --apply)`
          : 'Add a one-sentence `purpose:` saying when to read this doc'
      );
    } else if (problem === 'weak') {
      warn(
        d,
        R.RETRIEVAL_WEAK_PURPOSE,
        'Purpose echoes the title, is under ' + cfg.purpose_min_words + ' words, or is a "Documentation for" placeholder',
        'Rewrite `purpose:` as a sentence about what question this doc answers'
      );
    }

    const t = norm(str(d.data.title));
    if (t && (denied.has(t) || (counts.get(t) ?? 0) > 1)) {
      warn(
        d,
        R.RETRIEVAL_GENERIC_TITLE,
        denied.has(t) ? `Title "${str(d.data.title)}" is generic` : `Title "${str(d.data.title)}" is shared by ${counts.get(t)} docs`,
        'Give the doc a title that names its specific subject'
      );
    }

    if (needsSymptoms(d) && !hasSymptoms(d)) {
      warn(
        d,
        R.RETRIEVAL_MISSING_SYMPTOMS,
        'Troubleshooting/runbook doc has no symptoms',
        'Add `symptoms:` with the phrases a user would search when hitting this problem'
      );
    }

    // shortcut: counts "## " lines inside code fences too; upgrade if fenced shell comments cause noise.
    const h2 = (d.body.match(/^## /gm) ?? []).length;
    if (d.body.length > cfg.oversized_chars || h2 > cfg.oversized_headings) {
      warn(
        d,
        R.RETRIEVAL_OVERSIZED,
        `Body is ${d.body.length} chars with ${h2} H2 sections`,
        'Split into self-contained docs, one topic each'
      );
    }
  }
  return issues;
}
