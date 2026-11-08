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
  playbook_path: string;
  /** Fact id to insert into the symptoms block. */
  fact_id: string;
  /**
   * Optional symptom identifier — if present, adds the citation to the
   * matching entry. If absent, adds to the FIRST object symptoms entry (or creates
   * a single placeholder symptom).
   */
  symptom_match?: {
    alert_name?: string;
    user_phrase?: string;
    error_pattern?: string;
  };
  /** If true, returns the proposed content without writing the file. */
  dry_run?: boolean;
}

export interface CiteResult {
  playbook_path: string;
  fact_id: string;
  /** What we did: inserted, already_present (no-op), or created_block. */
  action: 'inserted' | 'already_present' | 'created_block';
  /** Index of the symptoms entry the citation was added to. */
  symptom_index: number;
  /** The full new file content. */
  new_content: string;
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
  const { playbook_path, fact_id, symptom_match, dry_run = false } = options;

  const content = await readFile(playbook_path, 'utf-8');
  const parsed = matter(content);
  const data = (parsed.data ?? {}) as Record<string, unknown>;

  // Plain-string entries (allowed on facts, #46) can't hold cites; skip them.
  const symptoms = Array.isArray(data.symptoms)
    ? (data.symptoms as (SymptomEntry | string)[])
    : [];
  const is_entry = (s: SymptomEntry | string): s is SymptomEntry =>
    typeof s === 'object' && s !== null;
  const first_entry = symptoms.findIndex(is_entry);

  let action: CiteResult['action'];
  let symptom_index: number;

  if (first_entry < 0) {
    // No citable entry — add one placeholder entry.
    symptoms.push({
      alert_name: '<TODO: specify alert_name, user_phrase, or error_pattern>',
      target: '<TODO: anchor>',
      cites: [fact_id],
    });
    symptom_index = symptoms.length - 1;
    action = 'created_block';
  } else {
    // Find the target entry. If symptomMatch is provided, look for a match;
    // otherwise default to the first entry.
    let target_idx = first_entry;
    if (symptom_match) {
      const matched = symptoms.findIndex((s) => is_entry(s) && matches_symptom(s, symptom_match));
      if (matched >= 0) target_idx = matched;
    }

    const entry = symptoms[target_idx] as SymptomEntry;
    const cites = Array.isArray(entry.cites) ? entry.cites : [];

    if (cites.includes(fact_id)) {
      action = 'already_present';
    } else {
      cites.push(fact_id);
      entry.cites = cites;
      action = 'inserted';
    }
    symptom_index = target_idx;
  }

  data.symptoms = symptoms;
  const new_content = matter.stringify(parsed.content, data);

  if (!dry_run && action !== 'already_present') {
    await writeFile(playbook_path, new_content, 'utf-8');
  }

  return {
    playbook_path,
    fact_id,
    action,
    symptom_index,
    new_content,
  };
}

function matches_symptom(
  entry: SymptomEntry,
  match: NonNullable<CiteOptions['symptom_match']>
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
