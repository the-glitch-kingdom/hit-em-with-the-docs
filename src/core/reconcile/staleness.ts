/**
 * Git staleness signal: commits touching a doc's cited files after the doc's
 * own last content change. A priority signal only, never a verification, and
 * never a source for `last_verified`.
 */
import { execFileSync } from 'child_process';

export type StalenessSignal =
  | { status: 'signal'; commits: number; docCommit: string }
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
    // --follow so a renamed doc keeps its history (works for a single path only)
    const docCommit = git(repoRoot, ['log', '-1', '--follow', '--format=%H', '--', docPath]);
    if (!docCommit) return { status: 'none' };
    const cited = [...new Set(citedPaths)];
    if (cited.length === 0) return { status: 'signal', commits: 0, docCommit };
    const n = git(repoRoot, ['rev-list', '--count', `${docCommit}..HEAD`, '--', ...cited]);
    return { status: 'signal', commits: parseInt(n, 10) || 0, docCommit };
  } catch {
    return { status: 'none' }; // not a git repo / git missing
  }
}
