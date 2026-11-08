/**
 * Fact-extraction writer (2.3.0 PR3).
 *
 * The CLI side of `hewtd extract-facts <incident-folder>`. Takes accepted
 * fact specs and writes them to `<vault>/facts/<id>.md` with provenance
 * auto-populated to the source incident folder. Idempotent — re-running
 * with an already-committed fact spec is a no-op.
 *
 * The LLM proposal step (read narrative → suggest fact specs) lives in the
 * `/hit-em-with-the-docs:extract-facts` slash command, NOT here. This
 * module is the deterministic writer that the slash command invokes after
 * the user accepts proposals.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import matter from 'gray-matter';

export interface FactSpec {
  id: string;
  title: string;
  confidence: 'high' | 'medium' | 'low' | 'hypothesis';
  verifyCommand?: string;
  /** Claim paragraph (will be inserted as `## Claim`). */
  claim: string;
  /** Optional how-to-verify paragraph. */
  howToVerify?: string;
  /** Optional consequences paragraph. */
  consequences?: string;
  /** Optional tags (will be merged with auto-derived tags). */
  tags?: string[];
  /** Optional one-sentence purpose: the question the fact answers. */
  purpose?: string;
  /** Optional plain-string symptoms: how the problem is described, or literal error text. */
  symptoms?: string[];
  /** Optional domains. Defaults to ['knowledge-base'] if not specified. */
  domains?: string[];
}

export interface ExtractFactsOptions {
  /** Absolute path to the incident folder (must contain narrative.md). */
  incident_folder: string;
  /** Absolute path to the vault root. Facts go into `<vault>/facts/`. */
  vault_root: string;
  /** Project root for provenance relpath computation. */
  project_root: string;
  /** Accepted fact specs (already curated by the LLM proposer + user). */
  accept: FactSpec[];
  /** If true, returns the plan without writing files. */
  dry_run?: boolean;
}

export interface ExtractedFact {
  id: string;
  fact_path: string;
  action: 'created' | 'already_exists';
  content: string;
}

export interface ExtractFactsResult {
  incident_id: string;
  incident_folder: string;
  extracted_facts: ExtractedFact[];
  /** Whether the incident's facts.md was updated. */
  facts_md_updated: boolean;
  facts_md_path: string;
}

export async function extract_facts(
  options: ExtractFactsOptions
): Promise<ExtractFactsResult> {
  const { incident_folder, vault_root, project_root, accept, dry_run = false } = options;

  const narrative_path = join(incident_folder, 'narrative.md');
  const narrative_raw = await readFile(narrative_path, 'utf-8');
  const narrative = matter(narrative_raw);
  const incident_id =
    typeof narrative.data.id === 'string'
      ? narrative.data.id
      : basename(incident_folder);
  const provenance_rel_path = relative(project_root, incident_folder).replace(/\\/g, '/');

  const facts_dir = join(vault_root, 'facts');
  const today = new Date().toISOString().slice(0, 10);

  const extracted_facts: ExtractedFact[] = [];

  for (const spec of accept) {
    const fact_path = join(facts_dir, `${spec.id}.md`);

    if (existsSync(fact_path)) {
      extracted_facts.push({
        id: spec.id,
        fact_path,
        action: 'already_exists',
        content: await readFile(fact_path, 'utf-8'),
      });
      continue;
    }

    const frontmatter: Record<string, unknown> = {
      title: spec.title,
      tier: 'fact',
      domains: spec.domains ?? ['knowledge-base'],
      status: 'active',
      last_updated: today,
      id: spec.id,
      confidence: spec.confidence,
      last_verified: today,
      provenance: [provenance_rel_path + '/'],
      tags: spec.tags ?? [],
    };
    if (spec.purpose) frontmatter.purpose = spec.purpose;
    if (spec.symptoms?.length) frontmatter.symptoms = spec.symptoms;
    if (spec.verifyCommand) {
      frontmatter.verify_command = spec.verifyCommand;
    }

    const body = render_fact_body(spec);
    const content = matter.stringify(body, frontmatter);

    if (!dry_run) {
      await mkdir(dirname(fact_path), { recursive: true });
      await writeFile(fact_path, content, 'utf-8');
    }

    extracted_facts.push({
      id: spec.id,
      fact_path,
      action: 'created',
      content,
    });
  }

  // Update incident's facts.md `produced:` list (idempotent — only adds new
  // ids, never removes existing ones).
  const facts_md_path = join(incident_folder, 'facts.md');
  let facts_md_updated = false;

  if (existsSync(facts_md_path)) {
    const facts_md_raw = await readFile(facts_md_path, 'utf-8');
    const facts_md = matter(facts_md_raw);
    // Important: gray-matter caches parse results keyed by content. Mutating
    // factsMd.data leaks across calls with identical input strings (notably
    // in tests). Always build a fresh data object.
    const existing = Array.isArray(facts_md.data.produced)
      ? [...(facts_md.data.produced as string[])]
      : [];
    const new_ids = extracted_facts
      .filter((e) => e.action === 'created')
      .map((e) => e.id);
    const to_add = new_ids.filter((id) => !existing.includes(id));
    if (to_add.length > 0) {
      const new_data = {
        ...facts_md.data,
        produced: [...existing, ...to_add],
        last_updated: today,
      };
      const new_content = matter.stringify(facts_md.content, new_data);
      if (!dry_run) {
        await writeFile(facts_md_path, new_content, 'utf-8');
      }
      facts_md_updated = true;
    }
  }

  return {
    incident_id,
    incident_folder,
    extracted_facts,
    facts_md_updated,
    facts_md_path,
  };
}

function render_fact_body(spec: FactSpec): string {
  const sections: string[] = [];
  sections.push(`# ${spec.title}`);
  sections.push('');
  sections.push('## Claim');
  sections.push(spec.claim.trim());
  sections.push('');
  if (spec.howToVerify) {
    sections.push('## How to verify');
    sections.push(spec.howToVerify.trim());
    sections.push('');
  }
  if (spec.consequences) {
    sections.push('## Consequences');
    sections.push(spec.consequences.trim());
    sections.push('');
  }
  return '\n' + sections.join('\n');
}

/**
 * Re-export the resolved vault root so callers don't have to recompute it.
 */
export function default_vault_root(project_root: string): string {
  return resolve(project_root, '.documentation/knowledge-base');
}
