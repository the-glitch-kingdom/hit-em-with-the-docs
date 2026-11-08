/**
 * Citation graph walker for knowledge-base primitives (2.3.0).
 *
 * Builds the per-fact citation index from three source kinds:
 *   - Facts (`<vault>/facts/<id>.md`) — the canonical fact corpus.
 *   - Incident-facts bridges (`<vault>/incidents/<slug>/facts.md`) — produced /
 *     strengthened / weakened edges.
 *   - Playbooks (any file with `symptoms: [...]` frontmatter) — `cites` edges
 *     from each symptom entry to the facts the playbook step depends on.
 *
 * Used by:
 *   - `facts/INDEX.md` generator (PR2) — to compute citer counts per fact.
 *   - `hewtd find-citers <fact-id>` CLI command (PR3) — typed structure output.
 *   - Dangling-citation linting (future PR) — flags `cites:` pointing at
 *     non-existent facts.
 */

import { readFile } from 'fs/promises';
import { join, relative, resolve } from 'path';
import { glob } from 'glob';
import matter from 'gray-matter';

export interface FactRef {
  /** Fact id (from frontmatter `id:`). */
  id: string;
  /** Absolute path to the fact's markdown file. */
  path: string;
  /** Path relative to the project root (for stable, diff-friendly indexes). */
  relPath: string;
  /** Frontmatter title. */
  title: string;
  /** Confidence enum value, if present. */
  confidence: string | undefined;
  /** YYYY-MM-DD or null if missing/malformed. */
  lastVerified: string | undefined;
  /** Tags from frontmatter. */
  tags: string[];
}

export interface IncidentRef {
  /** Incident id (from narrative.md frontmatter `id:`). */
  id: string;
  /** Absolute path to the incident folder. */
  folder_path: string;
  /** Project-relative folder path. */
  rel_folder_path: string;
  /** Frontmatter title from narrative.md. */
  title: string;
  /** YYYY-MM-DD. */
  date: string | undefined;
  severity: string | undefined;
  resolution_status: string | undefined;
  components: string[];
  /** Fact ids produced by this incident (from facts.md). */
  produced: string[];
  strengthened: string[];
  weakened: string[];
}

export interface PlaybookCitation {
  /** Project-relative path to the playbook. */
  rel_path: string;
  /** Absolute path. */
  path: string;
  /** Frontmatter title. */
  title: string;
  /** Anchor within the playbook (e.g. `#vault-down-auth-staging`). */
  target: string;
  /** Symptom kind that triggered the citation. */
  kind: 'alert_name' | 'user_phrase' | 'error_pattern';
  /** The matching key (string or array, depending on kind). */
  key: string | string[];
  severity: string | undefined;
}

export interface CiterIndex {
  /** All discovered facts, keyed by id. */
  facts: Map<string, FactRef>;
  /** All discovered incident folders, keyed by id. */
  incidents: Map<string, IncidentRef>;
  /**
   * Citation edges per fact id. A fact id appearing here may not have a
   * matching entry in `facts` — that's a dangling citation, detected by
   * the caller.
   */
  citers: Map<string, PlaybookCitation[]>;
}

/**
 * Typed structure returned by `findCiters(factId)`. Matches the shape the
 * `hewtd find-citers` CLI command will print and the structure documented
 * in `docs/knowledge-base-primitives.md`.
 */
export interface FindCitersResult {
  fact_id: string;
  fact_exists: boolean;
  citers: string[]; // playbook relative paths
  incidents_produced_in: string[]; // incident ids
  incidents_strengthened_by: string[];
  incidents_weakened_by: string[];
}

export interface BuildCiterIndexOptions {
  /** Absolute path to the project root. */
  repo_root: string;
  /** Absolute path to the vault root (default config: <root>/.documentation/knowledge-base/). */
  vault_root: string;
  /**
   * Glob patterns (absolute, project-rooted) used to scan playbooks for
   * `symptoms:` frontmatter blocks. The walker filters by frontmatter
   * presence — files without a `symptoms:` block are skipped quickly.
   */
  playbook_globs: string[];
}

