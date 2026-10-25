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
import { parseFrontmatter, setFrontmatter } from '../../utils/frontmatter.js';
import { formatDate } from '../metadata/generator.js';
import { regenerateIndexes } from '../../generators/regenerate.js';
import { ARCHIVE_DIR } from '../../utils/glob.js';
import { findInboundLinks, toDocsRelative, type InboundLink } from './links.js';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** True if `projectRoot` is inside a git work tree. */
function isGitRepo(projectRoot: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectRoot,
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
async function moveFile(
  projectRoot: string,
  fromAbs: string,
  toAbs: string
): Promise<'git' | 'fs'> {
  // Both git mv's fallback (fs.rename) and git mv -f replace an existing file.
  if (await exists(toAbs)) throw new Error(`Refusing to overwrite existing file: ${toAbs}`);
  await mkdir(dirname(toAbs), { recursive: true });
  if (isGitRepo(projectRoot)) {
    try {
      execFileSync('git', ['mv', fromAbs, toAbs], {
        cwd: projectRoot,
        stdio: 'ignore',
      });
      return 'git';
    } catch {
      // untracked file (or other git mv refusal) → fall through to fs move
    }
  }
  await rename(fromAbs, toAbs);
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

export async function archiveDoc(
  input: ArchiveDocInput
): Promise<ArchiveDocResult> {
  const { projectRoot, docsPath, reason, force = false, dryRun = false } = input;
  const today = input.today ?? formatDate(new Date());
  const errors: string[] = [];

  const fromRel = toDocsRelative(docsPath, input.file, projectRoot);

  if (!fromRel.endsWith('.md')) {
    errors.push(`Not a markdown file: ${fromRel}`);
    return { ok: false, errors, action: 'rejected', inboundLinks: [] };
  }
  if (fromRel === `${ARCHIVE_DIR}/` || fromRel.startsWith(`${ARCHIVE_DIR}/`)) {
    errors.push(`"${fromRel}" is already under ${ARCHIVE_DIR}/.`);
    return { ok: false, errors, action: 'rejected', inboundLinks: [] };
  }

  const fromAbs = join(docsPath, fromRel);
  if (!(await exists(fromAbs))) {
    errors.push(`File not found: ${fromRel}`);
    return { ok: false, errors, action: 'rejected', inboundLinks: [] };
  }

  const toRel = `${ARCHIVE_DIR}/${fromRel}`;
  const toAbs = join(docsPath, toRel);

  if (await exists(toAbs)) {
    errors.push(
      `Archive target already exists: ${toRel}. Archiving ${fromRel} would overwrite it. ` +
        `Rename one of them first.`
    );
    return { ok: false, errors, action: 'rejected', from: fromRel, to: toRel, inboundLinks: [] };
  }

  // Link guard: refuse by default if active docs link to this doc.
  const inboundLinks = await findInboundLinks(docsPath, fromRel);
  if (inboundLinks.length > 0 && !force && !dryRun) {
    errors.push(
      `${inboundLinks.length} active doc(s) link to ${fromRel}. ` +
        `Fix those links or pass --force.`
    );
    return { ok: false, errors, action: 'blocked', from: fromRel, to: toRel, inboundLinks };
  }

  if (dryRun) {
    return { ok: true, errors, action: 'dry_run', from: fromRel, to: toRel, inboundLinks };
  }

  // Stamp lifecycle metadata, then move (git mv preserves history).
  const raw = await readFile(fromAbs, 'utf-8');
  const { data } = parseFrontmatter<Record<string, unknown>>(raw);
  const stamped: Record<string, unknown> = {
    ...data,
    status: 'archived',
    archived_on: today,
    archived_from: fromRel,
  };
  if (reason) stamped.archived_reason = reason;

  const moveMethod = await moveFile(projectRoot, fromAbs, toAbs);
  await writeFile(toAbs, setFrontmatter(raw, stamped), 'utf-8');
  if (moveMethod === 'git') {
    try {
      execFileSync('git', ['add', toAbs], { cwd: projectRoot, stdio: 'ignore' });
    } catch {
      /* staging is best-effort */
    }
  }

  // Doc left its domain folder → refresh indexes so it drops out.
  await regenerateIndexes({ docsPath, silent: true });

  return { ok: true, errors, action: 'archived', from: fromRel, to: toRel, moveMethod, inboundLinks };
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

export async function unarchiveDoc(
  input: UnarchiveDocInput
): Promise<UnarchiveDocResult> {
  const { projectRoot, docsPath, dryRun = false } = input;
  const errors: string[] = [];

  const fromRel = toDocsRelative(docsPath, input.file, projectRoot);
  if (!fromRel.startsWith(`${ARCHIVE_DIR}/`)) {
    errors.push(`"${fromRel}" is not under ${ARCHIVE_DIR}/ — nothing to unarchive.`);
    return { ok: false, errors, action: 'rejected' };
  }

  const fromAbs = join(docsPath, fromRel);
  if (!(await exists(fromAbs))) {
    errors.push(`File not found: ${fromRel}`);
    return { ok: false, errors, action: 'rejected' };
  }

  const raw = await readFile(fromAbs, 'utf-8');
  const { data } = parseFrontmatter<Record<string, unknown>>(raw);

  // Restore path: prefer the recorded archived_from, else strip the archive/ prefix.
  const toRel =
    typeof data.archived_from === 'string' && data.archived_from.length > 0
      ? data.archived_from
      : fromRel.slice(`${ARCHIVE_DIR}/`.length);
  const toAbs = join(docsPath, toRel);

  if (await exists(toAbs)) {
    errors.push(`Restore target already exists: ${toRel}. Move or remove it first.`);
    return { ok: false, errors, action: 'rejected', from: fromRel, to: toRel };
  }

  if (dryRun) {
    return { ok: true, errors, action: 'dry_run', from: fromRel, to: toRel };
  }

  // Strip the archival stamp, restore to active.
  const restored: Record<string, unknown> = { ...data, status: 'active' };
  delete restored.archived_on;
  delete restored.archived_from;
  delete restored.archived_reason;

  const moveMethod = await moveFile(projectRoot, fromAbs, toAbs);
  await writeFile(toAbs, setFrontmatter(raw, restored), 'utf-8');
  if (moveMethod === 'git') {
    try {
      execFileSync('git', ['add', toAbs], { cwd: projectRoot, stdio: 'ignore' });
    } catch {
      /* best-effort */
    }
  }

  await regenerateIndexes({ docsPath, silent: true });

  return { ok: true, errors, action: 'unarchived', from: fromRel, to: toRel, moveMethod };
}
