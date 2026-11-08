import { glob as glob_lib } from 'glob';
import { resolve, relative, dirname, basename, extname, join } from 'path';
import { stat, readdir } from 'fs/promises';
import { existsSync } from 'fs';

export interface GlobOptions {
  // eslint-disable-next-line id-denylist -- glob/child_process option name
  cwd?: string;
  absolute?: boolean;
  ignore?: string[];
  dot?: boolean;
}

/**
 * Find files matching a glob pattern
 */
export async function list_glob_matches(
  pattern: string,
  options: GlobOptions = {}
): Promise<string[]> {
  const {
    cwd: working_dir = process.cwd(),
    absolute = false,
    ignore = ['node_modules/**', 'dist/**', '.git/**'],
    dot = false,
  } = options;

  const matches = await glob_lib(pattern, {
    // eslint-disable-next-line id-denylist -- glob/child_process option name
    cwd: working_dir,
    absolute,
    ignore,
    dot,
    nodir: true,
  });

  return matches;
}

/**
 * Reserved documentation subdirectory for DEPRECATED docs.
 *
 * **Archived content is referenceable, never concrete.** A link *into* the
 * archive still resolves — link-check validates targets by file existence, so
 * history stays reachable. But nothing under an `archive/` folder is part of
 * the active corpus: it is not indexed, not audited, not metadata-validated,
 * not dup-checked, and never counted. It is what the docs *used* to say, and it
 * is never evidence of what is true now.
 *
 * The exclusion applies at **any depth** — `<docs>/archive/` and
 * `<docs>/features/archive/` alike. Before 2.8.0 the ignore glob was anchored
 * at the docs root, so a nested `archive/` was still scanned and validated
 * (while 2.7.1's indexer correctly skipped it) — archived docs could raise
 * audit errors and stale-metadata warnings for content nobody was supposed to
 * be reading.
 */
export const ARCHIVE_DIR = 'archive';

/**
 * Reserved documentation subdirectory for hewtd's OWN generated output.
 *
 * `audit`, `report`, and `maintain` write `audit-*`, `links-*`, `health-*` and
 * `maintenance-*` files into `<docs>/reports/`. Scanning them made the tool
 * grade its own artifacts: each report carries `domains: [root]` and an ISO
 * timestamp in its filename, so each one raised a `metadata-domain` and a
 * `naming-convention` warning, and the headline health score fell the more
 * often maintenance was run. A team running `maintain` weekly watched its score
 * drop for doing maintenance, which makes the number useless as a trend line.
 *
 * Excluded at the docs root ONLY — `<docs>/reports/`, which is the sole place
 * hewtd writes them (`join(docsPath, 'reports')`). A `features/reports/` folder
 * is somebody's documentation *about* reports and stays audited; assuming the
 * name implied the artifact is the mistake #19 was about.
 */
export const REPORTS_DIR = 'reports';

/** Glob ignores always applied to documentation scans. */
const DOC_SCAN_IGNORE = [
  'node_modules/**',
  'dist/**',
  '.git/**',
  `${ARCHIVE_DIR}/**`,
  `**/${ARCHIVE_DIR}/**`,
  `${REPORTS_DIR}/**`,
];

/**
 * Find all markdown files in a directory.
 *
 * Used exclusively as the documentation-corpus scanner, so it always skips the
 * reserved `archive/` subtree (deprecated docs, at any depth) and the root
 * `reports/` subtree (hewtd's own generated output), in addition to the
 * standard build/vcs ignores. Callers may pass extra `ignore` patterns; they
 * are merged, never override these exclusions.
 */
export async function find_markdown_files(
  dir_path: string,
  options: Omit<GlobOptions, 'absolute'> = {}
): Promise<string[]> {
  const { ignore: extra_ignore = [], ...rest } = options;
  return list_glob_matches('**/*.md', {
    ...rest,
    ignore: [...DOC_SCAN_IGNORE, ...extra_ignore],
    // eslint-disable-next-line id-denylist -- glob/child_process option name
    cwd: dir_path,
    absolute: true,
  });
}

/**
 * Check if a path exists
 */
export async function is_path_present(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a path exists (sync)
 */
export function is_path_present_sync(path: string): boolean {
  return existsSync(path);
}

/**
 * Check if a path is a directory
 */
export async function is_directory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if a path is a file
 */
export async function is_file(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Get all subdirectories in a directory
 */
export async function list_subdirectories(dir_path: string): Promise<string[]> {
  try {
    const entries = await readdir(dir_path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir_path, entry.name));
  } catch {
    return [];
  }
}

/**
 * Resolve a path relative to a base
 */
export function resolve_path(base: string, relative_path: string): string {
  return resolve(base, relative_path);
}

/**
 * Get relative path from base to target
 */
export function get_relative_path(base: string, target: string): string {
  return relative(base, target);
}

/**
 * Get directory name from path
 */
export function get_dirname(path: string): string {
  return dirname(path);
}

/**
 * Get base name from path
 */
export function get_basename(path: string): string {
  return basename(path);
}

/**
 * Get file extension
 */
export function get_extension(path: string): string {
  return extname(path);
}

/**
 * Remove file extension from path
 */
export function strip_extension(path: string): string {
  const extension = extname(path);
  return path.slice(0, -extension.length);
}

/**
 * Normalize path separators
 */
export function normalize_path(path: string): string {
  return path.replace(/\\/g, '/');
}
