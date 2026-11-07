/**
 * Git staleness signal: commits touching a doc's cited files after the doc's
 * own last content change. A priority signal only, never a verification, and
 * never a source for `last_verified`.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { removeFrontmatter } from '../../utils/frontmatter.js';

export type StalenessSignal =
  | { status: 'signal'; commits: number; docCommit: string; docDate: string }
  | { status: 'none' } // doc not in git (new/uncommitted) or no git repo
  | { status: 'unknown'; warning: string }; // shallow clone: history is incomplete

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

const MAX_WALK = 50;

const bodyOf = (text: string): string => {
  try {
    return removeFrontmatter(text).trim();
  } catch {
    return text.trim(); // unparsable frontmatter: compare the whole file
  }
};

/**
 * The commit where the doc's body (frontmatter stripped) last changed, so
 * frontmatter-only commits do not reset staleness. Walks newest first and stops
 * at the first commit whose body differs from the current one; capped at
 * MAX_WALK commits (then the oldest one examined). Null if the doc has no history.
 */
export function bodyChange(
  repoRoot: string,
  docPath: string
): { commit: string; date: string } | null {
  // --follow so a renamed doc keeps its history (works for a single path only)
  const out = git(repoRoot, [
    'log', '--follow', '--name-only', `-n${MAX_WALK}`, '--format=%x00%H%x09%cI', '--', docPath,
  ]);
  const commits = out
    .split('\0')
    .filter(Boolean)
    .map((r) => {
      const [head = '', ...rest] = r.split('\n');
      const [sha = '', date = ''] = head.split('\t');
      return { sha, date, path: rest.find((l) => l.trim())?.trim() ?? docPath };
    });
  const first = commits[0];
  if (!first) return null;
  let current: string;
  try {
    current = bodyOf(readFileSync(join(repoRoot, docPath), 'utf-8'));
  } catch {
    return { commit: first.sha, date: first.date };
  }
  // shortcut: an uncommitted body edit matches no commit, so it falls back to the newest commit
  let hit = first;
  for (const c of commits) {
    let body: string;
    try {
      body = bodyOf(git(repoRoot, ['show', `${c.sha}:${c.path}`]));
    } catch {
      break;
    }
    if (body !== current) break;
    hit = c;
  }
  return { commit: hit.sha, date: hit.date };
}

/**
 * @param docPath repo-relative path of the doc
 * @param citedPaths repo-relative paths it cites (one rev-list call for all of them)
 */
export function stalenessSignal(
  repoRoot: string,
  docPath: string,
  citedPaths: string[]
): StalenessSignal {
  try {
    if (git(repoRoot, ['rev-parse', '--is-shallow-repository']) === 'true') {
      return {
        status: 'unknown',
        warning: 'shallow clone: git history is incomplete, staleness unknown (fetch full history)',
      };
    }
    const change = bodyChange(repoRoot, docPath);
    if (!change) return { status: 'none' };
    const { commit: docCommit, date: docDate } = change;
    const cited = [...new Set(citedPaths)];
    if (cited.length === 0) return { status: 'signal', commits: 0, docCommit, docDate };
    const n = git(repoRoot, ['rev-list', '--count', `${docCommit}..HEAD`, '--', ...cited]);
    return { status: 'signal', commits: parseInt(n, 10) || 0, docCommit, docDate };
  } catch {
    return { status: 'none' }; // not a git repo / git missing
  }
}
