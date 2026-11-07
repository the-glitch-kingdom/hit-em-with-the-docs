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
  incidentFolder: string;
  /** Absolute path to the vault root. Facts go into `<vault>/facts/`. */
  vaultRoot: string;
  /** Project root for provenance relpath computation. */
  projectRoot: string;
  /** Accepted fact specs (already curated by the LLM proposer + user). */
  accept: FactSpec[];
  /** If true, returns the plan without writing files. */
  dryRun?: boolean;
}

export interface ExtractedFact {
  id: string;
  factPath: string;
  action: 'created' | 'already_exists';
  content: string;
}

export interface ExtractFactsResult {
  incidentId: string;
  incidentFolder: string;
  extractedFacts: ExtractedFact[];
  /** Whether the incident's facts.md was updated. */
  factsMdUpdated: boolean;
  factsMdPath: string;
}

export async function extractFacts(
  options: ExtractFactsOptions
): Promise<ExtractFactsResult> {
  const { incidentFolder, vaultRoot, projectRoot, accept, dryRun = false } = options;

  const narrativePath = join(incidentFolder, 'narrative.md');
  const narrativeRaw = await readFile(narrativePath, 'utf-8');
  const narrative = matter(narrativeRaw);
  const incidentId =
    typeof narrative.data.id === 'string'
      ? narrative.data.id
      : basename(incidentFolder);
  const provenanceRelPath = relative(projectRoot, incidentFolder).replace(/\\/g, '/');

  const factsDir = join(vaultRoot, 'facts');
  const today = new Date().toISOString().slice(0, 10);

  const extractedFacts: ExtractedFact[] = [];

  for (const spec of accept) {
    const factPath = join(factsDir, `${spec.id}.md`);

    if (existsSync(factPath)) {
      extractedFacts.push({
        id: spec.id,
        factPath,
        action: 'already_exists',
        content: await readFile(factPath, 'utf-8'),
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
      provenance: [provenanceRelPath + '/'],
      tags: spec.tags ?? [],
    };
    if (spec.purpose) frontmatter.purpose = spec.purpose;
    if (spec.symptoms?.length) frontmatter.symptoms = spec.symptoms;
    if (spec.verifyCommand) {
      frontmatter.verify_command = spec.verifyCommand;
    }

    const body = renderFactBody(spec);
    const content = matter.stringify(body, frontmatter);

    if (!dryRun) {
      await mkdir(dirname(factPath), { recursive: true });
      await writeFile(factPath, content, 'utf-8');
    }

    extractedFacts.push({
      id: spec.id,
      factPath,
      action: 'created',
      content,
    });
  }

  // Update incident's facts.md `produced:` list (idempotent — only adds new
  // ids, never removes existing ones).
  const factsMdPath = join(incidentFolder, 'facts.md');
  let factsMdUpdated = false;

  if (existsSync(factsMdPath)) {
    const factsMdRaw = await readFile(factsMdPath, 'utf-8');
    const factsMd = matter(factsMdRaw);
    // Important: gray-matter caches parse results keyed by content. Mutating
    // factsMd.data leaks across calls with identical input strings (notably
    // in tests). Always build a fresh data object.
    const existing = Array.isArray(factsMd.data.produced)
      ? [...(factsMd.data.produced as string[])]
      : [];
    const newIds = extractedFacts
      .filter((e) => e.action === 'created')
      .map((e) => e.id);
    const toAdd = newIds.filter((id) => !existing.includes(id));
    if (toAdd.length > 0) {
      const newData = {
        ...factsMd.data,
        produced: [...existing, ...toAdd],
        last_updated: today,
      };
      const newContent = matter.stringify(factsMd.content, newData);
      if (!dryRun) {
        await writeFile(factsMdPath, newContent, 'utf-8');
      }
      factsMdUpdated = true;
    }
  }

  return {
    incidentId,
    incidentFolder,
    extractedFacts,
    factsMdUpdated,
    factsMdPath,
  };
}

function renderFactBody(spec: FactSpec): string {
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
export function defaultVaultRoot(projectRoot: string): string {
  return resolve(projectRoot, '.documentation/knowledge-base');
}
