/**
 * Git staleness signal: commits touching a doc's cited files after the doc's
 * own last content change. A priority signal only, never a verification, and
 * never a source for `last_verified`.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { remove_frontmatter } from '../../utils/frontmatter.js';

export type StalenessSignal =
  | { status: 'signal'; commits: number; doc_commit: string; doc_date: string }
  | { status: 'none' } // doc not in git (new/uncommitted) or no git repo
  | { status: 'unknown'; warning: string }; // shallow clone: history is incomplete

function run_git(repo_root: string, args: string[]): string {
  return execFileSync('git', args, {
    // eslint-disable-next-line id-denylist -- child_process option name
    cwd: repo_root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

const MAX_WALK = 50;

const get_body = (text: string): string => {
  try {
    return remove_frontmatter(text).trim();
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
export function find_body_change(
  repo_root: string,
  doc_path: string
): { commit: string; date: string } | null {
  // --follow so a renamed doc keeps its history (works for a single path only)
  const log_output = run_git(repo_root, [
    'log', '--follow', '--name-only', `-n${MAX_WALK}`, '--format=%x00%H%x09%cI', '--', doc_path,
  ]);
  const commits = log_output
    .split('\0')
    .filter(Boolean)
    .map((chunk) => {
      const [head = '', ...rest] = chunk.split('\n');
      const [sha = '', date = ''] = head.split('\t');
      return { sha, date, path: rest.find((line) => line.trim())?.trim() ?? doc_path };
    });
  const first = commits[0];
  if (!first) return null;
  let current: string;
  try {
    current = get_body(readFileSync(join(repo_root, doc_path), 'utf-8'));
  } catch {
    return { commit: first.sha, date: first.date };
  }
  // shortcut: an uncommitted body edit matches no commit, so it falls back to the newest commit
  let match = first;
  for (const candidate of commits) {
    let body: string;
    try {
      body = get_body(run_git(repo_root, ['show', `${candidate.sha}:${candidate.path}`]));
    } catch {
      break;
    }
    if (body !== current) break;
    match = candidate;
  }
  return { commit: match.sha, date: match.date };
}

/**
 * @param doc_path repo-relative path of the doc
 * @param cited_paths repo-relative paths it cites (one rev-list call for all of them)
 */
export function find_staleness_signal(
  repo_root: string,
  doc_path: string,
  cited_paths: string[]
): StalenessSignal {
  try {
    if (run_git(repo_root, ['rev-parse', '--is-shallow-repository']) === 'true') {
      return {
        status: 'unknown',
        warning: 'shallow clone: git history is incomplete, staleness unknown (fetch full history)',
      };
    }
    const change = find_body_change(repo_root, doc_path);
    if (!change) return { status: 'none' };
    const { commit: doc_commit, date: doc_date } = change;
    const cited = [...new Set(cited_paths)];
    if (cited.length === 0) return { status: 'signal', commits: 0, doc_commit, doc_date };
    const commit_count = run_git(repo_root, ['rev-list', '--count', `${doc_commit}..HEAD`, '--', ...cited]);
    return { status: 'signal', commits: parseInt(commit_count, 10) || 0, doc_commit, doc_date };
  } catch {
    return { status: 'none' }; // not a git repo / git missing
  }
}

/** Commits in a sibling repo to `paths` since `since` (ISO date of the doc's last body change). 0 if unreadable. */
export function count_sibling_commits(sibling_root: string, since: string, paths: string[]): number {
  if (!paths.length) return 0;
  try {
    return parseInt(run_git(sibling_root, ['rev-list', '--count', `--since=${since}`, 'HEAD', '--', ...paths]), 10) || 0;
  } catch {
    return 0;
  }
}
