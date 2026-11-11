/** Masked report for `reconcile --gaps` (#66): .hewtd/reconcile/gaps-report-<date>.md. Writes nothing in the docs tree. */
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { SecretsConfig } from '../../utils/config.js';
import type { GapsClassification } from './gaps.js';
import { resolve_review_dir } from './review.js';
import { validate_no_secrets } from './secrets.js';

export function render_gaps_report(classification: GapsClassification, config: SecretsConfig, date = new Date().toISOString().slice(0, 10)): string {
  const lines: string[] = [`# Search gaps report ${date}`, '', 'Nothing in the docs tree was changed. Secret-shaped queries are dropped and never shown.', ''];
  const format_count_suffix = (count: number | undefined): string => (count && count > 1 ? ` (x${count})` : '');
  lines.push(`## user_phrase proposals (${classification.proposals.length} docs)`, '');
  if (!classification.proposals.length) lines.push('None.', '');
  for (const proposal of classification.proposals) {
    lines.push(`### ${proposal.doc}`, '', ...proposal.accepted.map((a) => `- ${a.query}${format_count_suffix(a.count)}`), '');
    if (proposal.existing.length) lines.push(`Already has ${proposal.existing.length} phrase(s) (they count toward the cap).`, '');
  }
  lines.push(`## New-doc candidates (${classification.candidates.length})`, '', 'Never created automatically: write the doc, then `hewtd integrate` records its sources.', '');
  if (!classification.candidates.length) lines.push('None.', '');
  for (const candidate of classification.candidates) lines.push(`- ${candidate.query}${format_count_suffix(candidate.count)}${candidate.domain ? ` - suggested domain: ${candidate.domain}` : ''}`, ...candidate.sources.map((source) => `  - source: ${source}`));
  lines.push('', `## Open questions (${classification.questions.length})`, '', 'No doc used and no code identifier found.', '');
  if (!classification.questions.length) lines.push('None.');
  for (const question of classification.questions) lines.push(`- ${question.query}${format_count_suffix(question.count)}`);
  lines.push('', `## Dropped (${classification.dropped.length})`, '');
  if (!classification.dropped.length) lines.push('None.');
  for (const dropped_phrase of classification.dropped) lines.push(`- ${dropped_phrase.query} - ${dropped_phrase.reason}${dropped_phrase.note ? ` (${dropped_phrase.note})` : ''}`);
  const report_text = lines.join('\n') + '\n';
  validate_no_secrets(report_text, 'the gaps report', config);
  return report_text;
}

export async function write_gaps_report(repo_root: string, text: string, date = new Date().toISOString().slice(0, 10)): Promise<string> {
  const file = join(resolve_review_dir(repo_root), `gaps-report-${date}.md`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}