const is_string = (value: unknown): value is string => typeof value === 'string';
const is_string_array = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(is_string);

/**
 * Walk the corpus and build a citer index. Designed to be cheap on no-vault
 * trees: if the vault root doesn't exist, returns an empty index without
 * scanning playbooks for symptoms (no point — no facts to cite).
 */
export async function build_citer_index(
  options: BuildCiterIndexOptions
): Promise<CiterIndex> {
  const { repo_root: repo_root, vault_root, playbook_globs } = options;

  const facts = new Map<string, FactRef>();
  const incidents = new Map<string, IncidentRef>();
  const citers = new Map<string, PlaybookCitation[]>();

  // ----- Facts -----
  const fact_files = await glob(join(vault_root, 'facts/*.md'), {
    nodir: true,
    absolute: true,
  });
  for (const fact_path of fact_files) {
    const reference = await load_fact_ref(fact_path, repo_root);
    if (reference) facts.set(reference.id, reference);
  }

  // ----- Incidents -----
  const narrative_files = await glob(
    join(vault_root, 'incidents/*/narrative.md'),
    { nodir: true, absolute: true }
  );
  for (const narrative_path of narrative_files) {
    const reference = await load_incident_ref(narrative_path, repo_root);
    if (reference) incidents.set(reference.id, reference);
  }

  // Short-circuit: if no facts and no incidents, no point scanning playbooks.
  if (facts.size === 0 && incidents.size === 0) {
    return { facts, incidents, citers };
  }

  // ----- Playbook citations -----
  // Cheap pre-filter: read each candidate file and skip if frontmatter has
  // no `symptoms` key. Avoids paying for full YAML parse on every doc.
  const playbook_candidates = new Set<string>();
  for (const pattern of playbook_globs) {
    const matches = await glob(pattern, { nodir: true, absolute: true });
    for (const match of matches) playbook_candidates.add(match);
  }

  for (const playbook_path of playbook_candidates) {
    const cits = await extract_playbook_citations(playbook_path, repo_root);
    for (const citation of cits) {
      // Each citation has a list of fact ids implicit in the symptoms entry.
      const fact_ids = citation.fact_ids;
      for (const fact_id of fact_ids) {
        const existing = citers.get(fact_id) ?? [];
        existing.push(citation.citation);
        citers.set(fact_id, existing);
      }
    }
  }

  return { facts, incidents, citers };
}

async function load_fact_ref(
  path: string,
  repo_root: string
): Promise<FactRef | null> {
  try {
    const content = await readFile(path, 'utf-8');
    const { data } = matter(content);
    if (data.tier !== 'fact' || !is_string(data.id)) return null;

    const tags = is_string_array(data.tags) ? data.tags : [];
    const last_verified = normalize_date(data.last_verified);

    return {
      id: data.id,
      path,
      relPath: relative(repo_root, path),
      title: is_string(data.title) ? data.title : data.id,
      confidence: is_string(data.confidence) ? data.confidence : undefined,
      lastVerified: last_verified,
      tags,
    };
  } catch {
    return null;
  }
}

async function load_incident_ref(
  narrative_path: string,
  repo_root: string
): Promise<IncidentRef | null> {
  try {
    const narrative_content = await readFile(narrative_path, 'utf-8');
    const { data: narrative } = matter(narrative_content);
    if (narrative.tier !== 'incident-narrative' || !is_string(narrative.id)) {
      return null;
    }

    const folder_path = resolve(narrative_path, '..');
    const facts_md_path = join(folder_path, 'facts.md');

    let produced: string[] = [];
    let strengthened: string[] = [];
    let weakened: string[] = [];
    try {
      const facts_content = await readFile(facts_md_path, 'utf-8');
      const { data: facts } = matter(facts_content);
      if (facts.tier === 'incident-facts') {
        if (is_string_array(facts.produced)) produced = facts.produced;
        if (is_string_array(facts.strengthened)) strengthened = facts.strengthened;
        if (is_string_array(facts.weakened)) weakened = facts.weakened;
      }
    } catch {
      // facts.md missing — incident has no produced/strengthened/weakened edges
    }

    return {
      id: narrative.id,
      folder_path,
      rel_folder_path: relative(repo_root, folder_path),
      title: is_string(narrative.title) ? narrative.title : narrative.id,
      date: normalize_date(narrative.date),
      severity: is_string(narrative.severity) ? narrative.severity : undefined,
      resolution_status: is_string(narrative.resolution_status)
        ? narrative.resolution_status
        : undefined,
      components: is_string_array(narrative.components) ? narrative.components : [],
      produced,
      strengthened,
      weakened,
    };
  } catch {
    return null;
  }
}

