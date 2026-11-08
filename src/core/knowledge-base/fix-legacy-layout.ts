/**
 * Migrate 2.3.0-buggy incident folders into the canonical layout (2.4.0).
 *
 * In 2.3.0, `hewtd migrate-incident <flat-file>` wrote the new folder
 * AS A SIBLING of the flat file. When the flat file lived at the vault
 * root (the documented example), the resulting folder ended up at
 * `<vault-root>/<slug>/` instead of `<vault-root>/incidents/<slug>/`.
 * The `incidents/INDEX.md` generator scans only the canonical path, so
 * those folders were silently absent from the index.
 *
 * This module:
 *   1. Detects legacy folders — anything matching `<vault-root>/<slug>/`
 *      that contains a valid `narrative.md` AND isn't already under the
 *      canonical `<vault-root>/incidents/` parent.
 *   2. Moves them into `<vault-root>/incidents/<slug>/` (preserving any
 *      `facts.md` / `evidence/` contents).
 *   3. Rewrites `provenance:` references in any `<vault-root>/facts/*.md`
 *      files that pointed at the old folder paths.
 *
 * Idempotent: re-running on a clean vault is a no-op with a status report.
 */

import { readFile, writeFile, rename, mkdir, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, relative } from 'path';
import matter from 'gray-matter';

export interface FixLegacyLayoutOptions {
  /** Absolute vault root. */
  vault_root: string;
  /** Project root — used for relative-path provenance rewrites. */
  project_root: string;
  /** If true, returns the plan without writing. */
  dry_run?: boolean;
}

export interface MovedFolder {
  /** Slug (folder basename), e.g. `2026-04-23-keycloak-idle-session`. */
  slug: string;
  /** Absolute source path (legacy). */
  from: string;
  /** Absolute destination path (canonical). */
  to: string;
}

export interface RewrittenProvenance {
  /** Absolute fact file path. */
  fact_path: string;
  /** Old provenance string that was replaced. */
  old_ref: string;
  /** New provenance string. */
  new_ref: string;
}

export interface FixLegacyLayoutResult {
  vault_root: string;
  moved: MovedFolder[];
  rewritten_provenance: RewrittenProvenance[];
  /** Paths that LOOKED like incident folders but were ambiguous. Reported but not moved. */
  skipped: { path: string; reason: string }[];
  action: 'fixed' | 'no_op' | 'dry_run';
}

/**
 * Discover and (optionally) relocate 2.3.0-layout incident folders.
 */
