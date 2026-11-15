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
import { check_credential_text, check_security_gate, find_security_check, find_sensitive_word, is_security_sensitive, is_stateable_constant } from '../security/gate.js';
import { compile_facet, match_facets, parse_position_facet, REDACTED_FACET } from './facets.js';
import type { FacetHit } from './locate.js';
import { FALLBACK_DOMAIN, name_new_doc, place_new_doc } from './naming.js';
import type { Proposal } from './merge.js';

/** A missing fact hewtd cannot state on its own: the facet and where it was found (file:line), for the reconcile judge. */
export interface JudgeItem { facet: string; at: string[] }

export interface DraftResult {
  entries: ReviewEntry[];
  /** Security-sensitive topics: unit names (question keys, source files) only. */
  needs_human: { keys: string[]; source_files: string[]; /** Why a person is needed: a matched word or path, never a value. */ reason: string }[];
  /** The gate refused: path:line and a masked length, never a value. */
  blocked: { keys: string[]; reason: string }[];
  skipped: { keys: string[]; reason: string }[];
  /** Units that mention a security topic but whose located lines are no security check (#118): drafted, marked for the judge. Present only when there is one. */
  security_adjacent?: { keys: string[]; word: string; where: string }[];
}

/** A draft cites a handful of lines; more is a sign the facets were too generic to ground one doc. */
export const MAX_SENTENCES = 12;
export { FALLBACK_DOMAIN };