interface PlaybookCitationWithFacts {
  citation: PlaybookCitation;
  fact_ids: string[];
}

async function extract_playbook_citations(
  playbook_path: string,
  repo_root: string
): Promise<PlaybookCitationWithFacts[]> {
  try {
    const content = await readFile(playbook_path, 'utf-8');
    const { data } = matter(content);
    if (!Array.isArray(data.symptoms) || data.symptoms.length === 0) {
      return [];
    }

    const title = is_string(data.title) ? data.title : playbook_path;
    const results: PlaybookCitationWithFacts[] = [];

    for (const sym of data.symptoms) {
      const text = sym as Record<string, unknown>;
      if (!is_string(text.target) || !is_string_array(text.cites)) continue;

      let kind: PlaybookCitation['kind'];
      let key: string | string[];
      if (is_string(text.alert_name)) {
        kind = 'alert_name';
        key = text.alert_name;
      } else if (is_string_array(text.user_phrase) || is_string(text.user_phrase)) {
        kind = 'user_phrase';
        key = text.user_phrase as string | string[];
      } else if (is_string(text.error_pattern)) {
        kind = 'error_pattern';
        key = text.error_pattern;
      } else {
        continue; // malformed — caught by audit-strict, ignored here
      }

      results.push({
        citation: {
          rel_path: relative(repo_root, playbook_path),
          path: playbook_path,
          title,
          target: text.target,
          kind,
          key,
          severity: is_string(text.severity) ? text.severity : undefined,
        },
        fact_ids: text.cites,
      });
    }

    return results;
  } catch {
    return [];
  }
}

function normalize_date(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return undefined;
}

/**
 * Public lookup: typed structure for one fact id. Matches the shape the
 * `hewtd find-citers` CLI command prints.
 */
export function find_citers_in_index(
  index: CiterIndex,
  fact_id: string
): FindCitersResult {
  // Dedup citers by playbook relPath — multiple symptoms entries in the same
  // playbook citing the same fact count as ONE citer.
  const citer_set = new Set<string>();
  for (const citer of index.citers.get(fact_id) ?? []) {
    citer_set.add(citer.rel_path);
  }

  const incidents_produced_in: string[] = [];
  const incidents_strengthened_by: string[] = [];
  const incidents_weakened_by: string[] = [];
  for (const inc of index.incidents.values()) {
    if (inc.produced.includes(fact_id)) incidents_produced_in.push(inc.id);
    if (inc.strengthened.includes(fact_id)) incidents_strengthened_by.push(inc.id);
    if (inc.weakened.includes(fact_id)) incidents_weakened_by.push(inc.id);
  }

  return {
    fact_id,
    fact_exists: index.facts.has(fact_id),
    citers: [...citer_set].sort(),
    incidents_produced_in: incidents_produced_in.sort(),
    incidents_strengthened_by: incidents_strengthened_by.sort(),
    incidents_weakened_by: incidents_weakened_by.sort(),
  };
}

/**
 * Count distinct citers for a fact id. Used by the facts-index generator.
 */
export function count_citers(index: CiterIndex, fact_id: string): number {
  const list = index.citers.get(fact_id);
  if (!list) return 0;
  // Distinct by playbook relPath (multiple symptoms in the same playbook
  // citing the same fact count once).
  const seen = new Set<string>();
  for (const citer of list) seen.add(citer.rel_path);
  return seen.size;
}
