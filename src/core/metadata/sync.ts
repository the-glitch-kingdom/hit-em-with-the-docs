import { readFile, writeFile } from 'fs/promises';
import { relative } from 'path';
import { find_markdown_files, is_path_present } from '../../utils/glob.js';
import { join, resolve, sep } from 'path';
import { load_plugin_config, resolve_docs_root } from '../../utils/config.js';
import { parse_frontmatter, with_frontmatter } from '../../utils/frontmatter.js';
import { count_words, format_read_time } from '../../utils/markdown.js';
import { logger } from '../../utils/logger.js';
import {
  validate_partial_metadata,
  get_missing_required_fields,
  compute_metadata_completeness,
  type PartialDocumentMetadata,
} from './schema.js';
import { generate_metadata, merge_metadata, format_date } from './generator.js';

export interface SyncOptions {
  docs_path: string;
  /**
   * Project root the `docs_root` declaration is resolved against. Defaults to
   * `process.cwd()`, which is what the CLI wants; pass it explicitly when the
   * docs tree is not under the current directory.
   */
  project_root?: string;
  dry_run?: boolean;
  fix?: boolean;
  domain?: string;
  silent?: boolean;
}

export interface SyncResult {
  total_files: number;
  valid_files: number;
  fixed_files: number;
  skipped_files: number;
  errors: SyncError[];
  stats: SyncStats;
}

export interface SyncError {
  file: string;
  error: string;
  fixable: boolean;
}

export interface SyncStats {
  total_word_count: number;
  avg_completeness: number;
  by_domain: Record<string, number>;
  by_status: Record<string, number>;
  by_tier: Record<string, number>;
}

/**
 * Sync metadata across all documentation files
 */
