/**
 * Docs targets (#109): what a healthy docs tree looks like, measured over the active docs. Advisory only: like
 * DOCS_UNREVIEWED these never become audit issues, so neither the exit code nor `audit --strict` changes.
 * Each metric reuses the helper that already owns the rule (retrieval's weak-purpose rule, reconcile triage,
 * find_unreviewed_docs, the archive candidates, the ledger's is_reviewed). Held docs (`targets.held`, plus any secret-lane
 * doc for the unreviewed count) are counted apart, never as failures. The retrieval-eval coverage-misses import is
 * deferred until semantic-memory#96 defines an export.
 */
import { readFileSync } from 'fs';
import { basename, join, relative, resolve } from 'path';
import { parse_frontmatter } from '../../utils/frontmatter.js';
import type { PluginConfig } from '../../utils/config.js';
import { is_weak_purpose } from './retrieval.js';
import { find_archive_candidates } from '../archive/candidates.js';
import { compute_content_hash, is_reviewed, load_ledger } from '../reconcile/ledger.js';
import { find_unreviewed_docs, get_verified_day, list_markdown_files, triage_docs } from '../reconcile/triage.js';

export interface TargetRow {
  id: string;
  label: string;
  /** ratio metrics: docs that meet it; count metrics: offenders; flows: flows with an overview doc */
  value: number;
  total: number;
  target: string;
  met: boolean;
  /** held docs, counted apart from the failures */
  held: number;
  /** the command that fixes an unmet target */
  next?: string;
  /** flows without an overview doc */
  missing?: string[];
  /** up to 5 offending docs */
  docs?: string[];
}

export interface TargetsReport {
  rows: TargetRow[];
  note: string;
}

export const TARGETS_NOTE = 'Docs targets met does not mean retrieval targets are met, and the reverse: docs fix grounding and coverage, ranking is measured by the retrieval eval (semantic-memory).';

