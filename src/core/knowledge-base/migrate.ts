/**
 * Flat-file incident → folder migration (2.3.0 PR3, target-path fix in 2.4.0).
 *
 * Reads a legacy flat-file incident and converts it into the folder form
 * AT THE CANONICAL VAULT LOCATION:
 *
 *   <flat-file>.md  →  <vault-root>/incidents/<slug>/narrative.md
 *                      <vault-root>/incidents/<slug>/facts.md (skeleton)
 *                      <vault-root>/incidents/<slug>/evidence/ (empty)
 *
 * In 2.3.0 the target was derived from the flat file's parent directory,
 * which produced folders OUTSIDE `<vault-root>/incidents/` when the source
 * was at the vault root. The `incidents/INDEX.md` generator scans only
 * `<vault-root>/incidents/<slug>/narrative.md` and silently missed those
 * folders. 2.4.0 fixes this by always writing under `<vault-root>/incidents/`.
 *
 * Idempotency:
 *   - If a valid `narrative.md` exists at EITHER the new path (canonical)
 *     OR the legacy path (`<source-parent>/<slug>/narrative.md`), the
 *     migration is treated as already done — no-op unless `--force`.
 *   - This protects against double-migration and is robust against
 *     consumers who already migrated under the 2.3.0 buggy layout.
 *
 * For consumers stuck on the 2.3.0 buggy layout, see `fixLegacyLayout()`
 * which moves stale folders into `<vault-root>/incidents/` and rewrites
 * any fact `provenance:` references.
 */

import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, dirname, join } from 'path';
import matter from 'gray-matter';

export interface MigrateIncidentOptions {
  /** Absolute path to the flat-file incident markdown. */
  flat_file_path: string;
  /**
   * Absolute path to the vault root. The migrated folder lands at
   * `<vaultRoot>/incidents/<slug>/`. Required since 2.4.0 — the 2.3.0
   * "sibling of the flat file" behavior was the source of the path bug.
   */
  vault_root: string;
  /** If true, returns the migration plan without writing. */
  dry_run?: boolean;
  /**
   * If true, proceed with migration even if a folder already exists at
   * the canonical or legacy location. Used to recover from a partial
   * migration.
   */
  force?: boolean;
}

export interface MigrateIncidentResult {
  flat_file_path: string;
  /** The canonical target — always under `<vaultRoot>/incidents/`. */
  target_folder: string;
  action: 'migrated' | 'already_migrated' | 'dry_run';
  /**
   * Populated when `action === 'already_migrated'` to indicate WHERE the
   * existing migration was found. `'new'` = canonical `<vault>/incidents/`;
   * `'legacy'` = 2.3.0-style sibling-of-flat-file location. Helps consumers
   * decide whether to run `fix-legacy-layout`.
   */
  existing_location?: 'new' | 'legacy';
  narrative_path: string;
  facts_path: string;
  evidence_path: string;
  /** What the narrative.md content will be. */
  narrative_content: string;
  /** What the facts.md content will be. */
  facts_content: string;
}

