/**
 * Grounded drafts (#113): turn proposals into unticked reconcile review entries. Nothing here writes a doc;
 * `reconcile --apply` does, after a human ticks the entry.
 *   extend   a `verify` entry with a `patch` on the target doc (appended section) and the located files as `sources`
 *   new      a `create` entry whose `draft` follows templates/doc.template.md
 * Every sentence cites the code it came from (`file`, line N) and names code (identifiers, env/config names);
 * no value is ever read out of a line. One gate (src/core/security/gate.ts) runs before an entry is produced.
 */
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { with_frontmatter } from '../../utils/frontmatter.js';
import type { SecretsConfig } from '../../utils/config.js';
import { compute_content_hash } from '../reconcile/ledger.js';
import type { ReviewEntry } from '../reconcile/review.js';
import { check_credential_text, check_security_gate, is_security_sensitive } from '../security/gate.js';
import type { Proposal } from './merge.js';

export interface DraftResult {
  entries: ReviewEntry[];
  /** Security-sensitive topics: unit names (question keys, source files) only. */
  needs_human: { keys: string[]; source_files: string[] }[];
  /** The gate refused: path:line and a masked length, never a value. */
  blocked: { keys: string[]; reason: string }[];
  skipped: { keys: string[]; reason: string }[];
}

/** A draft cites a handful of lines; more is a sign the facets were too generic to ground one doc. */
export const MAX_SENTENCES = 12;
/** Domain for a new doc when no doc cites nearby code. */
export const FALLBACK_DOMAIN = 'features';