const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const first_paragraph = (body: string): string => normalize(body.split(/\n\s*\n/).find((block) => block.trim() && !/^\s*#/.test(block)) ?? '');

/** A purpose that is the first body paragraph (or a long prefix of it, or it a prefix of the purpose) is a copy, not a purpose. */
function is_real_purpose(data: Record<string, unknown>, body: string, config: PluginConfig): boolean {
  const purpose = typeof data.purpose === 'string' ? data.purpose.trim() : '';
  if (!purpose || is_weak_purpose(purpose, typeof data.title === 'string' ? data.title : '', config.retrieval)) return false;
  const [purpose_text, paragraph] = [normalize(purpose), first_paragraph(body)];
  return !(paragraph && (purpose_text === paragraph || (purpose_text.length >= 40 && paragraph.startsWith(purpose_text)) || (paragraph.length >= 40 && purpose_text.startsWith(paragraph))));
}

export async function compute_targets(options: { repo_root: string; docs_root: string; config: PluginConfig }): Promise<TargetsReport> {
  const { repo_root, docs_root, config } = options;
  const targets = config.targets;
  const ledger = await load_ledger(resolve(repo_root, config.reconcile.ledger_path));
  const held = new Map(targets.held.map((entry) => [entry.path, entry.reason]));
  const doc_paths = (await list_markdown_files(docs_root)).map((file) => relative(docs_root, file).split('\\').join('/')).filter((doc_path) => !doc_path.startsWith('reports/') && !doc_path.startsWith('drafts/'));
  const docs = doc_paths.flatMap((doc_path) => {
    const text = readFileSync(join(docs_root, doc_path), 'utf-8');
    const { data, content } = parse_frontmatter<Record<string, unknown>>(text);
    return data.generated === true || data.tier === 'plan' ? [] : [{ doc_path, text, data, body: content }];
  });
  const active = docs.map((doc) => doc.doc_path);
  const rows: TargetRow[] = [];
  const sample = (list: string[]): string[] => list.slice(0, 5);
  const ratio_row = (id: string, label: string, min: number, good: string[], next: string): void => {
    const met = active.length === 0 || good.length / active.length >= min;
    const bad = active.filter((doc_path) => !good.includes(doc_path));
    rows.push({ id, label, value: good.length, total: active.length, target: `>= ${Math.round(min * 100)}%`, met, held: 0, ...(!met && { next, docs: sample(bad) }) });
  };
  const count_row = (id: string, label: string, max: number, found: string[], held_total: number, next: string): void => {
    const met = found.length <= max;
    rows.push({ id, label, value: found.length, total: active.length, target: `<= ${max}`, met, held: held_total, ...(!met && { next, docs: sample(found) }) });
  };

  ratio_row('purpose_real', 'real purpose (not a copy of the first paragraph)', targets.purpose_real.min, docs.filter((doc) => is_real_purpose(doc.data, doc.body, config)).map((doc) => doc.doc_path), 'hewtd reconcile --next 10 --write-review');

  const window_start = new Date(Date.now() - config.vault.audit_window_days * 86_400_000).toISOString().slice(0, 10);
  ratio_row('verified', `verified (last_verified within ${config.vault.audit_window_days} days, or reviewed on the current content)`, targets.verified.min,
    docs.filter((doc) => get_verified_day(doc.data) >= window_start && get_verified_day(doc.data) !== '' || is_reviewed(ledger.entries[doc.doc_path], compute_content_hash(doc.text))).map((doc) => doc.doc_path),
    'hewtd reconcile --changed --write-review');

  const triage = await triage_docs({ root: repo_root, docs_root, rels: active, config });
  ratio_row('no_missing_refs', 'docs citing no missing references', targets.no_missing_refs.min, triage.docs.filter((doc) => doc.missing.length === 0).map((doc) => doc.path), 'hewtd reconcile <folder>   (triage lists the missing references per doc)');

  const secret_docs = triage.docs.filter((doc) => doc.lane === 'secret').map((doc) => doc.path);
  count_row('secrets', 'docs holding credential-shaped values', targets.secrets.max, secret_docs.filter((doc_path) => !held.has(doc_path)), secret_docs.filter((doc_path) => held.has(doc_path)).length, 'hewtd reconcile --secrets');

  const unreviewed = await find_unreviewed_docs({ docs_root, ledger, doc_paths: active }); // the same active set as every other target
  const is_held = (doc_path: string): boolean => held.has(doc_path) || secret_docs.includes(doc_path); // a secret-lane doc waits on its secret, not on a review
  count_row('unreviewed', 'docs created or changed since their last review', targets.unreviewed.max, unreviewed.filter((doc_path) => !is_held(doc_path)), unreviewed.filter(is_held).length, 'hewtd reconcile --changed --write-review');

  const candidates = (await find_archive_candidates({ docs_root, repo_root, config: config.archive })).map((candidate) => candidate.file);
  count_row('archive_candidates', 'archive candidates still active', targets.archive_candidates.max, candidates.filter((doc_path) => !held.has(doc_path)), candidates.filter((doc_path) => held.has(doc_path)).length, 'hewtd archive-candidates');

  if (targets.flows.length) {
    const overviews = docs.filter((doc) => doc.data.kind === 'overview').map((doc) => normalize([doc.data.title, basename(doc.doc_path, '.md'), ...(Array.isArray(doc.data.tags) ? doc.data.tags : [])].filter((part): part is string => typeof part === 'string').join(' ')));
    const missing = targets.flows.filter((flow) => !overviews.some((overview) => overview.includes(normalize(flow))));
    rows.push({ id: 'flows', label: 'named flows with an overview doc', value: targets.flows.length - missing.length, total: targets.flows.length, target: 'all', met: missing.length === 0, held: 0, ...(missing.length && { next: 'write a `kind: overview` doc for each missing flow (templates/overview.template.md)', missing }) });
  }
  return { rows, note: TARGETS_NOTE };
}
