/**
 * `hewtd reconcile --apply` (#54): the only writer. Merges review files,
 * rejects overlap, re-hashes each doc, applies accepted entries serially and
 * commits once per batch.
 */
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { readFile, stat, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { parse_frontmatter, with_frontmatter, with_frontmatter_keys } from '../../utils/frontmatter.js';
import { format_date } from '../metadata/generator.js';
import { archive_doc } from '../archive/manage.js';
import { regenerate_indexes } from '../../generators/regenerate.js';
import { get_all_domains } from '../domains/registry.js';
import { compute_content_hash, build_ledger_entry, write_ledger, type Ledger } from './ledger.js';
import { find_git_top } from './triage.js';
import { validate_no_secrets, find_secrets } from './secrets.js';
import { load_plugin_config } from '../../utils/config.js';
import { apply_outside_entry, build_outside_key } from './outside.js';
import { extract_heading_anchors, find_section } from '../links/anchors.js';
import { extract_references } from './references.js';
import { find_missing_tokens } from './noloss.js';
import { get_member_state } from './overview.js';
import { build_phrases } from './phrases.js';
import { extract_symptom_text } from './gaps.js';
import { get_environment_names, load_review, type ReviewEntry } from './review.js';

export interface ApplyOutcome {
  path: string;
  status: 'applied' | 'stale' | 'rejected' | 'already-applied' | 'skipped' | 'error';
  detail?: string;
}

export interface ApplyResult {
  outcomes: ApplyOutcome[];
  commit?: string;
  touched: string[];
  /** The docs commit landed but the separate index commit failed: index files were restored, run `hewtd index`. */
  index_warning?: string;
}

const ENV = '.env.hewtd';

function parse_environment(text: string): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const line of text.split('\n')) {
    const line_match = /^([A-Za-z_]\w*)=(.*)$/.exec(line);
    if (!line_match) continue;
    let value = line_match[2]!;
    if (value.startsWith('"')) {
      // A JSON.parse error message quotes the input, so never let it escape.
      try { value = JSON.parse(value); } catch { throw new Error(`${ENV}: line for ${line_match[1]} is malformed (fix it by hand)`); }
    }
    parsed.set(line_match[1]!, value);
  }
  return parsed;
}

/** Make sure .env.hewtd is git-ignored (append to the root .gitignore if not); returns the .gitignore path if it changed. */
function ensure_ignored(git_top: string): string | undefined {
  const is_environment_ignored = () => { try { run_git(git_top, ['check-ignore', '-q', ENV]); return true; } catch { return false; } };
  if (is_environment_ignored()) return undefined;
  const gitignore_path = join(git_top, '.gitignore');
  let current_text = '';
  try {
    current_text = existsSync(gitignore_path) ? readFileSync(gitignore_path, 'utf-8') : '';
    writeFileSync(gitignore_path, `${current_text}${current_text && !current_text.endsWith('\n') ? '\n' : ''}${ENV}\n`);
    if (!is_environment_ignored()) throw new Error(`${ENV} still not ignored`);
  } catch (error) {
    if (existsSync(gitignore_path) && statSync(gitignore_path).isFile()) writeFileSync(gitignore_path, current_text);
    throw new Error(`cannot git-ignore ${ENV}: ${(error as Error).message}`);
  }
  return gitignore_path;
}

/**
 * secret verdict: move every value in the doc into .env.hewtd (0600) and leave a pointer.
 * Values are re-read from the doc here, never from the review. Returns the new doc text,
 * the env names, and what to touch/roll back.
 */
