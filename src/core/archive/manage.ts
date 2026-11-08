/**
 * Archival executor: the deterministic WRITER behind `hewtd archive` /
 * `hewtd unarchive`.
 *
 * Moves a doc into `archive/<domain-subpath>/…` (and back), preserving git
 * history via `git mv` where possible, stamping reversible lifecycle metadata,
 * and regenerating indexes so the doc cleanly leaves (or rejoins) the active
 * corpus. Non-destructive and reversible by design: `archived_from` records the
 * exact restore path.
 */

import { execFileSync } from 'child_process';
import { mkdir, readFile, writeFile, rename, stat } from 'fs/promises';
import { dirname, join } from 'path';
import { parse_frontmatter, set_frontmatter } from '../../utils/frontmatter.js';
import { format_date } from '../metadata/generator.js';
import { regenerate_indexes } from '../../generators/regenerate.js';
import { ARCHIVE_DIR } from '../../utils/glob.js';
import { find_inbound_links, to_docs_relative, type InboundLink } from './links.js';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** True if `projectRoot` is inside a git work tree. */
function is_git_repo(project_root: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: project_root,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Move a file, preferring `git mv` (history-preserving) and falling back to a
 * plain fs rename when not in a git repo or the file is untracked. Returns the
 * method used.
 */
async function move_file(
  project_root: string,
  from_abs: string,
  to_abs: string
): Promise<'git' | 'fs'> {
  // Both git mv's fallback (fs.rename) and git mv -f replace an existing file.
  if (await exists(to_abs)) throw new Error(`Refusing to overwrite existing file: ${to_abs}`);
  await mkdir(dirname(to_abs), { recursive: true });
  if (is_git_repo(project_root)) {
    try {
      execFileSync('git', ['mv', from_abs, to_abs], {
        cwd: project_root,
        stdio: 'ignore',
      });
      return 'git';
    } catch {
      // untracked file (or other git mv refusal) → fall through to fs move
    }
  }
  await rename(from_abs, to_abs);
  return 'fs';
}

// ---------------------------------------------------------------------------
// archive
// ---------------------------------------------------------------------------

export interface ArchiveDocInput {
  projectRoot: string;
  docsPath: string;
  /** Doc to archive — docs-relative (e.g. `api/old.md`) or absolute. */
  file: string;
  reason?: string;
  force?: boolean;
  dryRun?: boolean;
  /** Override "today" (YYYY-MM-DD) for deterministic tests. */
  today?: string;
}

export interface ArchiveDocResult {
  ok: boolean;
  errors: string[];
  action: 'archived' | 'dry_run' | 'blocked' | 'rejected';
  from?: string;
  to?: string;
  moveMethod?: 'git' | 'fs';
  /** Active docs that link to the target (the link guard). */
  inboundLinks: InboundLink[];
}

export async function archive_doc(
  input: ArchiveDocInput
): Promise<ArchiveDocResult> {
  const { projectRoot: project_root, docsPath: docs_path, reason, force = false, dryRun: dry_run = false } = input;
  const today = input.today ?? format_date(new Date());
  const errors: string[] = [];

  const from_rel = to_docs_relative(docs_path, input.file, project_root);

  if (!from_rel.endsWith('.md')) {
    errors.push(`Not a markdown file: ${from_rel}`);
    return { ok: false, errors, action: 'rejected', inboundLinks: [] };
  }
  if (from_rel === `${ARCHIVE_DIR}/` || from_rel.startsWith(`${ARCHIVE_DIR}/`)) {
    errors.push(`"${from_rel}" is already under ${ARCHIVE_DIR}/.`);
    return { ok: false, errors, action: 'rejected', inboundLinks: [] };
  }

  const from_abs = join(docs_path, from_rel);
  if (!(await exists(from_abs))) {
    errors.push(`File not found: ${from_rel}`);
    return { ok: false, errors, action: 'rejected', inboundLinks: [] };
  }

  const to_rel = `${ARCHIVE_DIR}/${from_rel}`;
  const to_abs = join(docs_path, to_rel);

  if (await exists(to_abs)) {
    errors.push(
      `Archive target already exists: ${to_rel}. Archiving ${from_rel} would overwrite it. ` +
        `Rename one of them first.`
    );
    return { ok: false, errors, action: 'rejected', from: from_rel, to: to_rel, inboundLinks: [] };
  }

  // Link guard: refuse by default if active docs link to this doc.
  const inbound_links = await find_inbound_links(docs_path, from_rel);
  if (inbound_links.length > 0 && !force && !dry_run) {
    errors.push(
      `${inbound_links.length} active doc(s) link to ${from_rel}. ` +
        `Fix those links or pass --force.`
    );
    return { ok: false, errors, action: 'blocked', from: from_rel, to: to_rel, inboundLinks: inbound_links };
  }

  if (dry_run) {
    return { ok: true, errors, action: 'dry_run', from: from_rel, to: to_rel, inboundLinks: inbound_links };
  }

  // Stamp lifecycle metadata, then move (git mv preserves history).
  const raw = await readFile(from_abs, 'utf-8');
  const { data } = parse_frontmatter<Record<string, unknown>>(raw);
  const stamped: Record<string, unknown> = {
    ...data,
    status: 'archived',
    archived_on: today,
    archived_from: from_rel,
  };
  if (reason) stamped.archived_reason = reason;

  const move_method = await move_file(project_root, from_abs, to_abs);
  await writeFile(to_abs, set_frontmatter(raw, stamped), 'utf-8');
  if (move_method === 'git') {
    try {
      execFileSync('git', ['add', to_abs], { cwd: project_root, stdio: 'ignore' });
    } catch {
      /* staging is best-effort */
    }
  }

  // Doc left its domain folder → refresh indexes so it drops out.
  await regenerate_indexes({ docsPath: docs_path, silent: true });

  return { ok: true, errors, action: 'archived', from: from_rel, to: to_rel, moveMethod: move_method, inboundLinks: inbound_links };
}

// ---------------------------------------------------------------------------
// unarchive
// ---------------------------------------------------------------------------

export interface UnarchiveDocInput {
  projectRoot: string;
  docsPath: string;
  /** Archived doc — docs-relative (e.g. `archive/api/old.md`) or absolute. */
  file: string;
  dryRun?: boolean;
}

export interface UnarchiveDocResult {
  ok: boolean;
  errors: string[];
  action: 'unarchived' | 'dry_run' | 'rejected';
  from?: string;
  to?: string;
  moveMethod?: 'git' | 'fs';
}

export async function unarchive_doc(
  input: UnarchiveDocInput
): Promise<UnarchiveDocResult> {
  const { projectRoot: project_root, docsPath: docs_path, dryRun: dry_run = false } = input;
  const errors: string[] = [];

  const from_rel = to_docs_relative(docs_path, input.file, project_root);
  if (!from_rel.startsWith(`${ARCHIVE_DIR}/`)) {
    errors.push(`"${from_rel}" is not under ${ARCHIVE_DIR}/ — nothing to unarchive.`);
    return { ok: false, errors, action: 'rejected' };
  }

  const from_abs = join(docs_path, from_rel);
  if (!(await exists(from_abs))) {
    errors.push(`File not found: ${from_rel}`);
    return { ok: false, errors, action: 'rejected' };
  }

  const raw = await readFile(from_abs, 'utf-8');
  const { data } = parse_frontmatter<Record<string, unknown>>(raw);

  // Restore path: prefer the recorded archived_from, else strip the archive/ prefix.
  const to_rel =
    typeof data.archived_from === 'string' && data.archived_from.length > 0
      ? data.archived_from
      : from_rel.slice(`${ARCHIVE_DIR}/`.length);
  const to_abs = join(docs_path, to_rel);

  if (await exists(to_abs)) {
    errors.push(`Restore target already exists: ${to_rel}. Move or remove it first.`);
    return { ok: false, errors, action: 'rejected', from: from_rel, to: to_rel };
  }

  if (dry_run) {
    return { ok: true, errors, action: 'dry_run', from: from_rel, to: to_rel };
  }

  // Strip the archival stamp, restore to active.
  const restored: Record<string, unknown> = { ...data, status: 'active' };
  delete restored.archived_on;
  delete restored.archived_from;
  delete restored.archived_reason;

  const move_method = await move_file(project_root, from_abs, to_abs);
  await writeFile(to_abs, set_frontmatter(raw, restored), 'utf-8');
  if (move_method === 'git') {
    try {
      execFileSync('git', ['add', to_abs], { cwd: project_root, stdio: 'ignore' });
    } catch {
      /* best-effort */
    }
  }

  await regenerate_indexes({ docsPath: docs_path, silent: true });

  return { ok: true, errors, action: 'unarchived', from: from_rel, to: to_rel, moveMethod: move_method };
}
