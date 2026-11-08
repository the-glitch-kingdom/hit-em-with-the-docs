/**
 * Archival candidate DETECTION — advisory and read-only.
 *
 * Surfaces docs that *might* warrant archiving, scored on ranked signals.
 * It never moves anything (the executor does that). Philosophy: a strong
 * explicit signal (`status: deprecated`, `superseded_by`) qualifies on its
 * own; age qualifies only in combination with orphaned (`require_orphaned`),
 * because age alone conflates "unchanged" with "obsolete".
 */

import { execFileSync } from 'child_process';
import { readFile } from 'fs/promises';
import { join, relative } from 'path';
import { find_markdown_files } from '../../utils/glob.js';
import { parse_frontmatter } from '../../utils/frontmatter.js';
import { build_link_graph } from '../links/tracker.js';
import type { ArchiveConfig } from '../../utils/config.js';

export interface ArchiveCandidate {
  file: string; // docs-relative
  score: number;
  reasons: string[];
  signals: {
    deprecated: boolean;
    superseded: boolean;
    orphaned: boolean;
    stale: boolean;
    staleSignalDegraded: boolean; // git unavailable → used last_updated
  };
}

/**
 * Days since the file was last modified, via git (`%cs` = committer date).
 * Returns null when not in a git repo or the file is untracked (no history).
 */
export function git_last_touched_days(
  project_root: string,
  file_abs: string,
  today: Date
): number | null {
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%cs', '--', file_abs],
      { cwd: project_root, stdio: ['ignore', 'pipe', 'ignore'] }
    )
      .toString()
      .trim();
    if (!out) return null;
    const then = new Date(out);
    if (Number.isNaN(then.getTime())) return null;
    return Math.floor((today.getTime() - then.getTime()) / 86_400_000);
  } catch {
    return null;
  }
}

/** Days since `last_updated` frontmatter (fallback recency signal). */
function last_updated_days(value: unknown, today: Date): number | null {
  if (!value) return null;
  const then = new Date(String(value));
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((today.getTime() - then.getTime()) / 86_400_000);
}

export interface FindCandidatesInput {
  docs_path: string;
  project_root: string;
  config: ArchiveConfig;
  /** Override "today" for deterministic tests. */
  today?: Date;
}

export async function find_archive_candidates(
  input: FindCandidatesInput
): Promise<ArchiveCandidate[]> {
  const { docs_path, project_root, config } = input;
  const today = input.today ?? new Date();

  // Inbound-degree map (archive/ already excluded by findMarkdownFiles).
  const graph = await build_link_graph(docs_path);
  const in_degree = new Map<string, number>();
  for (const n of graph.nodes) in_degree.set(n.path.replace(/\\/g, '/'), n.in_degree);

  const files = await find_markdown_files(docs_path);
  const candidates: ArchiveCandidate[] = [];

  for (const file_abs of files) {
    const rel = relative(docs_path, file_abs).replace(/\\/g, '/');
    let raw: string;
    try {
      raw = await readFile(file_abs, 'utf-8');
    } catch {
      continue;
    }
    const { data } = parse_frontmatter<Record<string, unknown>>(raw);

    const reasons: string[] = [];
    let score = 0;

    const deprecated =
      config.honor_status_deprecated && data.status === 'deprecated';
    if (deprecated) {
      score += 100;
      reasons.push('status: deprecated');
    }

    const superseded =
      typeof data.superseded_by === 'string' && data.superseded_by.length > 0;
    if (superseded) {
      score += 80;
      reasons.push(`superseded_by: ${String(data.superseded_by)}`);
    }

    const orphaned = (in_degree.get(rel) ?? 0) === 0;

    // Recency: prefer git-last-touched; fall back to last_updated.
    let age_days = git_last_touched_days(project_root, file_abs, today);
    let degraded = false;
    if (age_days === null) {
      age_days = last_updated_days(data.last_updated, today);
      degraded = true;
    }
    const stale = age_days !== null && age_days > config.candidate_after_days;

    // Age only contributes when orphaned (unless require_orphaned disabled).
    const age_qualifies = stale && (orphaned || !config.require_orphaned);
    if (age_qualifies) {
      if (orphaned) {
        score += 30;
        reasons.push('orphaned (no inbound links)');
      }
      score += 10;
      reasons.push(
        `not modified in ${age_days}d${degraded ? ' (via last_updated — git unavailable)' : ''}`
      );
    }

    const is_candidate = deprecated || superseded || age_qualifies;
    if (is_candidate) {
      candidates.push({
        file: rel,
        score,
        reasons,
        signals: { deprecated, superseded, orphaned, stale, staleSignalDegraded: degraded },
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/** Convenience: resolve absolute docs path for a candidate (test/CLI helper). */
export function candidate_abs_path(docs_path: string, candidate: ArchiveCandidate): string {
  return join(docs_path, candidate.file);
}
