/**
 * Frontmatter mutation for `hewtd cite` (2.3.0 PR3).
 *
 * Inserts a `cites:` entry into the nearest `symptoms:` block in a playbook,
 * or creates a new top-level `symptoms:` block if one doesn't exist.
 * Idempotent: re-citing the same fact in the same symptom entry is a no-op.
 *
 * Round-trip safety: uses gray-matter to preserve body content. Frontmatter
 * key order is preserved for keys that already existed; new keys (symptoms)
 * append at the end.
 */

import { readFile, writeFile } from 'fs/promises';
import matter from 'gray-matter';

export interface CiteOptions {
  /** Absolute path to the playbook file. */
  playbookPath: string;
  /** Fact id to insert into the symptoms block. */
  factId: string;
  /**
   * Optional symptom identifier — if present, adds the citation to the
   * matching entry. If absent, adds to the FIRST object symptoms entry (or creates
   * a single placeholder symptom).
   */
  symptomMatch?: {
    alert_name?: string;
    user_phrase?: string;
    error_pattern?: string;
  };
  /** If true, returns the proposed content without writing the file. */
  dryRun?: boolean;
}

export interface CiteResult {
  playbookPath: string;
  factId: string;
  /** What we did: inserted, already_present (no-op), or created_block. */
  action: 'inserted' | 'already_present' | 'created_block';
  /** Index of the symptoms entry the citation was added to. */
  symptomIndex: number;
  /** The full new file content. */
  newContent: string;
}

interface SymptomEntry {
  alert_name?: string;
  user_phrase?: string | string[];
  error_pattern?: string;
  severity?: string;
  target?: string;
  cites?: string[];
}

export async function cite(options: CiteOptions): Promise<CiteResult> {
  const { playbookPath, factId, symptomMatch, dryRun = false } = options;

  const content = await readFile(playbookPath, 'utf-8');
  const parsed = matter(content);
  const data = (parsed.data ?? {}) as Record<string, unknown>;

  // Plain-string entries (allowed on facts, #46) can't hold cites; skip them.
  const symptoms = Array.isArray(data.symptoms)
    ? (data.symptoms as (SymptomEntry | string)[])
    : [];
  const isEntry = (s: SymptomEntry | string): s is SymptomEntry =>
    typeof s === 'object' && s !== null;
  const firstEntry = symptoms.findIndex(isEntry);

  let action: CiteResult['action'];
  let symptomIndex: number;

  if (firstEntry < 0) {
    // No citable entry — add one placeholder entry.
    symptoms.push({
      alert_name: '<TODO: specify alert_name, user_phrase, or error_pattern>',
      target: '<TODO: anchor>',
      cites: [factId],
    });
    symptomIndex = symptoms.length - 1;
    action = 'created_block';
  } else {
    // Find the target entry. If symptomMatch is provided, look for a match;
    // otherwise default to the first entry.
    let targetIdx = firstEntry;
    if (symptomMatch) {
      const matched = symptoms.findIndex((s) => isEntry(s) && matchesSymptom(s, symptomMatch));
      if (matched >= 0) targetIdx = matched;
    }

    const entry = symptoms[targetIdx] as SymptomEntry;
    const cites = Array.isArray(entry.cites) ? entry.cites : [];

    if (cites.includes(factId)) {
      action = 'already_present';
    } else {
      cites.push(factId);
      entry.cites = cites;
      action = 'inserted';
    }
    symptomIndex = targetIdx;
  }

  data.symptoms = symptoms;
  const newContent = matter.stringify(parsed.content, data);

  if (!dryRun && action !== 'already_present') {
    await writeFile(playbookPath, newContent, 'utf-8');
  }

  return {
    playbookPath,
    factId,
    action,
    symptomIndex,
    newContent,
  };
}

function matchesSymptom(
  entry: SymptomEntry,
  match: NonNullable<CiteOptions['symptomMatch']>
): boolean {
  if (match.alert_name && entry.alert_name === match.alert_name) return true;
  if (match.error_pattern && entry.error_pattern === match.error_pattern) return true;
  if (match.user_phrase) {
    const ep = entry.user_phrase;
    if (typeof ep === 'string' && ep === match.user_phrase) return true;
    if (Array.isArray(ep) && ep.includes(match.user_phrase)) return true;
  }
  return false;
}
