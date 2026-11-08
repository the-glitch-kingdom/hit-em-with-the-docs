/** Masked report for `reconcile --gaps` (#66): .hewtd/reconcile/gaps-report-<date>.md. Writes nothing in the docs tree. */
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { SecretsConfig } from '../../utils/config.js';
import type { GapsClassification } from './gaps.js';
import { assertNoSecrets } from './secrets.js';

export function renderGapsReport(c: GapsClassification, cfg: SecretsConfig, date = new Date().toISOString().slice(0, 10)): string {
  const L: string[] = [`# Search gaps report ${date}`, '', 'Nothing in the docs tree was changed. Secret-shaped queries are dropped and never shown.', ''];
  const n = (x: number | undefined): string => (x && x > 1 ? ` (x${x})` : '');
  L.push(`## user_phrase proposals (${c.proposals.length} docs)`, '');
  if (!c.proposals.length) L.push('None.', '');
  for (const p of c.proposals) {
    L.push(`### ${p.doc}`, '', ...p.accepted.map((a) => `- ${a.query}${n(a.count)}`), '');
    if (p.existing.length) L.push(`Already has ${p.existing.length} phrase(s) (they count toward the cap).`, '');
  }
  L.push(`## New-doc candidates (${c.candidates.length})`, '', 'Never created automatically: write the doc, then `hewtd integrate` records its sources.', '');
  if (!c.candidates.length) L.push('None.', '');
  for (const x of c.candidates) L.push(`- ${x.query}${n(x.count)}${x.domain ? ` - suggested domain: ${x.domain}` : ''}`, ...x.sources.map((s) => `  - source: ${s}`));
  L.push('', `## Open questions (${c.questions.length})`, '', 'No doc used and no code identifier found.', '');
  if (!c.questions.length) L.push('None.');
  for (const q of c.questions) L.push(`- ${q.query}${n(q.count)}`);
  L.push('', `## Dropped (${c.dropped.length})`, '');
  if (!c.dropped.length) L.push('None.');
  for (const d of c.dropped) L.push(`- ${d.query} - ${d.reason}${d.note ? ` (${d.note})` : ''}`);
  const text = L.join('\n') + '\n';
  assertNoSecrets(text, 'the gaps report', cfg);
  return text;
}

export async function writeGapsReport(root: string, text: string, date = new Date().toISOString().slice(0, 10)): Promise<string> {
  const file = join(root, '.hewtd/reconcile', `gaps-report-${date}.md`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}