const CONSTANT_LINE = /^\s*(?:export\s+)?(?:(?:public|private|protected|static|final|readonly|const|let|var|val|pub)\s+)*(?:[A-Za-z_][\w<>[\]]*\s+)?([A-Za-z_]\w*)\s*(?::\s*[\w<>[\]|. ]+?)?\s*:?=\s*(.+?)\s*;?\s*(?:(?:\/\/|#).*)?$/;
/** Config and env files hold values, not code constants. */
const CONFIG_FILE = /(^|\/)\.env[^/]*$|\.(?:env|ini|ya?ml|toml|properties|cfg|conf|json)$/i;

/** The one kind of line hewtd states a fact from: `NAME = <number | arithmetic | duration or size>` (#115). Never a value that names a host, port, id, url or credential. */
export function extract_stated_constant(line: string): { name: string; literal: string } | undefined {
  const match = CONSTANT_LINE.exec(line);
  if (!match || !is_stateable_constant(match[1]!, match[2]!)) return undefined;
  return { name: match[1]!, literal: match[2]!.trim() };
}

const sentence_case = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
/** Located lines listed per facet for the judge. */
const MAX_JUDGE_LINES = 5;

interface Facts { sentences: string[]; for_judge: JudgeItem[]; /** Cited files that still have a usable line. */ source_files: string[]; /** Credential-class lines withheld: path:line (rule, masked length). */ withheld: string[]; /** Some facet was found only on a withheld line. */ lost_facet: boolean }

/**
 * The facts a draft may state (#115). Deterministic: a missing facet is stated only from a simple constant line it
 * matches, in a sentence that itself matches the facet. Every other missing facet is listed (facet, file:line) for
 * the reconcile judge. A cited line holding a credential is withheld, not cited; it never blocks the unit.
 */
async function build_facts(repo_root: string, proposal: Proposal, secrets_config: SecretsConfig): Promise<Facts> {
  const lines_of = new Map<string, string[]>();
  const withheld: string[] = [];
  const kept: { match: FacetHit; text: string }[] = [];
  const held_hits = new Set<string>();
  const cited = [...proposal.sources].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const found of cited) {
    let lines = lines_of.get(found.file);
    if (!lines) { lines = (await readFile(join(repo_root, found.file), 'utf-8').catch(() => '')).split('\n'); lines_of.set(found.file, lines); }
    const text = lines[found.line - 1] ?? '';
    const credential = check_credential_text(text, found.file, secrets_config)[0];
    if (credential) { withheld.push(`${found.file}:${found.line} (${credential.rule}, ${credential.masked})`); held_hits.add(`${found.file}:${found.line}`); } else kept.push({ match: found, text });
  }
  const sentences: string[] = [];
  const for_judge: JudgeItem[] = [];
  let lost_facet = false;
  for (const facet of proposal.missing_facets) {
    if (facet === REDACTED_FACET) { lost_facet = true; continue; }
    const regex = compile_facet(facet).regex;
    const matches = (text: string): boolean => !!regex && !!match_facets([regex], [text], 1)[0]?.length;
    const position = parse_position_facet(facet);
    const at = kept.filter((line) => (position ? line.match.file === position.file && line.match.line === position.line : matches(line.text)));
    let stated = false;
    for (const { match, text } of at) {
      const constant = CONFIG_FILE.test(match.file) ? undefined : extract_stated_constant(text);
      if (!constant) continue;
      const sentence = `\`${constant.name}\` is \`${constant.literal}\` (\`${match.file}\`, line ${match.line}).`;
      // the facet may be code-line shaped (`NAME = literal`): the located line already matched it, so the canonical line form counts too
      if (!(matches(sentence) || matches(`${constant.name} = ${constant.literal}`)) || check_security_gate(sentence, match.file, secrets_config).length || is_security_sensitive(sentence)) continue;
      if (!sentences.includes(`- ${sentence}`)) sentences.push(`- ${sentence}`);
      stated = true;
      break;
    }
    if (stated) continue;
    if (!at.length && regex && cited.some((found) => held_hits.has(`${found.file}:${found.line}`) && matches(lines_of.get(found.file)![found.line - 1] ?? ''))) { lost_facet = true; continue; }
    for_judge.push({ facet, at: at.slice(0, MAX_JUDGE_LINES).map(({ match }) => `${match.file}:${match.line}`) });
  }
  return { sentences: sentences.slice(0, MAX_SENTENCES), for_judge, source_files: [...new Set(kept.map(({ match }) => match.file))].sort(), withheld, lost_facet };
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

/** Lines read per unit when looking for a security check: a unit citing more than this is too generic to be about one check. */
const MAX_CHECKED_LINES = 100;
/** The first located line that is a security check: its kind and place, never its text. */
export async function find_check_line(repo_root: string, sources: FacetHit[]): Promise<{ kind: string; file: string; line: number } | undefined> {
  const lines_of = new Map<string, string[]>();
  for (const found of [...sources].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line).slice(0, MAX_CHECKED_LINES)) {
    let lines = lines_of.get(found.file);
    if (!lines) { lines = (await readFile(join(repo_root, found.file), 'utf-8').catch(() => '')).split('\n'); lines_of.set(found.file, lines); }
    const kind = find_security_check(lines[found.line - 1] ?? '');
    if (kind) return { kind, file: found.file, line: found.line };
  }
  return undefined;
}

export async function build_drafts(options: { repo_root: string; docs_root: string; proposals: Proposal[]; secrets_config: SecretsConfig; include_blind?: boolean; today: string }): Promise<DraftResult> {
  const { repo_root, docs_root, secrets_config } = options;
  const result: DraftResult = { entries: [], needs_human: [], blocked: [], skipped: [] };
  const taken = new Set<string>();
  for (let proposal of options.proposals) {
    const keys = proposal.closes.map((closed) => closed.key);
    const skip = (reason: string): void => void result.skipped.push({ keys, reason });
    if (proposal.kind === 'covered') { skip(`covered by ${proposal.doc}: check ranking and phrasing, nothing to draft`); continue; }
    if (proposal.kind === 'instruction-only') { skip(`the fact is only in agent instruction files (${proposal.instruction_files.join(', ')}): move it into an indexed doc`); continue; }
    if (proposal.blind && !options.include_blind) { skip('blind entry: drafting from it would spoil the blind set (pass --include-blind to draft anyway)'); continue; }
    // #118: withhold only when a located line IS a security check; a topic word alone keeps the unit drafted, marked security-adjacent
    const check = await find_check_line(repo_root, proposal.sources);
    if (check) { result.needs_human.push({ keys, source_files: proposal.source_files, reason: `security check (${check.kind}) at ${check.file}:${check.line}: a person must state it` }); continue; }
    const sensitive = ([['the question', proposal.closes.map((closed) => closed.query)], ['a facet', proposal.missing_facets], ['a source path', proposal.source_files]] as const).flatMap(([where, texts]) => texts.map((text) => ({ where, word: find_sensitive_word(text) }))).find((found) => found.word);
    if (!proposal.sources.length) { skip('nothing located in code: no file:line to ground a draft'); continue; }
    // #120: the hint covers the facets that are entries of the declared list; the other facets are still drafted, beside it
    const reference = proposal.generated_reference;
    const hint = `generated reference suggested (${reference.map((list) => `${list.kind} in ${list.file}`).join(', ')})`;
    const listed = new Set(reference.flatMap((list) => list.covers ?? proposal.missing_facets));
    const rest = proposal.missing_facets.filter((facet) => !listed.has(facet));
    if (reference.length && !rest.length) { skip(`${hint}: generate it instead of writing prose`); continue; }
    if (reference.length) proposal = { ...proposal, missing_facets: rest };
    const adjacent = sensitive?.word ? { word: sensitive.word, where: sensitive.where } : undefined;
    if (adjacent) (result.security_adjacent ??= []).push({ keys, ...adjacent });
    const built = await build_facts(repo_root, proposal, secrets_config);
    if (built.lost_facet) result.needs_human.push({ keys, source_files: built.source_files, reason: `a missing fact is only on a line holding a credential or a config value, withheld${built.withheld.length ? `: ${built.withheld.join('; ')}` : ''}` });
    if (!built.source_files.length) { if (!built.lost_facet) skip('no citable line'); continue; }
    const reasons = [`coverage miss: ${keys.join(', ')}`, ...(reference.length ? [`${hint}: it covers ${listed.size} fact(s); the rest are drafted`] : []), ...(adjacent ? [`security-adjacent: judge carefully (\`${adjacent.word}\` in ${adjacent.where}); state no values and no internals of any check`] : [])];
    const mark = adjacent ? { security_adjacent: adjacent } : {};
    const for_judge = built.for_judge.length ? { for_judge: built.for_judge } : {};
    const waiting = `waiting for the judge: ${built.for_judge.length} missing fact(s) need a sentence written from the listed lines (verdict is null, so apply leaves the doc alone)`;

    if (proposal.kind === 'extend') {
      const abs_path = join(docs_root, proposal.doc!);
      const raw_text = await readFile(abs_path, 'utf-8');
      if (!built.sentences.length) {
        if (built.for_judge.length) result.entries.push({ path: proposal.doc!, content_hash: compute_content_hash(raw_text), verdict: null, sources: built.source_files, ...for_judge, ...mark, reasons: [...reasons, waiting] });
        else skip('no citable line');
        continue;
      }
      const anchor = find_anchor(raw_text);
      if (!anchor) { skip(`no unique anchor in ${proposal.doc} for a patch: add the details by hand`); continue; }
      const added = `\n\n## Details from the code (unreviewed)\n\n${built.sentences.join('\n')}`;
      const gate = check_security_gate(added, proposal.doc!, secrets_config)[0];
      if (gate) { result.blocked.push({ keys, reason: `security gate: ${proposal.doc}:${gate.line} (${gate.rule}, ${gate.masked})` }); continue; }
      result.entries.push({ path: proposal.doc!, content_hash: compute_content_hash(raw_text), verdict: 'verify', patch: [{ old: anchor, new: anchor + added }], sources: built.source_files, ...for_judge, ...mark, reasons });
      continue;
    }

    // new doc: never overwrite an existing path or another draft's
    const { dir, fallback } = place_new_doc({ ...(proposal.folder && { folder: proposal.folder }), ...(proposal.domain && { domain: proposal.domain }), tier: 'guide' });
    const domain = dir.split('/')[0]!;
    const title = sentence_case(proposal.closes[0]!.query);
    const stem = name_new_doc({ queries: proposal.closes.map((closed) => closed.query), facets: proposal.missing_facets, source_files: proposal.source_files });
    let path = `${dir}/${stem}.md`;
    for (let copy = 2; existsSync(join(docs_root, path)) || taken.has(path); copy++) path = `${dir}/${stem}-${copy}.md`;
    taken.add(path);
    const domain_reasons = fallback ? [...reasons, `domain ${FALLBACK_DOMAIN} is a fallback: no doc cites nearby code`] : reasons;
    if (!built.sentences.length) {
      if (built.for_judge.length) result.entries.push({ path, content_hash: compute_content_hash(''), verdict: null, sources: built.source_files, ...for_judge, ...mark, reasons: [...domain_reasons, waiting] });
      else skip('no citable line');
      continue;
    }
    const body = `# ${title}\n\nDrafted from code that search questions could not be answered from; every statement cites the code it came from. Review before accepting.\n\n## What the code defines\n\n${built.sentences.join('\n')}\n`;
    const symptoms = [...new Set(proposal.closes.map((closed) => closed.query))].slice(0, 5);
    const draft = with_frontmatter(body, { title, tier: 'guide', domains: [domain], status: 'draft', version: '1.0.0', last_updated: options.today, purpose: `Answers: ${proposal.closes[0]!.query}`, symptoms, sources: built.source_files });
    const gate = check_security_gate(draft, path, secrets_config)[0];
    if (gate) { result.blocked.push({ keys, reason: `security gate: ${path}:${gate.line} (${gate.rule}, ${gate.masked})` }); continue; }
    result.entries.push({ path, content_hash: compute_content_hash(''), verdict: 'create', draft, sources: built.source_files, ...for_judge, ...mark, reasons: domain_reasons });
  }
  return result;
}
