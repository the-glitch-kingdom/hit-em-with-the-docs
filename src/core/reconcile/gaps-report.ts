/** Masked report for `reconcile --gaps` (#66): .hewtd/reconcile/gaps-report-<date>.md. Writes nothing in the docs tree. */
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { SecretsConfig } from '../../utils/config.js';
import type { GapsClassification } from './gaps.js';
import type { CoveragePlan } from '../coverage/plan.js';
import { resolve_review_dir } from './review.js';
import { validate_no_secrets } from './secrets.js';

export function render_gaps_report(classification: GapsClassification, config: SecretsConfig, date = new Date().toISOString().slice(0, 10), coverage?: CoveragePlan, warnings: string[] = []): string {
  const lines: string[] = [`# Search gaps report ${date}`, '', 'Nothing in the docs tree was changed. Secret-shaped queries are dropped and never shown.', ''];
  const format_count_suffix = (count: number | undefined): string => (count && count > 1 ? ` (x${count})` : '');
  if (warnings.length) lines.push('## Warnings', '', ...warnings.map((warning) => `- ${warning}`), '');
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
  if (coverage) lines.push(...render_coverage_section(coverage));
  if (classification.held_back?.length) lines.push('', '### needs a human: every facet withheld', '', 'Questions whose every facet the security gate withheld. Unit names and rule names only:', ...classification.held_back.map((unit) => `- ${unit.keys.join(', ')}: ${unit.reason}`));
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

/** Coverage misses (#113): one block per proposal, then what was held back and why. Facets are shown as given (regex source); located code as file:line only. */
function render_coverage_section(coverage: CoveragePlan): string[] {
  const lines: string[] = ['', `## Coverage misses (${coverage.proposals.length} proposals)`, '', 'Per miss: extend <doc> (missing facets listed), new doc (domain, sources), or covered (check ranking). Misses sharing a doc or source are one proposal. Drafts, where allowed, are unticked review entries; nothing lands without --apply.', ''];
  for (const proposal of coverage.proposals) {
    const head = proposal.kind === 'extend' ? `extend ${proposal.doc}` : proposal.kind === 'new' ? `new doc${proposal.domain ? ` in ${proposal.domain}` : ''}` : proposal.kind === 'covered' ? `covered: check ranking (${proposal.doc})` : 'instruction file only: search cannot reach it';
    lines.push(`### ${head}${proposal.blind ? ' [blind]' : ''}`, '', 'Closes:', ...proposal.closes.map((closed) => `- ${closed.key}: ${closed.query}${closed.count > 1 ? ` (x${closed.count})` : ''}`));
    if (proposal.missing_facets.length && proposal.kind !== 'covered') lines.push('', 'Missing facets:', ...proposal.missing_facets.map((facet) => `- \`${facet}\``));
    if (proposal.withheld_facets) lines.push('', `${proposal.withheld_facets} facet(s) withheld`);
    if (proposal.sources.length) lines.push('', 'Located in code:', ...proposal.sources.map((found) => `- ${found.file}:${found.line}`));
    if (proposal.instruction_files.length) lines.push('', `Found only in: ${proposal.instruction_files.join(', ')}`);
    if (proposal.cited_by.length) lines.push('', `Already cited by: ${proposal.cited_by.join(', ')}`);
    for (const reference of proposal.generated_reference) lines.push('', `Generated reference: ${reference.suggestion}`);
    for (const note of proposal.notes) lines.push('', `Note: ${note}`);
    lines.push('');
  }
  const { drafts } = coverage;
  if (drafts.needs_human.length) lines.push('### security: needs a human', '', 'A located line that is a security check (secret compared, hashed or signed; permission or role check; policy or firewall rule) is never drafted, and a fact only on a credential line is withheld. Unit names and the reason only:', ...drafts.needs_human.map((unit) => `- ${unit.keys.join(', ')}${unit.source_files.length ? ` (${unit.source_files.join(', ')})` : ''}: ${unit.reason}`), '');
  if (drafts.security_adjacent?.length) lines.push('### security-adjacent: judge carefully', '', 'These mention a security topic word, but no located line is a security check, so they are drafted. The judge states no values and no internals of any check. Unit names and the word only:', ...drafts.security_adjacent.map((unit) => `- ${unit.keys.join(', ')}: \`${unit.word}\` in ${unit.where}`), '');
  if (drafts.blocked.length) lines.push('### blocked by the security gate', '', ...drafts.blocked.map((unit) => `- ${unit.keys.join(', ')}: ${unit.reason}`), '');
  if (drafts.skipped.length) lines.push('### not drafted', '', ...drafts.skipped.map((unit) => `- ${unit.keys.join(', ')}: ${unit.reason}`), '');
  lines.push(`Drafts written to the review file: ${drafts.entries.length} (only with --write-review).`);
  return lines;
}