export async function fix_legacy_layout(
  options: FixLegacyLayoutOptions
): Promise<FixLegacyLayoutResult> {
  const { vault_root, project_root, dry_run = false } = options;

  const result: FixLegacyLayoutResult = {
    vault_root,
    moved: [],
    rewritten_provenance: [],
    skipped: [],
    action: 'no_op',
  };

  if (!existsSync(vault_root)) {
    return result;
  }

  // Walk one level deep under vaultRoot, looking for `<slug>/narrative.md`
  // entries that are NOT inside `incidents/`, `facts/`, or `symptoms/`.
  const RESERVED_DIRS = new Set(['incidents', 'facts', 'symptoms']);
  const top_level = await readdir(vault_root, { withFileTypes: true });
  const legacy_candidates: MovedFolder[] = [];

  for (const entry of top_level) {
    if (!entry.isDirectory()) continue;
    if (RESERVED_DIRS.has(entry.name)) continue;

    const folder_path = join(vault_root, entry.name);
    const narrative_path = join(folder_path, 'narrative.md');
    if (!existsSync(narrative_path)) {
      continue;
    }

    // Confirm this is genuinely an incident folder by reading the narrative
    // frontmatter — protects against false positives (e.g. user-created
    // folders that happen to contain a narrative.md from some other context).
    const is_incident = await looks_like_incident_folder(narrative_path);
    if (!is_incident) {
      result.skipped.push({
        path: folder_path,
        reason: 'narrative.md present but tier is not "incident-narrative"',
      });
      continue;
    }

    legacy_candidates.push({
      slug: entry.name,
      from: folder_path,
      to: join(vault_root, 'incidents', entry.name),
    });
  }

  if (legacy_candidates.length === 0) {
    return result;
  }

  // Build the provenance-rewrite plan FIRST (before moving anything) so
  // we can reason about it. Old refs look like:
  //   `<rel-vault>/2026-04-23-foo/` (no `incidents/`)
  // New refs:
  //   `<rel-vault>/incidents/2026-04-23-foo/`
  const facts_dir = join(vault_root, 'facts');
  const provenance_rewrites: RewrittenProvenance[] = [];

  if (existsSync(facts_dir)) {
    const fact_files = await readdir(facts_dir);
    for (const fact_file of fact_files) {
      if (!fact_file.endsWith('.md')) continue;
      if (fact_file === 'INDEX.md') continue;
      const fact_path = join(facts_dir, fact_file);
      const fact_stat = await stat(fact_path);
      if (!fact_stat.isFile()) continue;

      const fact_raw = await readFile(fact_path, 'utf-8');
      const fact_parsed = matter(fact_raw);
      const provenance = fact_parsed.data.provenance;
      if (!Array.isArray(provenance)) continue;

      let did_rewrite = false;
      const new_provenance: string[] = [];
      for (const ref of provenance) {
        if (typeof ref !== 'string') {
          new_provenance.push(ref);
          continue;
        }
        let rewritten = ref;
        for (const candidate of legacy_candidates) {
          // Generate possible old-ref shapes and rewrite.
          // - relative from project root: `<rel-vault>/<slug>/`
          // - bare slug + trailing slash: `<slug>/`
          // - bare slug no slash: `<slug>`
          const rel_old = `${relative(project_root, candidate.from)}/`;
          const rel_new = `${relative(project_root, candidate.to)}/`;

          if (ref === rel_old || ref === rel_old.slice(0, -1)) {
            rewritten = rel_new;
            break;
          }
          if (ref === `${candidate.slug}/` || ref === candidate.slug) {
            // Bare-slug reference; rewrite to the canonical relative path.
            rewritten = rel_new;
            break;
          }
        }
        if (rewritten !== ref) {
          did_rewrite = true;
          provenance_rewrites.push({
            fact_path,
            old_ref: ref,
            new_ref: rewritten,
          });
        }
        new_provenance.push(rewritten);
      }

      if (did_rewrite && !dry_run) {
        const new_data = { ...fact_parsed.data, provenance: new_provenance };
        await writeFile(fact_path, matter.stringify(fact_parsed.content, new_data), 'utf-8');
      }
    }
  }

  // Now do the actual folder moves (if not dry-run). Ensure incidents/
  // parent dir exists first.
  if (!dry_run) {
    const incidents_parent = join(vault_root, 'incidents');
    await mkdir(incidents_parent, { recursive: true });

    for (const candidate of legacy_candidates) {
      // Refuse to clobber an existing folder at the destination.
      if (existsSync(candidate.to)) {
        result.skipped.push({
          path: candidate.from,
          reason: `destination already exists at ${candidate.to}; manual merge required`,
        });
        continue;
      }
      await rename(candidate.from, candidate.to);
      result.moved.push(candidate);
    }
  } else {
    // Dry-run: report what WOULD be moved without doing it.
    for (const candidate of legacy_candidates) {
      if (existsSync(candidate.to)) {
        result.skipped.push({
          path: candidate.from,
          reason: `destination already exists at ${candidate.to}; manual merge required`,
        });
        continue;
      }
      result.moved.push(candidate);
    }
  }

  result.rewritten_provenance = provenance_rewrites;
  result.action = dry_run
    ? 'dry_run'
    : result.moved.length > 0 || provenance_rewrites.length > 0
      ? 'fixed'
      : 'no_op';

  return result;
}

async function looks_like_incident_folder(narrative_path: string): Promise<boolean> {
  try {
    const content = await readFile(narrative_path, 'utf-8');
    const { data } = matter(content);
    return data.tier === 'incident-narrative';
  } catch {
    return false;
  }
}