export async function migrate_incident(
  options: MigrateIncidentOptions
): Promise<MigrateIncidentResult> {
  const { flat_file_path, vault_root, dry_run = false, force = false } = options;

  const source_content = await readFile(flat_file_path, 'utf-8');
  const parsed = matter(source_content);
  const fm = (parsed.data ?? {}) as Record<string, unknown>;

  // Derive the target folder name. Priority:
  //   1. Frontmatter `id:` (if YYYY-MM-DD-slug shape)
  //   2. The flat file's basename, normalized to YYYY-MM-DD-<slug> (#39):
  //      `incident-2026-09-28-x` becomes `2026-09-28-x`, and an undated name
  //      takes its date from frontmatter `date:` when there is one.
  const flat_base = basename(flat_file_path, '.md');
  const id_from_frontmatter = typeof fm.id === 'string' ? fm.id : undefined;
  const fm_date = normalize_date(fm.date);
  const folder_slug =
    id_from_frontmatter && /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(id_from_frontmatter)
      ? id_from_frontmatter
      : dated_slug(flat_base, fm_date);
  // 2.3.0 named folders after the raw basename; keep finding those.
  const legacy_slug =
    id_from_frontmatter && /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(id_from_frontmatter)
      ? id_from_frontmatter
      : flat_base;

  // Canonical target: <vault-root>/incidents/<slug>/
  const target_folder = join(vault_root, 'incidents', folder_slug);
  const narrative_path = join(target_folder, 'narrative.md');
  const facts_path = join(target_folder, 'facts.md');
  const evidence_path = join(target_folder, 'evidence');

  // Legacy 2.3.0 location: <source-parent>/<slug>/
  const legacy_target_folder = join(dirname(flat_file_path), legacy_slug);
  const legacy_narrative_path = join(legacy_target_folder, 'narrative.md');

  // Build narrative.md frontmatter — promote/normalize fields, set tier.
  const narrative_frontmatter: Record<string, unknown> = {
    title: fm.title ?? flat_base,
    tier: 'incident-narrative',
    domains: Array.isArray(fm.domains) ? fm.domains : ['incidents'],
    status: typeof fm.status === 'string' ? fm.status : 'active',
    last_updated:
      typeof fm.last_updated === 'string'
        ? fm.last_updated
        : new Date().toISOString().slice(0, 10),
    id: folder_slug,
    // Never a slice of the slug: that wrote `date: incident-2` (#39).
    date:
      derive_date_from_slug(folder_slug) ??
      fm_date ??
      normalize_date(fm.last_updated) ??
      new Date().toISOString().slice(0, 10),
    severity: typeof fm.severity === 'string' ? fm.severity : 'medium',
    resolution_status:
      typeof fm.resolution_status === 'string' ? fm.resolution_status : 'resolved',
    components: Array.isArray(fm.components) ? fm.components : ['unknown'],
  };
  if (Array.isArray(fm.tags)) narrative_frontmatter.tags = fm.tags;

  const narrative_content = matter.stringify(parsed.content, narrative_frontmatter);

  // Build facts.md skeleton.
  const facts_frontmatter: Record<string, unknown> = {
    title: `Facts from ${folder_slug}`,
    tier: 'incident-facts',
    domains: ['incidents'],
    status: 'active',
    last_updated: new Date().toISOString().slice(0, 10),
    incident_id: folder_slug,
    produced: [],
  };
  const facts_content = matter.stringify(
    `\n# Facts from ${folder_slug}\n\n## Produced\n_(No facts extracted yet. Use \`hewtd extract-facts ${folder_slug}/\` to propose facts from the narrative.)_\n`,
    facts_frontmatter
  );

  // Idempotency check (unless --force): check BOTH new and legacy locations
  // for an existing valid migration.
  if (!force) {
    if (existsSync(narrative_path)) {
      return {
        flat_file_path,
        target_folder,
        action: 'already_migrated',
        existing_location: 'new',
        narrative_path,
        facts_path,
        evidence_path,
        narrative_content,
        facts_content,
      };
    }
    if (existsSync(legacy_narrative_path)) {
      return {
        flat_file_path,
        target_folder,
        action: 'already_migrated',
        existing_location: 'legacy',
        narrative_path: legacy_narrative_path,
        facts_path: join(legacy_target_folder, 'facts.md'),
        evidence_path: join(legacy_target_folder, 'evidence'),
        narrative_content,
        facts_content,
      };
    }
  }

  if (dry_run) {
    return {
      flat_file_path,
      target_folder,
      action: 'dry_run',
      narrative_path,
      facts_path,
      evidence_path,
      narrative_content,
      facts_content,
    };
  }

  // Ensure the canonical parent (<vault>/incidents/) exists. Generator
  // already handles a missing dir; we should too.
  await mkdir(evidence_path, { recursive: true }); // also creates targetFolder
  await writeFile(narrative_path, narrative_content, 'utf-8');
  await writeFile(facts_path, facts_content, 'utf-8');
  // Move the flat file to a `.migrated` extension so consumers don't read it
  // accidentally. Preserves the original for rollback.
  await rename(flat_file_path, `${flat_file_path}.migrated`);

  return {
    flat_file_path,
    target_folder,
    action: 'migrated',
    narrative_path,
    facts_path,
    evidence_path,
    narrative_content,
    facts_content,
  };
}

function derive_date_from_slug(slug: string): string | undefined {
  const m = slug.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : undefined;
}

/**
 * `<prefix>-YYYY-MM-DD-<rest>` → `YYYY-MM-DD-<rest>` (the prefix is dropped,
 * or kept as the slug when nothing follows the date). An undated name gets
 * `fallbackDate` prepended when one is known, else stays as-is.
 */
function dated_slug(name: string, fallback_date: string | undefined): string {
  const m = name.match(/^(.*?)-?(\d{4}-\d{2}-\d{2})-?(.*)$/);
  if (m) {
    const [, prefix, date, rest] = m;
    const slug = rest || prefix;
    return slug ? `${date}-${slug}` : date!;
  }
  return fallback_date ? `${fallback_date}-${name}` : name;
}

/** YYYY-MM-DD from a string or a js-yaml Date, else undefined. */
function normalize_date(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return undefined;
}