const ENV_NAME = /process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)|os\.environ(?:\.get)?[[(]\s*['"]([A-Z_][A-Z0-9_]*)|getenv\(\s*['"]([A-Z_][A-Z0-9_]*)/;
const DECLARATION = /\b(?:function|def|class|interface|enum|type|const|let|var|fn|func|struct)\s+([A-Za-z_$][\w$]*)/;
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*[:=]/;

/** The name a line declares or reads: an identifier or an env/config name, never what it is set to. */
export function extract_declared_name(line: string): { name: string; verb: 'defined in' | 'read in' } | undefined {
  const env_match = ENV_NAME.exec(line);
  const env_name = env_match?.slice(1).find(Boolean);
  if (env_name) return { name: env_name, verb: 'read in' };
  const name = DECLARATION.exec(line)?.[1] ?? ASSIGNMENT.exec(line)?.[1];
  return name ? { name, verb: 'defined in' } : undefined;
}

const slugify = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 8).join('-').slice(0, 60) || 'topic';
const sentence_case = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

async function build_sentences(repo_root: string, proposal: Proposal, secrets_config: SecretsConfig): Promise<{ sentences: string[] } | { blocked: string }> {
  const lines_of = new Map<string, string[]>();
  const sentences: string[] = [];
  const seen = new Set<string>();
  const cited = [...proposal.sources].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  // a credential on a cited line blocks the whole unit: it is not drafted at all
  for (const found of cited) {
    let lines = lines_of.get(found.file);
    if (!lines) { lines = (await readFile(join(repo_root, found.file), 'utf-8').catch(() => '')).split('\n'); lines_of.set(found.file, lines); }
    const credential = check_credential_text(lines[found.line - 1] ?? '', found.file, secrets_config)[0];
    if (credential) return { blocked: `credential-class content on a cited line: ${found.file}:${found.line} (${credential.rule}, ${credential.masked})` };
  }
  for (const found of cited) {
    const declared = extract_declared_name(lines_of.get(found.file)![found.line - 1] ?? '');
    const text = declared ? `\`${declared.name}\` is ${declared.verb} \`${found.file}\` (line ${found.line}).` : `Related code: \`${found.file}\` (line ${found.line}).`;
    if (seen.has(text)) continue;
    seen.add(text);
    sentences.push(`- ${text}`);
  }
  return { sentences: sentences.slice(0, MAX_SENTENCES) };
}

/** Last lines of the body, unique in it: the anchor an appended section hangs on. */
function find_anchor(raw_text: string): string | undefined {
  const body = raw_text.slice(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw_text)?.[0].length ?? 0);
  const lines = body.split('\n').map((line) => line.replace(/\s+$/, '')).filter((line) => line.trim());
  const candidates = [1, 2, 3].filter((count) => count <= lines.length).map((count) => lines.slice(-count).join('\n'));
  const heading = lines.find((line) => /^#{1,6}\s/.test(line));
  if (heading) candidates.push(heading);
  return candidates.find((anchor) => body.split(anchor).length === 2);
}

export async function build_drafts(options: { repo_root: string; docs_root: string; proposals: Proposal[]; secrets_config: SecretsConfig; include_blind?: boolean; today: string }): Promise<DraftResult> {
  const { repo_root, docs_root, secrets_config } = options;
  const result: DraftResult = { entries: [], needs_human: [], blocked: [], skipped: [] };
  const taken = new Set<string>();
  for (const proposal of options.proposals) {
    const keys = proposal.closes.map((closed) => closed.key);
    const skip = (reason: string): void => void result.skipped.push({ keys, reason });
    if (proposal.kind === 'covered') { skip(`covered by ${proposal.doc}: check ranking and phrasing, nothing to draft`); continue; }
    if (proposal.kind === 'instruction-only') { skip(`the fact is only in agent instruction files (${proposal.instruction_files.join(', ')}): move it into an indexed doc`); continue; }
    if (proposal.blind && !options.include_blind) { skip('blind entry: drafting from it would spoil the blind set (pass --include-blind to draft anyway)'); continue; }
    if ([...proposal.closes.map((closed) => closed.query), ...proposal.missing_facets, ...proposal.source_files].some(is_security_sensitive)) { result.needs_human.push({ keys, source_files: proposal.source_files }); continue; }
    if (!proposal.sources.length) { skip('nothing located in code: no file:line to ground a draft'); continue; }
    if (proposal.generated_reference.length) { skip(`generated reference suggested (${proposal.generated_reference.map((list) => `${list.kind} in ${list.file}`).join(', ')}): generate it instead of writing prose`); continue; }
    const built = await build_sentences(repo_root, proposal, secrets_config);
    if ('blocked' in built) { result.blocked.push({ keys, reason: built.blocked }); continue; }
    if (!built.sentences.length) { skip('no citable line'); continue; }
    const reasons = [`coverage miss: ${keys.join(', ')}`];

    if (proposal.kind === 'extend') {
      const abs_path = join(docs_root, proposal.doc!);
      const raw_text = await readFile(abs_path, 'utf-8');
      const anchor = find_anchor(raw_text);
      if (!anchor) { skip(`no unique anchor in ${proposal.doc} for a patch: add the details by hand`); continue; }
      const added = `\n\n## Details from the code (unreviewed)\n\n${built.sentences.join('\n')}`;
      const gate = check_security_gate(added, proposal.doc!, secrets_config)[0];
      if (gate) { result.blocked.push({ keys, reason: `security gate: ${proposal.doc}:${gate.line} (${gate.rule}, ${gate.masked})` }); continue; }
      result.entries.push({ path: proposal.doc!, content_hash: compute_content_hash(raw_text), verdict: 'verify', patch: [{ old: anchor, new: anchor + added }], sources: proposal.source_files, reasons });
      continue;
    }

    // new doc: never overwrite an existing path or another draft's
    const domain = proposal.domain ?? FALLBACK_DOMAIN;
    const title = sentence_case(proposal.closes[0]!.query);
    const stem = slugify(proposal.closes[0]!.query);
    let path = `${domain}/${stem}.md`;
    for (let copy = 2; existsSync(join(docs_root, path)) || taken.has(path); copy++) path = `${domain}/${stem}-${copy}.md`;
    taken.add(path);
    const body = `# ${title}\n\nDrafted from code that search questions could not be answered from; every statement cites the code it came from. Review before accepting.\n\n## What the code defines\n\n${built.sentences.join('\n')}\n`;
    const symptoms = [...new Set(proposal.closes.map((closed) => closed.query))].slice(0, 5);
    const draft = with_frontmatter(body, { title, tier: 'guide', domains: [domain], status: 'draft', version: '1.0.0', last_updated: options.today, purpose: `Answers: ${proposal.closes[0]!.query}`, symptoms, sources: proposal.source_files });
    const gate = check_security_gate(draft, path, secrets_config)[0];
    if (gate) { result.blocked.push({ keys, reason: `security gate: ${path}:${gate.line} (${gate.rule}, ${gate.masked})` }); continue; }
    result.entries.push({ path, content_hash: compute_content_hash(''), verdict: 'create', draft, sources: proposal.source_files, reasons: proposal.domain ? reasons : [...reasons, `domain ${FALLBACK_DOMAIN} is a fallback: no doc cites nearby code`] });
  }
  return result;
}