export async function sync_metadata(options: SyncOptions): Promise<SyncResult> {
  const {
    docs_path,
    project_root = process.cwd(),
    dry_run = false,
    fix = false,
    domain,
    silent = false,
  } = options;

  const result: SyncResult = {
    total_files: 0,
    valid_files: 0,
    fixed_files: 0,
    skipped_files: 0,
    errors: [],
    stats: {
      total_word_count: 0,
      avg_completeness: 0,
      by_domain: {},
      by_status: {},
      by_tier: {},
    },
  };

  if (!silent) {
    logger.header('Metadata Sync');
    if (dry_run) logger.info('Running in dry-run mode (no changes will be made)');
    if (fix) logger.info('Auto-fix mode enabled');
  }

  // Refuse to WRITE into a directory that is not a hewtd documentation root.
  //
  // `--path` takes any directory, and `syncFile` stamps 16 lines of hewtd
  // frontmatter onto whatever markdown it finds. Pointed at a repo root it
  // rewrote unrelated markdown across the tree — infrastructure notes, test
  // fixtures, loose READMEs (#25). Nothing about the name `metadata-sync`
  // warns of that, and the damage spreads over hundreds of files at once.
  //
  // The root is whatever the project DECLARES (`docs_root`), not whatever looks
  // docs-shaped — see `isDocumentationRoot`.
  //
  // Reads are unaffected: a scan writes nothing, and being able to inspect an
  // unmanaged directory is useful. `--dry-run` is likewise allowed, so the
  // preview of what `--fix` would do still works anywhere.
  if (fix && !dry_run && !(await is_documentation_root(docs_path, project_root))) {
    const message =
      `${docs_path} is outside this project's documentation root, so --fix refuses ` +
      `to write there. --fix stamps frontmatter into every markdown file it finds, ` +
      `and pointed at a source tree it rewrites files that are not documentation. ` +
      `The root is \`docs_root\` in .claude/hit-em-with-the-docs.json (default ` +
      `\`.documentation\`) — set it if your docs live elsewhere, point --path inside ` +
      `it, or drop --fix to scan read-only.`;
    if (!silent) logger.error(message);
    result.errors.push({
      file: relative(project_root, docs_path),
      error: message,
      fixable: false,
    });
    return result;
  }

  // Find all markdown files
  let files = await find_markdown_files(docs_path);

  // Filter by domain if specified
  if (domain) {
    files = files.filter((file) => {
      const doc_path = relative(docs_path, file);
      return doc_path.startsWith(domain + '/') || doc_path.startsWith(domain + '\\');
    });
  }

  // Exclude INDEX.md and REGISTRY.md files (system files)
  files = files.filter((file) => {
    const name = file.split(/[/\\]/).pop() ?? '';
    return !['INDEX.md', 'REGISTRY.md'].includes(name);
  });

  result.total_files = files.length;

  if (!silent) {
    logger.info(`Found ${files.length} documentation files`);
  }

  let completeness_sum = 0;

  for (const file of files) {
    try {
      const sync_result = await sync_file(file, docs_path, dry_run, fix);

      if (sync_result.valid) {
        result.valid_files++;
      }

      if (sync_result.fixed) {
        result.fixed_files++;
      }

      if (sync_result.skipped) {
        result.skipped_files++;
      }

      if (sync_result.error) {
        result.errors.push(sync_result.error);
      }

      // Update stats
      if (sync_result.metadata) {
        const meta = sync_result.metadata;
        completeness_sum += sync_result.completeness;
        result.stats.total_word_count += meta.word_count ?? 0;

        // Track by domain
        const domain = meta.domains?.[0] ?? 'unknown';
        result.stats.by_domain[domain] = (result.stats.by_domain[domain] ?? 0) + 1;

        // Track by status
        const status = meta.status ?? 'unknown';
        result.stats.by_status[status] = (result.stats.by_status[status] ?? 0) + 1;

        // Track by tier
        const tier = meta.tier ?? 'unknown';
        result.stats.by_tier[tier] = (result.stats.by_tier[tier] ?? 0) + 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push({
        file: relative(docs_path, file),
        error: message,
        fixable: false,
      });
    }
  }

  // Calculate average completeness
  result.stats.avg_completeness =
    files.length > 0 ? completeness_sum / files.length : 0;

  if (!silent) {
    logger.newline();
    logger.success(`Sync complete!`);
    logger.info(`Valid: ${result.valid_files}/${result.total_files}`);
    if (result.fixed_files > 0) {
      logger.info(`Fixed: ${result.fixed_files}`);
    }
    if (result.errors.length > 0) {
      logger.warn(`Errors: ${result.errors.length}`);
    }
    logger.info(`Avg completeness: ${result.stats.avg_completeness.toFixed(1)}%`);
  }

  return result;
}

/**
 * Is this path the project's documentation root, or inside it?
 *
 * Answered from what the project *declares* (`docs_root` in
 * `.claude/hit-em-with-the-docs.json`, default `.documentation`) rather than by
 * sniffing the directory's contents. The distinction matters: a content sniff
 * asks "does this look like a docs tree?", which any repository with a
 * top-level `api/` or `testing/` folder can accidentally satisfy. A declaration
 * asks "is this the tree this project said its documentation lives in", which
 * nothing satisfies by accident.
 *
 * The `INDEX.md` fallback covers a tree scaffolded somewhere other than the
 * declared root — `hewtd init -p docs` and then `metadata-sync -p docs`. hewtd
 * writes that file, so its presence is a positive marker rather than a guess; a
 * source tree does not have one at its root.
 */
async function is_documentation_root(docs_path: string, project_root: string): Promise<boolean> {
  const declared = resolve_docs_root(project_root, await load_plugin_config(project_root));

  const target = resolve(docs_path);
  if (target === declared || target.startsWith(declared + sep)) return true;

  return is_path_present(join(docs_path, 'INDEX.md'));
}

interface FileSyncResult {
  valid: boolean;
  fixed: boolean;
  skipped: boolean;
  completeness: number;
  metadata?: PartialDocumentMetadata;
  error?: SyncError;
}

/**
 * Sync metadata for a single file
 */
async function sync_file(
  file_path: string,
  docs_path: string,
  dry_run: boolean,
  fix: boolean
): Promise<FileSyncResult> {
  const result: FileSyncResult = {
    valid: false,
    fixed: false,
    skipped: false,
    completeness: 0,
  };

  const content = await readFile(file_path, 'utf-8');
  const { data, content: body } = parse_frontmatter<PartialDocumentMetadata>(content);

  // Validate existing metadata
  const validation = validate_partial_metadata(data);
  const missing_required = get_missing_required_fields(data as Record<string, unknown>);
  result.completeness = compute_metadata_completeness(data as Record<string, unknown>);

  // Check if file is valid
  if (validation.valid && missing_required.length === 0) {
    result.valid = true;
    result.metadata = data;

    // Still update auto-generated fields if fix mode
    if (fix) {
      const updated = with_auto_fields(data, body);
      if (JSON.stringify(updated) !== JSON.stringify(data)) {
        if (!dry_run) {
          const new_content = with_frontmatter(content, updated as Record<string, unknown>);
          await writeFile(file_path, new_content, 'utf-8');
        }
        result.fixed = true;
        result.metadata = updated;
      }
    }

    return result;
  }

  // File has issues
  if (!fix) {
    result.error = {
      file: relative(docs_path, file_path),
      error: `Missing required fields: ${missing_required.join(', ')}`,
      fixable: true,
    };
    return result;
  }

  // Fix mode: generate missing metadata
  const generated = generate_metadata({
    file_path,
    content,
    docs_root: docs_path,
    existing_metadata: data,
  });

  const merged = normalize_date_fields(merge_metadata(data, generated));
  result.metadata = merged;

  if (!dry_run) {
    const new_content = with_frontmatter(content, merged as unknown as Record<string, unknown>);
    await writeFile(file_path, new_content, 'utf-8');
  }

  result.fixed = true;
  result.valid = true;
  result.completeness = compute_metadata_completeness(merged as unknown as Record<string, unknown>);

  return result;
}

/**
 * Update auto-generated fields
 */
function with_auto_fields(
  metadata: PartialDocumentMetadata,
  content: string
): PartialDocumentMetadata {
  return normalize_date_fields({
    ...metadata,
    word_count: count_words(content),
    estimated_read_time: format_read_time(content),
    last_validated: format_date(new Date()),
  });
}

/** Frontmatter fields the schema types as `YYYY-MM-DD`. */
const DATE_FIELDS = [
  'last_updated',
  'last_validated',
  'last_verified',
  'archived_on',
  'date',
] as const;

/**
 * Truncate full ISO timestamps in date fields to `YYYY-MM-DD` on disk.
 *
 * The schema accepts either form, but only `--fix` can settle what the file
 * actually says. Leaving `2026-04-18T00:00:00.000Z` in place meant a doc that
 * validated only via a preprocess step, and read as a different type to any
 * other tool looking at the same frontmatter.
 */
function normalize_date_fields<T extends PartialDocumentMetadata>(metadata: T): T {
  const found = { ...metadata } as Record<string, unknown>;
  for (const field of DATE_FIELDS) {
    const value = found[field];
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      found[field] = value.slice(0, 10);
    }
  }
  return found as T;
}

/**
 * Get sync statistics for a documentation root
 */
export async function load_sync_stats(docs_path: string): Promise<SyncStats> {
  const result = await sync_metadata({
    docs_path,
    dry_run: true,
    fix: false,
    silent: true,
  });

  return result.stats;
}