function move_secrets(git_top: string, raw_text: string, entry: ReviewEntry, config: Parameters<typeof find_secrets>[2]) {
  const raws = find_secrets(raw_text, entry.path, config).filter((raw_secret) => raw_secret.finding.kind === 'secret');
  if (!raws.length) throw new Error('no secrets found in the doc');
  const env_path = join(git_top, ENV);
  const existing = existsSync(env_path) ? readFileSync(env_path, 'utf-8') : '';
  const environment = parse_environment(existing);
  const proposed = new Map((entry.secrets ?? []).map((secret) => [secret.fingerprint, secret.env]));
  const fresh = get_environment_names(raw_text, entry.path, raws.filter((result) => !proposed.has(result.finding.fingerprint)), new Set(environment.keys()));
  const lines: string[] = [];
  const names: string[] = [];
  const line_starts = [0];
  for (let i = 0; i < raw_text.length; i++) if (raw_text[i] === '\n') line_starts.push(i + 1);
  const frontmatter_end = raw_text.startsWith('---') ? raw_text.indexOf('\n---', 3) : -1;
  const edits: { at: number; len: number; text: string; line: number }[] = [];
  for (const { finding, value } of raws) {
    const name = proposed.get(finding.fingerprint) ?? fresh.get(finding.fingerprint)!;
    if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`bad env name ${JSON.stringify(name)}`);
    if (environment.has(name) && environment.get(name) !== value) throw new Error(`${name} already exists in ${ENV} with a different value`);
    if (!environment.has(name)) { environment.set(name, value); lines.push(`${name}=${/^[\w./+=:@-]+$/.test(value) ? value : JSON.stringify(value)}`); }
    names.push(name);
    // Replace only where the finding is, never other occurrences of the same text in prose.
    const at = line_starts[finding.line - 1]! + finding.col - 1;
    if (raw_text.slice(at, at + value.length) !== value) throw new Error(`finding at line ${finding.line} moved; re-run triage`);
    edits.push({ at, len: value.length, text: `<secret: ${name}, see ${ENV}>`, line: finding.line - 1 });
  }
  let next = raw_text;
  for (const edit of edits.sort((first_edit, second_edit) => second_edit.at - first_edit.at)) next = next.slice(0, edit.at) + edit.text + next.slice(edit.at + edit.len);
  // A long value repeated elsewhere (outside a rule's context) is still the same secret; short weak
  // values like a url password may be ordinary words in prose, so only long ones are chased.
  for (const { finding, value } of raws) {
    if (value.length < 16) continue;
    const name = proposed.get(finding.fingerprint) ?? fresh.get(finding.fingerprint)!;
    next = next.split(value).join(`<secret: ${name}, see ${ENV}>`);
  }
  // In YAML frontmatter the pointer (': ', ', ') must sit inside a quoted scalar, or the doc stops parsing.
  const frontmatter_lines = new Set(edits.filter((ed) => frontmatter_end > 0 && ed.at < frontmatter_end).map((ed) => ed.line));
  if (frontmatter_lines.size) {
    const text_lines = next.split('\n');
    for (const i of frontmatter_lines) {
      const match = /^(\s*(?:-\s+)?(?:[^:#\s][^:#]*?:\s+)?)(.*)$/.exec(text_lines[i]!);
      if (match && !/^["']/.test(match[2]!)) text_lines[i] = match[1]! + JSON.stringify(match[2]!);
    }
    next = text_lines.join('\n');
    try { parse_frontmatter(next); } catch { throw new Error('frontmatter would not parse after the move; move this value by hand'); }
  }
  if (find_secrets(next, entry.path, config).some((raw_secret) => raw_secret.finding.kind === 'secret')) throw new Error('doc still holds a secret after the move');
  const gitignore_path = ensure_ignored(git_top);
  if (lines.length) {
    writeFileSync(env_path, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`, { mode: 0o600 });
    chmodSync(env_path, 0o600);
  }
  return { next, names: [...new Set(names)], gi: gitignore_path, envPath: env_path };
}

const is_present = (path_text: string) => stat(path_text).then(() => true, () => false);
// eslint-disable-next-line id-denylist -- child_process option name
const run_git = (working_dir: string, args: string[]) => execFileSync('git', args, { cwd: working_dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim();

/**
 * Files that differ from HEAD before the batch starts (dirty tracked files anywhere, plus
 * untracked and ignored files under the docs tree), with their contents, so a rollback
 * returns to the pre-apply state rather than to HEAD.
 */
function load_snapshot(git_top: string, docs_rel: string): Map<string, Buffer> {
  const snap = new Map<string, Buffer>();
  const list_git_paths = (args: string[]): string[] => {
    // not git(): its trim() would eat the leading space of the first ' M path' entry
    // eslint-disable-next-line id-denylist -- child_process option name
    const tokens = execFileSync('git', ['status', '--porcelain=v1', '-z', ...args], { cwd: git_top, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0');
    const found: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.length < 4) continue;
      found.push(token.slice(3));
      if (token[0] === 'R' || token[0] === 'C') i++; // rename/copy: next token is the old path
    }
    return found;
  };
  // The secret verdict appends to .env.hewtd and may edit .gitignore, so both come back on rollback.
  const doc_paths = [...new Set([...list_git_paths(['--untracked-files=no']), ...list_git_paths(['--untracked-files=all', '--ignored', '--', docs_rel]), ENV, '.gitignore'])];
  for (const result of doc_paths) {
    try { if (statSync(join(git_top, result)).isFile()) snap.set(result, readFileSync(join(git_top, result))); } catch { /* deleted in the worktree */ }
  }
  return snap;
}

/** Undo a failed batch: touched paths back to their pre-apply state, batch-created files removed. */
function rollback_files(git_top: string, abs_path: string[], snap: Map<string, Buffer>): void {
  const doc_paths = abs_path.map((path_text) => relative(git_top, path_text));
  const in_head = new Set(run_git(git_top, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...doc_paths]).split('\0').filter(Boolean));
  const tracked = doc_paths.filter((doc_path) => in_head.has(doc_path));
  const created = doc_paths.filter((doc_path) => !in_head.has(doc_path) && !snap.has(doc_path));
  if (tracked.length) run_git(git_top, ['restore', '--staged', '--worktree', '--source=HEAD', '--', ...tracked]);
  const unstage = doc_paths.filter((doc_path) => !in_head.has(doc_path));
  if (unstage.length) run_git(git_top, ['rm', '-q', '--cached', '-f', '--ignore-unmatch', '--', ...unstage]);
  // Uncommitted edits and pre-existing untracked/ignored files the batch overwrote come back as they were.
  for (const doc_path of doc_paths) { const buffer = snap.get(doc_path); if (buffer) { mkdirSync(dirname(join(git_top, doc_path)), { recursive: true }); writeFileSync(join(git_top, doc_path), buffer); } }
  for (const created_path of created) {
    rmSync(join(git_top, created_path), { force: true });
    // Drop directories the batch created (e.g. a fresh archive/), never a non-empty one.
    for (let folder = dirname(join(git_top, created_path)); folder !== git_top && existsSync(folder) && !readdirSync(folder).length; folder = dirname(folder)) rmdirSync(folder);
  }
}

/** Existing sources first (a scalar becomes a list; non-string entries are kept), then the entry's and `extra`, deduplicated with
 * `./` ignored; the doc's own path and `sources_remove` dropped. */
function merge_sources(raw_text: string, entry: ReviewEntry, self_paths: string[], extra: string[] = []): unknown[] {
  const existing = parse_frontmatter<Record<string, unknown>>(raw_text).data.sources;
  const key = (source: unknown): string => (typeof source === 'string' ? source.trim().replace(/^\.\//, '') : JSON.stringify(source));
  const drop = new Set([...self_paths, ...(entry.sources_remove ?? [])].map(key));
  const seen = new Set<string>();
  return [...(Array.isArray(existing) ? existing : existing === undefined || existing === null ? [] : [existing]), ...(entry.sources ?? []), ...extra]
    .filter((source) => { const source_key = key(source); if (drop.has(source_key) || seen.has(source_key)) return false; seen.add(source_key); return true; });
}
/** Existing `external_refs` first, then the entry's and `frontmatter.external_refs`, deduplicated; the entry only adds strings, non-string entries already in the doc are kept. */
function merge_external_refs(raw_text: string, entry: ReviewEntry): unknown[] {
  const as_list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
  const seen = new Set<string>();
  const only_strings = (value: unknown): unknown[] => as_list(value).filter((item) => typeof item === 'string');
  return [...as_list(parse_frontmatter<Record<string, unknown>>(raw_text).data.external_refs), ...only_strings(entry.external_refs), ...only_strings(entry.frontmatter?.external_refs)]
    .filter((item) => { const item_key = typeof item === 'string' ? item.trim() : JSON.stringify(item); if (seen.has(item_key)) return false; seen.add(item_key); return true; });
}
/** Entry sources that look like repo paths but are not there (kept anyway; URLs, `<name>:<path>` and prose are not checked). */
function find_missing_sources(repo_root: string, sources: string[] = []): string[] {
  return sources.filter((source) => !/\s|^[\w.-]+:/.test(source) && !existsSync(resolve(repo_root, source)));
}

/** Build the new file content for a verify/fields/unverifiable entry. */
function build_edit_doc(raw_text: string, entry: ReviewEntry, today: string, self_paths: string[] = [], extra_sources: string[] = []): string {
  const { last_verified: _ignored, ...frontmatter } = entry.frontmatter ?? {};
  const changes: Record<string, unknown> = { ...frontmatter };
  if (entry.sources?.length || entry.sources_remove?.length || extra_sources.length) {
    const merged = merge_sources(raw_text, entry, self_paths, extra_sources);
    if (merged.length || parse_frontmatter<Record<string, unknown>>(raw_text).data.sources !== undefined) changes.sources = merged;
  }
  // external_refs (a judge's "this missing ref is fine") merge like sources: a later review never drops an earlier decision.
  const external_refs = merge_external_refs(raw_text, entry);
  if (external_refs.length) changes.external_refs = external_refs;
  if (entry.verdict === 'verify' || entry.verdict === 'rewrite') changes.last_verified = today;
  if (entry.verdict === 'unverifiable') changes.confidence = 'low';
  const next = with_frontmatter_keys(raw_text, changes);
  if (!entry.patch?.length) return next;
  const frontmatter_length = next.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)?.[0].length ?? 0;
  let body = next.slice(frontmatter_length);
  for (const patch of entry.patch) {
    if (body.split(patch.old).length !== 2) throw new Error(`patch text not found exactly once: ${JSON.stringify(patch.old.slice(0, 40))}`);
    body = body.replace(patch.old, () => patch.new);
  }
  return next.slice(0, frontmatter_length) + body;
}

/** A draft's own frontmatter only adds keys the doc does not have (the entry's keys still win); its `sources` merge like the entry's. */
function split_draft_frontmatter(raw_text: string, entry: ReviewEntry): { frontmatter: Record<string, unknown>; sources: string[]; ignored: string[] } {
  const { sources, ...draft_keys } = parse_frontmatter<Record<string, unknown>>(entry.draft ?? '').data;
  const doc_keys = parse_frontmatter<Record<string, unknown>>(raw_text).data;
  const ignored = Object.keys(draft_keys).filter((name) => name in doc_keys && !(name in (entry.frontmatter ?? {})));
  const added = Object.fromEntries(Object.entries(draft_keys).filter(([name]) => !(name in doc_keys)));
  const draft_sources = (Array.isArray(sources) ? sources : sources ? [sources] : []).filter((source): source is string => typeof source === 'string');
  return { frontmatter: { ...added, ...entry.frontmatter }, sources: draft_sources, ignored };
}

/** rewrite: the draft's body replaces the doc's; the doc's frontmatter stays, merged like an edit. Returns the text and keys it ignored. */
function build_rewrite_doc(raw_text: string, entry: ReviewEntry, today: string, self_paths: string[]): { text: string; ignored: string[] } {
  const body = parse_frontmatter(entry.draft ?? '').content.trim();
  if (!body) throw new Error('rewrite needs a draft with a body');
  const { patch: _patch, ...rest } = entry;
  const { frontmatter, sources, ignored } = split_draft_frontmatter(raw_text, entry);
  const next = build_edit_doc(raw_text, { ...rest, frontmatter }, today, self_paths, sources);
  const frontmatter_length = next.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)?.[0].length ?? 0;
  const eol = raw_text.includes('\r\n') ? '\r\n' : '\n';
  return { text: `${next.slice(0, frontmatter_length)}${eol}${body.replace(/\r?\n/g, eol)}${eol}`, ignored };
}

/** What a rewrite drops that something may rely on: anchors other docs link to, and paths or doc links the old body cited. */
function find_rewrite_losses(docs_root: string, abs_path: string, old_text: string, new_text: string): string[] {
  const old_body = parse_frontmatter(old_text).content, new_body = parse_frontmatter(new_text).content;
  const new_anchors = extract_heading_anchors(new_body);
  const dropped = new Set([...extract_heading_anchors(old_body)].filter((anchor) => !new_anchors.has(anchor)));
  const linked = new Set<string>();
  if (dropped.size) {
    for (const file of readdirSync(docs_root, { recursive: true }) as string[]) {
      const other = join(docs_root, file);
      if (!file.endsWith('.md') || other === abs_path || file.split(/[\\/]/).includes('archive')) continue;
      try { for (const link of readFileSync(other, 'utf-8').matchAll(/\]\(([^)#\s]+)#([^)\s]+)\)/g)) if (dropped.has(link[2]!) && resolve(dirname(other), link[1]!) === abs_path) linked.add(link[2]!); } catch { /* unreadable: skip */ }
    }
  }
  const cited = [...new Set(extract_references(old_body).filter((reference) => (reference.kind === 'path' || reference.kind === 'doc-link') && !new_body.includes(reference.ref)).map((reference) => reference.ref))];
  return [...(linked.size ? [`anchors other docs link to are gone: ${[...linked].join(', ')}`] : []), ...(cited.length ? [`no longer cited: ${cited.join(', ')}`] : [])];
}

/** phrases: add new user_phrase entries to symptoms (cap and duplicates re-checked); returns null when nothing is left to add. */
function build_phrases_doc(raw_text: string, entry: ReviewEntry, config: Awaited<ReturnType<typeof load_plugin_config>>): string | null {
  const { data } = parse_frontmatter<Record<string, unknown>>(raw_text);
  const symptoms: unknown[] = Array.isArray(data.symptoms) ? [...data.symptoms] : [];
  const accepted_phrases = build_phrases((entry.phrases ?? []).map((query) => ({ query })), extract_symptom_text(data), config.reconcile.secrets, config.reconcile.gaps.max_phrases_per_doc).accepted.map((a) => a.query);
  if (!accepted_phrases.length) return null;
  const i = symptoms.findIndex((symptom) => symptom && typeof symptom === 'object');
  if (i >= 0) {
    const symptom_record = symptoms[i] as Record<string, unknown>;
    symptoms[i] = { ...symptom_record, user_phrase: [...(Array.isArray(symptom_record.user_phrase) ? symptom_record.user_phrase : symptom_record.user_phrase ? [symptom_record.user_phrase] : []), ...accepted_phrases] };
  } else symptoms.push(...accepted_phrases);
  return with_frontmatter_keys(raw_text, { symptoms });
}

/** point: check the owner section and the no-loss rule, then write the one-line pointer into the copy. */
function build_pointer_doc(option: { raw_text: string; entry: ReviewEntry; abs_path: string; owner_abs_path: string; owner_raw_text: string; today: string }): string {
  const { raw_text, entry, abs_path, owner_abs_path, owner_raw_text, today } = option;
  const { summary, target } = entry.pointer ?? { summary: '', target: '' };
  const anchor = target.split('#')[1] ?? '';
  const removed_text = entry.remove?.old ?? '';
  if (!removed_text || !summary.trim() || /[\r\n]/.test(summary) || !anchor) throw new Error('point needs remove.old, a one-line pointer.summary and a target with #anchor');
  if (owner_abs_path === abs_path) throw new Error('a doc cannot point at itself');
  const owner = parse_frontmatter<Record<string, unknown>>(owner_raw_text);
  if (!extract_heading_anchors(owner.content).has(anchor)) throw new Error(`anchor #${anchor} not found in ${target.split('#')[0]}`);
  const section = find_section(owner.content, anchor) ?? '';
  const missing = find_missing_tokens(removed_text, section, summary);
  if (missing.length) throw new Error(`no-loss check failed, missing: ${missing.join(', ')}`);
  const heading = (section.split('\n')[0] ?? '').replace(/^#+\s*/, '').replace(/\s*\{#[^}]*\}\s*$/, '').trim() || anchor;
  const title = typeof owner.data.title === 'string' && owner.data.title ? owner.data.title : owner_abs_path.split('/').pop()!;
  const doc_path = relative(dirname(abs_path), owner_abs_path).split('\\').join('/');
  const line = `${summary.trim()} Details: [${title}: ${heading}](${doc_path}#${anchor})`;
  return build_edit_doc(raw_text, { path: entry.path, content_hash: entry.content_hash, verdict: 'point', patch: [{ old: removed_text, new: line }] }, today);
}

/** overview: every member current and reconciled (or explicitly marked), then the new doc with kind: overview and no last_validated. */
async function build_overview_doc(entry: ReviewEntry, docs_root: string, ledger: Ledger): Promise<string> {
  if (!entry.path.endsWith('.md') || !entry.members?.length || !entry.draft?.trim()) throw new Error('overview needs a .md path, members and a draft');
  const stale: string[] = [], open: string[] = [];
  for (const match of entry.members) {
    let hash: string;
    try { hash = compute_content_hash(await readFile(join(docs_root, match.path), 'utf-8')); } catch { stale.push(match.path); continue; }
    if (hash !== match.content_hash) { stale.push(match.path); continue; }
    const st = get_member_state(ledger, match.path, hash);
    if (st !== 'reconciled') open.push(match.path);
    if (st === 'secret') throw new Error(`member is in the secret lane: ${match.path}`);
  }
  if (stale.length) throw new Error(`member changed since the review was written: ${stale.join(', ')}`);
  if (open.length) {
    if (!entry.allow_unreviewed) throw new Error(`members not reconciled: ${open.join(', ')}`);
    const unmarked = open.filter((path_text) => !entry.draft!.split('\n').some((line) => line.includes(`](`) && line.includes(path_text.split('/').pop()!) && line.includes('(unreviewed)')));
    if (unmarked.length) throw new Error(`draft must mark these links "(unreviewed)": ${unmarked.join(', ')}`);
  }
  const { last_verified: _v, last_validated: _l, ...frontmatter } = entry.frontmatter ?? {};
  return with_frontmatter(entry.draft!, { ...frontmatter, kind: 'overview', ...(entry.sources && { sources: entry.sources }) });
}

const INDEXED_KEYS = new Set(['title', 'summary', 'purpose', 'description', 'tier', 'status', 'domains', 'keywords', 'kind']);

export async function apply_reviews(options: {
  root: string;
  docs_root: string;
  files: string[];
  ledger: Ledger;
  ledger_file: string;
  today?: string;
}): Promise<ApplyResult> {
  const { root: repo_root, docs_root: docs_root, ledger } = options;
  const today = options.today ?? format_date(new Date());
  const config = await load_plugin_config(repo_root);
  const secrets_config = config.reconcile.secrets;
  const reviews = await Promise.all(options.files.map((file) => load_review(file)));
  const start_git_top = find_git_top(repo_root);
  const snap = start_git_top ? load_snapshot(start_git_top, relative(start_git_top, docs_root) || '.') : new Map<string, Buffer>();

  // Merge shards; the same doc in two files is a hard error before anything is written.
  const owner = new Map<string, string>();
  for (const review of reviews) {
    for (const { entry } of review.entries) {
      const key = entry.outside ? build_outside_key(entry.path) : entry.path;
      const prev = owner.get(key);
      if (prev) throw new Error(prev === review.file ? `${entry.path} appears twice in ${review.file}` : `${entry.path} appears in both ${prev} and ${review.file}`);
      owner.set(key, review.file);
    }
  }

  const outcomes: ApplyOutcome[] = [];
  const touched = new Set<string>(); // repo-relative via absolute paths
  const domains = new Set<string>();
  const applied: { entry: ReviewEntry; file: string; abs_path: string; outside?: boolean; env_names?: string[] }[] = [];
  let env_path: string | undefined; // set once .env.hewtd was written, so a rollback restores it
  const known = new Set<string>(get_all_domains());

  // A merge-then-point pair applies merge first: points run after every other entry.
  const queue = reviews.flatMap((review) => review.entries.map((entry) => ({ ...entry, r: review })));
  queue.sort((a, b) => Number(a.entry.verdict === 'point') - Number(b.entry.verdict === 'point'));
  const merged_ids = new Set<string>();
  const overview_members = new Map<string, Record<string, string>>();
  const pointers = new Map<string, { target: string; section_hash: string }>();
  const sibling_repo_roots = (await load_plugin_config(repo_root)).reconcile.related_repos.map((related_repo) => resolve(repo_root, related_repo.path));
  {
      for (const { entry, accepted, r: result_item } of queue) {
      const review_ref = relative(repo_root, result_item.file).split('\\').join('/');
      const abs_path = join(docs_root, entry.path);
      // Hard guard: never write outside the project root (related repos are read-only).
      const repo_path = relative(repo_root, abs_path);
      if (repo_path === '..' || repo_path.startsWith('../') || repo_path.startsWith('..\\') || isAbsolute(repo_path)) {
        outcomes.push({ path: entry.path, status: 'error', detail: 'path resolves outside the project root' });
        continue;
      }
      if (entry.outside) {
        const key = build_outside_key(entry.path);
        if (ledger.entries[key]?.verdict && ledger.entries[key]?.review_file === review_ref) { outcomes.push({ path: entry.path, status: 'already-applied' }); continue; }
        if (!accepted) { outcomes.push({ path: entry.path, status: 'rejected' }); continue; }
        if (!entry.verdict) { outcomes.push({ path: entry.path, status: 'skipped', detail: 'no verdict' }); continue; }
        const outside_result = await apply_outside_entry({ docs_root: docs_root, entry });
        if (outside_result.status !== 'applied') { outcomes.push({ path: entry.path, status: outside_result.status, ...(outside_result.detail && { detail: outside_result.detail }) }); continue; }
        outside_result.touched.forEach((touched_path) => touched.add(touched_path));
        if (outside_result.domain) domains.add(outside_result.domain);
        applied.push({ entry, file: review_ref, abs_path, outside: true });
        outcomes.push({ path: entry.path, status: 'applied' });
        continue;
      }
      if (entry.verdict === 'integrate' || entry.verdict === 'delete') { outcomes.push({ path: entry.path, status: 'error', detail: `"${entry.verdict}" is only valid for outside entries` }); continue; }
      const ledger_entry = ledger.entries[entry.path];
      const done = !!ledger_entry?.verdict && ledger_entry.review_file === review_ref;
      const present = await is_present(abs_path);
      if (done && (!present || compute_content_hash(await readFile(abs_path, 'utf-8')) === ledger_entry.content_hash)) {
        outcomes.push({ path: entry.path, status: 'already-applied' });
        continue;
      }
      if (!accepted) { outcomes.push({ path: entry.path, status: 'rejected' }); continue; }
      if (!entry.verdict) { outcomes.push({ path: entry.path, status: 'skipped', detail: 'no verdict' }); continue; }
      if (entry.verdict === 'overview' && present) { outcomes.push({ path: entry.path, status: 'error', detail: 'overview target already exists' }); continue; }
      if (!present && entry.verdict !== 'overview') { outcomes.push({ path: entry.path, status: 'error', detail: 'file not found' }); continue; }
      const raw_text = present ? await readFile(abs_path, 'utf-8') : ''; // a new overview is hashed as empty

      if (compute_content_hash(raw_text) !== entry.content_hash) {
        outcomes.push({ path: entry.path, status: 'stale', detail: 'doc changed since the review was written' });
        continue;
      }
      let env_names_for: string[] | undefined;
      let detail: string | undefined;
      const self_paths = [entry.path, repo_path.split('\\').join('/')];
      try {
        // Nothing the review proposes to write may carry a secret.
        validate_no_secrets([...(entry.patch ?? []).map((patch) => patch.new), entry.draft ?? '', entry.pointer?.summary ?? '', ...(entry.phrases ?? []), JSON.stringify(entry.frontmatter ?? {})].join('\n'), entry.path, secrets_config);
        if (entry.verdict === 'merge') {
          const body = parse_frontmatter(raw_text).content;
          if (!entry.section || !extract_heading_anchors(body).has(entry.section)) throw new Error(`section #${entry.section ?? ''} not found in ${entry.path}`);
          if (!entry.patch?.length) throw new Error('merge needs a patch');
          const next = build_edit_doc(raw_text, entry, today, self_paths);
          if (!extract_heading_anchors(parse_frontmatter(next).content).has(entry.section)) throw new Error(`section #${entry.section} gone after the merge`);
          // A merge only adds to the owner: whatever a patch replaces must still be there afterwards.
          const lost = [...new Set(entry.patch.flatMap((patch) => find_missing_tokens(patch.old, parse_frontmatter(next).content, '')))];
          if (lost.length) throw new Error(`merge would drop owner text; missing: ${lost.join(', ')}`);
          await writeFile(abs_path, next, 'utf-8');
          touched.add(abs_path);
          merged_ids.add(entry.id ?? entry.path);
        } else if (entry.verdict === 'overview') {
          await writeFile(abs_path, await build_overview_doc(entry, docs_root, ledger), 'utf-8');
          touched.add(abs_path);
          overview_members.set(entry.path, Object.fromEntries((entry.members ?? []).map((member) => [member.path, member.content_hash])));
        } else if (entry.verdict === 'point') {
          const target = entry.pointer?.target ?? '';
          const owner_abs_path = resolve(docs_root, target.split('#')[0] ?? '');
          const in_docs = !relative(docs_root, owner_abs_path).startsWith('..');
          // Outside the docs tree only a related repo's doc is allowed, and it is only ever read.
          if (!in_docs && !sibling_repo_roots.some((root) => !relative(root, owner_abs_path).startsWith('..'))) throw new Error('pointer target is outside the docs tree and not in a related repo');
          if (!(await is_present(owner_abs_path))) throw new Error(`pointer target not found: ${target}`);
          if (entry.depends_on_merge) {
            if (!merged_ids.has(entry.depends_on_merge)) throw new Error(`merge "${entry.depends_on_merge}" was not applied`);
            if (owner_abs_path !== join(docs_root, [...applied].find((a) => (a.entry.id ?? a.entry.path) === entry.depends_on_merge)!.entry.path)) throw new Error('pointer target is not the merged doc');
          }
          const owner_raw_text = await readFile(owner_abs_path, 'utf-8');
          if (!entry.depends_on_merge && compute_content_hash(owner_raw_text) !== entry.target_hash) throw new Error('owner doc changed since the review was written (or target_hash missing)');
          await writeFile(abs_path, build_pointer_doc({ raw_text, entry, abs_path, owner_abs_path, owner_raw_text, today }), 'utf-8');
          pointers.set(entry.path, { target, section_hash: compute_content_hash(find_section(parse_frontmatter<Record<string, unknown>>(owner_raw_text).content, target.split('#')[1] ?? '') ?? '') });
          touched.add(abs_path);
        } else if (entry.verdict === 'phrases') {
          const next = build_phrases_doc(raw_text, entry, config);
          if (next === null) { outcomes.push({ path: entry.path, status: 'skipped', detail: 'no new phrases to add' }); continue; }
          await writeFile(abs_path, next, 'utf-8');
          touched.add(abs_path);
        } else if (entry.verdict === 'archive') {
          const result_entry = await archive_doc({ repo_root: repo_root, docs_root: docs_root, file: entry.path, today, ...(entry.reason && { reason: entry.reason }) });
          if (!result_entry.ok) throw new Error(result_entry.errors.join('; '));
          touched.add(abs_path);
          touched.add(join(docs_root, result_entry.to ?? ''));
        } else if (entry.verdict === 'secret') {
          if (!start_git_top) throw new Error('the secret verdict needs a git repo');
          const moved = move_secrets(start_git_top, raw_text, entry, secrets_config);
          if (moved.gi) touched.add(moved.gi);
          env_path = moved.envPath;
          await writeFile(abs_path, moved.next, 'utf-8');
          touched.add(abs_path);
          env_names_for = moved.names;
        } else if (entry.verdict === 'rewrite') {
          const { text: next, ignored } = build_rewrite_doc(raw_text, entry, today, self_paths);
          await writeFile(abs_path, next, 'utf-8');
          touched.add(abs_path);
          const missing = find_missing_sources(repo_root, [...(entry.sources ?? []), ...split_draft_frontmatter(raw_text, entry).sources]);
          const warnings = [...find_rewrite_losses(docs_root, abs_path, raw_text, next), ...(missing.length ? [`sources not found in the repo (kept): ${missing.join(', ')}`] : []), ...(ignored.length ? [`draft frontmatter kept the doc's own value for: ${ignored.join(', ')}`] : [])];
          if (warnings.length) detail = `warning: ${warnings.join('; ')}`;
        } else {
          await writeFile(abs_path, build_edit_doc(raw_text, entry, today, self_paths), 'utf-8');
          touched.add(abs_path);
          const missing = find_missing_sources(repo_root, entry.sources);
          if (missing.length) detail = `sources not found in the repo (kept): ${missing.join(', ')}`;
        }
        domains.add(entry.path.split('/')[0] ?? '');
        applied.push({ entry, file: review_ref, abs_path, ...(env_names_for && { env_names: env_names_for }) });
        outcomes.push({ path: entry.path, status: 'applied', ...(detail && { detail }) });
      } catch (error) {
        outcomes.push({ path: entry.path, status: 'error', detail: (error as Error).message });
      }
    }
  }

  const result: ApplyResult = { outcomes, touched: [] };
  if (!applied.length) return result;

  const git_top = find_git_top(repo_root);
  let commit: string | undefined;
  const index_files: string[] = [];
  const first = reviews[0]!;
  const commit_paths = (message: string, files: string[]): void => {
    const paths = files.map((path_text) => relative(git_top!, path_text));
    const present = paths.filter((path) => existsSync(join(git_top!, path)));
    // -f: apply wrote these itself, so an ignored target (archive/) must still be staged.
    // An empty pathspec would stage the whole tree (ignored files included).
    if (present.length) run_git(git_top!, ['add', '-A', '-f', '--', ...present]);
    const gone = paths.filter((path) => !present.includes(path));
    if (gone.length) run_git(git_top!, ['rm', '-q', '--cached', '--ignore-unmatch', '--', ...gone]);
    // Last line of defence: the staged diff may not add a secret.
    const added = run_git(git_top!, ['diff', '--cached', '-U0', '--no-color', '--', ...paths]).split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
    validate_no_secrets(added, 'the staged diff', secrets_config);
    if (run_git(git_top!, ['status', '--porcelain', '--', ...paths])) run_git(git_top!, ['commit', '-q', '--only', '-m', message, '--', ...paths]);
  };
  try {
    // Only verdicts that change what an index lists regenerate it (phrases/verify/unverifiable/rewrite do not).
    const changes_index = applied.some(({ entry, outside }) => outside || (entry.verdict !== 'phrases' && entry.verdict !== 'verify' && entry.verdict !== 'unverifiable' && entry.verdict !== 'rewrite') || Object.keys((entry.verdict === 'rewrite' ? { ...parse_frontmatter<Record<string, unknown>>(entry.draft ?? '').data, ...entry.frontmatter } : entry.frontmatter) ?? {}).some((key) => INDEXED_KEYS.has(key)));
    if (domains.size && changes_index) {
      const regenerated = await regenerate_indexes({
        docs_root: docs_root, silent: true,
        domains: [...domains].filter((domain) => known.has(domain)) as never,
      });
      index_files.push(...regenerated.files_written.filter((file) => !touched.has(file)));
    }
    if (git_top && touched.size) {
      commit_paths(`docs(reconcile): ${first.scope || 'docs'} batch ${first.batch}`, [...touched]);
      commit = run_git(git_top, ['rev-parse', '--short', 'HEAD']);
    }
  } catch (error) {
    let message = (error as Error).message;
    if (git_top) {
      try { rollback_files(git_top, [...touched, ...index_files, ...(env_path ? [env_path] : [])], snap); } catch (rollback_error) { message += `; rollback also failed: ${(rollback_error as Error).message}`; }
    }
    const failed = new Set(applied.map((a) => a.entry.path));
    return { outcomes: outcomes.map((outcome) => (failed.has(outcome.path) && outcome.status === 'applied' ? { ...outcome, status: 'error' as const, detail: `rolled back: ${message}` } : outcome)), touched: [] };
  }
  // The docs commit has landed, so an index commit failure must not report the batch as rolled back.
  let index_warning: string | undefined;
  if (git_top && index_files.length) {
    try {
      commit_paths(`docs(index): refresh after reconcile batch ${reviews[0]!.batch}`, index_files);
    } catch (error) {
      index_warning = `index refresh not committed (${(error as Error).message}); index files restored, run \`hewtd index\``;
      try { rollback_files(git_top, index_files, snap); } catch (rollback_error) { index_warning += `; restore also failed: ${(rollback_error as Error).message}`; }
    }
  }

  for (const applied_item of applied) {
    const dest = applied_item.entry.verdict === 'archive' || applied_item.outside ? undefined : applied_item.abs_path;
    const raw_text = dest ? await readFile(dest, 'utf-8') : undefined;
    const key = applied_item.outside ? build_outside_key(applied_item.entry.path) : applied_item.entry.path;
    const prev = ledger.entries[key];
    const ledger_record = build_ledger_entry(ledger, {
      path: key,
      lane: prev?.lane ?? applied_item.entry.lane ?? 'check',
      content_hash: raw_text !== undefined ? compute_content_hash(raw_text) : applied_item.entry.content_hash,
    });
    Object.assign(ledger_record, { verdict: applied_item.entry.verdict ?? '', reviewed_on: today, review_file: applied_item.file, ...(applied_item.env_names && { env_names: applied_item.env_names }), ...(pointers.has(applied_item.entry.path) && { pointer: pointers.get(applied_item.entry.path)! }), ...(overview_members.has(applied_item.entry.path) && { members: overview_members.get(applied_item.entry.path)! }), ...(commit && { applied_commit: commit }) });
  }
  await write_ledger(options.ledger_file, ledger);
  return { ...result, ...(commit && { commit }), ...(index_warning && { index_warning }), touched: [...touched] };
}
