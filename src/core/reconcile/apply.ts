/**
 * `hewtd reconcile --apply` (#54): the only writer. Merges review files,
 * rejects overlap, re-hashes each doc, applies accepted entries serially and
 * commits once per batch.
 */
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { parse_frontmatter, set_frontmatter, set_frontmatter_keys } from '../../utils/frontmatter.js';
import { format_date } from '../metadata/generator.js';
import { archive_doc } from '../archive/manage.js';
import { regenerate_indexes } from '../../generators/regenerate.js';
import { get_all_domains } from '../domains/registry.js';
import { hash_content, record_entry, save_ledger, type Ledger } from './ledger.js';
import { git_root } from './triage.js';
import { assert_no_secrets, find_secrets } from './secrets.js';
import { load_plugin_config } from '../../utils/config.js';
import { apply_outside_entry, outside_key } from './outside.js';
import { heading_anchors, section_of } from '../links/anchors.js';
import { missing_tokens } from './noloss.js';
import { member_state } from './overview.js';
import { build_phrases } from './phrases.js';
import { symptom_text } from './gaps.js';
import { env_names, parse_review, review_dir, type ReviewEntry } from './review.js';

export interface ApplyOutcome {
  path: string;
  status: 'applied' | 'stale' | 'rejected' | 'already-applied' | 'skipped' | 'error';
  detail?: string;
}

export interface ApplyResult {
  outcomes: ApplyOutcome[];
  commit?: string;
  touched: string[];
}

const ENV = '.env.hewtd';

function parse_env(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of text.split('\n')) {
    const k = /^([A-Za-z_]\w*)=(.*)$/.exec(l);
    if (!k) continue;
    let v = k[2]!;
    if (v.startsWith('"')) {
      // A JSON.parse error message quotes the input, so never let it escape.
      try { v = JSON.parse(v); } catch { throw new Error(`${ENV}: line for ${k[1]} is malformed (fix it by hand)`); }
    }
    m.set(k[1]!, v);
  }
  return m;
}

/** Make sure .env.hewtd is git-ignored (append to the root .gitignore if not); returns the .gitignore path if it changed. */
function ensure_ignored(top: string): string | undefined {
  const ignored = () => { try { git(top, ['check-ignore', '-q', ENV]); return true; } catch { return false; } };
  if (ignored()) return undefined;
  const gi = join(top, '.gitignore');
  let cur = '';
  try {
    cur = existsSync(gi) ? readFileSync(gi, 'utf-8') : '';
    writeFileSync(gi, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${ENV}\n`);
    if (!ignored()) throw new Error(`${ENV} still not ignored`);
  } catch (err) {
    if (existsSync(gi) && statSync(gi).isFile()) writeFileSync(gi, cur);
    throw new Error(`cannot git-ignore ${ENV}: ${(err as Error).message}`);
  }
  return gi;
}

/**
 * secret verdict: move every value in the doc into .env.hewtd (0600) and leave a pointer.
 * Values are re-read from the doc here, never from the review. Returns the new doc text,
 * the env names, and what to touch/roll back.
 */
function move_secrets(top: string, raw: string, e: ReviewEntry, cfg: Parameters<typeof find_secrets>[2]) {
  const raws = find_secrets(raw, e.path, cfg).filter((r) => r.finding.kind === 'secret');
  if (!raws.length) throw new Error('no secrets found in the doc');
  const env_path = join(top, ENV);
  const existing = existsSync(env_path) ? readFileSync(env_path, 'utf-8') : '';
  const env = parse_env(existing);
  const proposed = new Map((e.secrets ?? []).map((s) => [s.fingerprint, s.env]));
  const fresh = env_names(raw, e.path, raws.filter((r) => !proposed.has(r.finding.fingerprint)), new Set(env.keys()));
  const lines: string[] = [];
  const names: string[] = [];
  const line_starts = [0];
  for (let i = 0; i < raw.length; i++) if (raw[i] === '\n') line_starts.push(i + 1);
  const fm_end = raw.startsWith('---') ? raw.indexOf('\n---', 3) : -1;
  const edits: { at: number; len: number; text: string; line: number }[] = [];
  for (const { finding: f, value } of raws) {
    const name = proposed.get(f.fingerprint) ?? fresh.get(f.fingerprint)!;
    if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`bad env name ${JSON.stringify(name)}`);
    if (env.has(name) && env.get(name) !== value) throw new Error(`${name} already exists in ${ENV} with a different value`);
    if (!env.has(name)) { env.set(name, value); lines.push(`${name}=${/^[\w./+=:@-]+$/.test(value) ? value : JSON.stringify(value)}`); }
    names.push(name);
    // Replace only where the finding is, never other occurrences of the same text in prose.
    const at = line_starts[f.line - 1]! + f.col - 1;
    if (raw.slice(at, at + value.length) !== value) throw new Error(`finding at line ${f.line} moved; re-run triage`);
    edits.push({ at, len: value.length, text: `<secret: ${name}, see ${ENV}>`, line: f.line - 1 });
  }
  let next = raw;
  for (const ed of edits.sort((x, y) => y.at - x.at)) next = next.slice(0, ed.at) + ed.text + next.slice(ed.at + ed.len);
  // A long value repeated elsewhere (outside a rule's context) is still the same secret; short weak
  // values like a url password may be ordinary words in prose, so only long ones are chased.
  for (const { finding: f, value } of raws) {
    if (value.length < 16) continue;
    const name = proposed.get(f.fingerprint) ?? fresh.get(f.fingerprint)!;
    next = next.split(value).join(`<secret: ${name}, see ${ENV}>`);
  }
  // In YAML frontmatter the pointer (': ', ', ') must sit inside a quoted scalar, or the doc stops parsing.
  const fm_lines = new Set(edits.filter((ed) => fm_end > 0 && ed.at < fm_end).map((ed) => ed.line));
  if (fm_lines.size) {
    const ls = next.split('\n');
    for (const i of fm_lines) {
      const m = /^(\s*(?:-\s+)?(?:[^:#\s][^:#]*?:\s+)?)(.*)$/.exec(ls[i]!);
      if (m && !/^["']/.test(m[2]!)) ls[i] = m[1]! + JSON.stringify(m[2]!);
    }
    next = ls.join('\n');
    try { parse_frontmatter(next); } catch { throw new Error('frontmatter would not parse after the move; move this value by hand'); }
  }
  if (find_secrets(next, e.path, cfg).some((r) => r.finding.kind === 'secret')) throw new Error('doc still holds a secret after the move');
  const gi = ensure_ignored(top);
  if (lines.length) {
    writeFileSync(env_path, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`, { mode: 0o600 });
    chmodSync(env_path, 0o600);
  }
  return { next, names: [...new Set(names)], gi, envPath: env_path };
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim();

/**
 * Files that differ from HEAD before the batch starts (dirty tracked files anywhere, plus
 * untracked and ignored files under the docs tree), with their contents, so a rollback
 * returns to the pre-apply state rather than to HEAD.
 */
function snapshot(top: string, docs_rel: string): Map<string, Buffer> {
  const snap = new Map<string, Buffer>();
  const paths = (args: string[]): string[] => {
    // not git(): its trim() would eat the leading space of the first ' M path' entry
    const toks = execFileSync('git', ['status', '--porcelain=v1', '-z', ...args], { cwd: top, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0');
    const out: string[] = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.length < 4) continue;
      out.push(t.slice(3));
      if (t[0] === 'R' || t[0] === 'C') i++; // rename/copy: next token is the old path
    }
    return out;
  };
  // The secret verdict appends to .env.hewtd and may edit .gitignore, so both come back on rollback.
  const rels = [...new Set([...paths(['--untracked-files=no']), ...paths(['--untracked-files=all', '--ignored', '--', docs_rel]), ENV, '.gitignore'])];
  for (const r of rels) {
    try { if (statSync(join(top, r)).isFile()) snap.set(r, readFileSync(join(top, r))); } catch { /* deleted in the worktree */ }
  }
  return snap;
}

/** Undo a failed batch: touched paths back to their pre-apply state, batch-created files removed. */
function rollback(top: string, abs: string[], snap: Map<string, Buffer>): void {
  const rels = abs.map((p) => relative(top, p));
  const in_head = new Set(git(top, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...rels]).split('\0').filter(Boolean));
  const tracked = rels.filter((r) => in_head.has(r));
  const created = rels.filter((r) => !in_head.has(r) && !snap.has(r));
  if (tracked.length) git(top, ['restore', '--staged', '--worktree', '--source=HEAD', '--', ...tracked]);
  const unstage = rels.filter((r) => !in_head.has(r));
  if (unstage.length) git(top, ['rm', '-q', '--cached', '-f', '--ignore-unmatch', '--', ...unstage]);
  // Uncommitted edits and pre-existing untracked/ignored files the batch overwrote come back as they were.
  for (const r of rels) { const b = snap.get(r); if (b) { mkdirSync(dirname(join(top, r)), { recursive: true }); writeFileSync(join(top, r), b); } }
  for (const r of created) {
    rmSync(join(top, r), { force: true });
    // Drop directories the batch created (e.g. a fresh archive/), never a non-empty one.
    for (let d = dirname(join(top, r)); d !== top && existsSync(d) && !readdirSync(d).length; d = dirname(d)) rmdirSync(d);
  }
}

/** Build the new file content for a verify/fields/unverifiable entry. */
function edit_doc(raw: string, e: ReviewEntry, today: string): string {
  const { last_verified: _ignored, ...fm } = e.frontmatter ?? {};
  const changes: Record<string, unknown> = { ...fm };
  if (e.sources) changes.sources = e.sources;
  if (e.verdict === 'verify') changes.last_verified = today;
  if (e.verdict === 'unverifiable') changes.confidence = 'low';
  const next = set_frontmatter_keys(raw, changes);
  if (!e.patch?.length) return next;
  const cut = next.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)?.[0].length ?? 0;
  let body = next.slice(cut);
  for (const p of e.patch) {
    if (body.split(p.old).length !== 2) throw new Error(`patch text not found exactly once: ${JSON.stringify(p.old.slice(0, 40))}`);
    body = body.replace(p.old, () => p.new);
  }
  return next.slice(0, cut) + body;
}

/** phrases: add new user_phrase entries to symptoms (cap and duplicates re-checked); returns null when nothing is left to add. */
function phrases_doc(raw: string, e: ReviewEntry, cfg: Awaited<ReturnType<typeof load_plugin_config>>): string | null {
  const { data } = parse_frontmatter<Record<string, unknown>>(raw);
  const symptoms: unknown[] = Array.isArray(data.symptoms) ? [...data.symptoms] : [];
  const add = build_phrases((e.phrases ?? []).map((query) => ({ query })), symptom_text(data), cfg.reconcile.secrets, cfg.reconcile.gaps.max_phrases_per_doc).accepted.map((a) => a.query);
  if (!add.length) return null;
  const i = symptoms.findIndex((s) => s && typeof s === 'object');
  if (i >= 0) {
    const s = symptoms[i] as Record<string, unknown>;
    symptoms[i] = { ...s, user_phrase: [...(Array.isArray(s.user_phrase) ? s.user_phrase : s.user_phrase ? [s.user_phrase] : []), ...add] };
  } else symptoms.push(...add);
  return set_frontmatter_keys(raw, { symptoms });
}

/** point: check the owner section and the no-loss rule, then write the one-line pointer into the copy. */
function point_doc(o: { raw: string; e: ReviewEntry; abs: string; owner_abs: string; owner_raw: string; today: string }): string {
  const { raw, e, abs, owner_abs, owner_raw, today } = o;
  const { summary, target } = e.pointer ?? { summary: '', target: '' };
  const anchor = target.split('#')[1] ?? '';
  const old = e.remove?.old ?? '';
  if (!old || !summary.trim() || /[\r\n]/.test(summary) || !anchor) throw new Error('point needs remove.old, a one-line pointer.summary and a target with #anchor');
  if (owner_abs === abs) throw new Error('a doc cannot point at itself');
  const owner = parse_frontmatter<Record<string, unknown>>(owner_raw);
  if (!heading_anchors(owner.content).has(anchor)) throw new Error(`anchor #${anchor} not found in ${target.split('#')[0]}`);
  const section = section_of(owner.content, anchor) ?? '';
  const missing = missing_tokens(old, section, summary);
  if (missing.length) throw new Error(`no-loss check failed, missing: ${missing.join(', ')}`);
  const heading = (section.split('\n')[0] ?? '').replace(/^#+\s*/, '').replace(/\s*\{#[^}]*\}\s*$/, '').trim() || anchor;
  const title = typeof owner.data.title === 'string' && owner.data.title ? owner.data.title : owner_abs.split('/').pop()!;
  const rel = relative(dirname(abs), owner_abs).split('\\').join('/');
  const line = `${summary.trim()} Details: [${title}: ${heading}](${rel}#${anchor})`;
  return edit_doc(raw, { path: e.path, content_hash: e.content_hash, verdict: 'point', patch: [{ old, new: line }] }, today);
}

/** overview: every member current and reconciled (or explicitly marked), then the new doc with kind: overview and no last_validated. */
async function overview_doc(e: ReviewEntry, docs_path: string, ledger: Ledger): Promise<string> {
  if (!e.path.endsWith('.md') || !e.members?.length || !e.draft?.trim()) throw new Error('overview needs a .md path, members and a draft');
  const stale: string[] = [], open: string[] = [];
  for (const m of e.members) {
    let hash: string;
    try { hash = hash_content(await readFile(join(docs_path, m.path), 'utf-8')); } catch { stale.push(m.path); continue; }
    if (hash !== m.content_hash) { stale.push(m.path); continue; }
    const st = member_state(ledger, m.path, hash);
    if (st !== 'reconciled') open.push(m.path);
    if (st === 'secret') throw new Error(`member is in the secret lane: ${m.path}`);
  }
  if (stale.length) throw new Error(`member changed since the review was written: ${stale.join(', ')}`);
  if (open.length) {
    if (!e.allow_unreviewed) throw new Error(`members not reconciled: ${open.join(', ')}`);
    const unmarked = open.filter((p) => !e.draft!.split('\n').some((l) => l.includes(`](`) && l.includes(p.split('/').pop()!) && l.includes('(unreviewed)')));
    if (unmarked.length) throw new Error(`draft must mark these links "(unreviewed)": ${unmarked.join(', ')}`);
  }
  const { last_verified: _v, last_validated: _l, ...fm } = e.frontmatter ?? {};
  return set_frontmatter(e.draft!, { ...fm, kind: 'overview', ...(e.sources && { sources: e.sources }) });
}

export async function apply_reviews(opts: {
  root: string;
  docs_path: string;
  files: string[];
  ledger: Ledger;
  ledger_file: string;
  today?: string;
}): Promise<ApplyResult> {
  const { root, docs_path, ledger } = opts;
  const today = opts.today ?? format_date(new Date());
  const cfg = await load_plugin_config(root);
  const secrets_cfg = cfg.reconcile.secrets;
  const reviews = await Promise.all(opts.files.map((f) => parse_review(f)));
  const top0 = git_root(root);
  const snap = top0 ? snapshot(top0, relative(top0, docs_path) || '.') : new Map<string, Buffer>();

  // Merge shards; the same doc in two files is a hard error before anything is written.
  const owner = new Map<string, string>();
  for (const r of reviews) {
    for (const { entry } of r.entries) {
      const key = entry.outside ? outside_key(entry.path) : entry.path;
      const prev = owner.get(key);
      if (prev) throw new Error(prev === r.file ? `${entry.path} appears twice in ${r.file}` : `${entry.path} appears in both ${prev} and ${r.file}`);
      owner.set(key, r.file);
    }
  }

  const outcomes: ApplyOutcome[] = [];
  const touched = new Set<string>(); // repo-relative via absolute paths
  const domains = new Set<string>();
  const applied: { entry: ReviewEntry; file: string; abs: string; outside?: boolean; env_names?: string[] }[] = [];
  let env_path: string | undefined; // set once .env.hewtd was written, so a rollback restores it
  const known = new Set<string>(get_all_domains());

  // A merge-then-point pair applies merge first: points run after every other entry.
  const queue = reviews.flatMap((r) => r.entries.map((x) => ({ ...x, r })));
  queue.sort((a, b) => Number(a.entry.verdict === 'point') - Number(b.entry.verdict === 'point'));
  const merged_ids = new Set<string>();
  const overview_members = new Map<string, Record<string, string>>();
  const pointers = new Map<string, { target: string; section_hash: string }>();
  const related_roots = (await load_plugin_config(root)).reconcile.related_repos.map((x) => resolve(root, x.path));
  {
      for (const { entry: e, accepted, r } of queue) {
      const review_ref = relative(root, r.file).split('\\').join('/');
      const abs = join(docs_path, e.path);
      // Hard guard: never write outside the project root (related repos are read-only).
      const rel = relative(root, abs);
      if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
        outcomes.push({ path: e.path, status: 'error', detail: 'path resolves outside the project root' });
        continue;
      }
      if (e.outside) {
        const key = outside_key(e.path);
        if (ledger.entries[key]?.verdict && ledger.entries[key]?.review_file === review_ref) { outcomes.push({ path: e.path, status: 'already-applied' }); continue; }
        if (!accepted) { outcomes.push({ path: e.path, status: 'rejected' }); continue; }
        if (!e.verdict) { outcomes.push({ path: e.path, status: 'skipped', detail: 'no verdict' }); continue; }
        const o = await apply_outside_entry({ docs_path, entry: e });
        if (o.status !== 'applied') { outcomes.push({ path: e.path, status: o.status, ...(o.detail && { detail: o.detail }) }); continue; }
        o.touched.forEach((t) => touched.add(t));
        if (o.domain) domains.add(o.domain);
        applied.push({ entry: e, file: review_ref, abs, outside: true });
        outcomes.push({ path: e.path, status: 'applied' });
        continue;
      }
      if (e.verdict === 'integrate' || e.verdict === 'delete') { outcomes.push({ path: e.path, status: 'error', detail: `"${e.verdict}" is only valid for outside entries` }); continue; }
      const led = ledger.entries[e.path];
      const done = !!led?.verdict && led.review_file === review_ref;
      const present = await exists(abs);
      if (done && (!present || hash_content(await readFile(abs, 'utf-8')) === led.content_hash)) {
        outcomes.push({ path: e.path, status: 'already-applied' });
        continue;
      }
      if (!accepted) { outcomes.push({ path: e.path, status: 'rejected' }); continue; }
      if (!e.verdict) { outcomes.push({ path: e.path, status: 'skipped', detail: 'no verdict' }); continue; }
      if (e.verdict === 'overview' && present) { outcomes.push({ path: e.path, status: 'error', detail: 'overview target already exists' }); continue; }
      if (!present && e.verdict !== 'overview') { outcomes.push({ path: e.path, status: 'error', detail: 'file not found' }); continue; }
      const raw = present ? await readFile(abs, 'utf-8') : ''; // a new overview is hashed as empty

      if (hash_content(raw) !== e.content_hash) {
        outcomes.push({ path: e.path, status: 'stale', detail: 'doc changed since the review was written' });
        continue;
      }
      let env_names_for: string[] | undefined;
      try {
        // Nothing the review proposes to write may carry a secret.
        assert_no_secrets([...(e.patch ?? []).map((p) => p.new), e.draft ?? '', e.pointer?.summary ?? '', ...(e.phrases ?? []), JSON.stringify(e.frontmatter ?? {})].join('\n'), e.path, secrets_cfg);
        if (e.verdict === 'merge') {
          const body = parse_frontmatter(raw).content;
          if (!e.section || !heading_anchors(body).has(e.section)) throw new Error(`section #${e.section ?? ''} not found in ${e.path}`);
          if (!e.patch?.length) throw new Error('merge needs a patch');
          const next = edit_doc(raw, e, today);
          if (!heading_anchors(parse_frontmatter(next).content).has(e.section)) throw new Error(`section #${e.section} gone after the merge`);
          // A merge only adds to the owner: whatever a patch replaces must still be there afterwards.
          const lost = [...new Set(e.patch.flatMap((pt) => missing_tokens(pt.old, parse_frontmatter(next).content, '')))];
          if (lost.length) throw new Error(`merge would drop owner text; missing: ${lost.join(', ')}`);
          await writeFile(abs, next, 'utf-8');
          touched.add(abs);
          merged_ids.add(e.id ?? e.path);
        } else if (e.verdict === 'overview') {
          await writeFile(abs, await overview_doc(e, docs_path, ledger), 'utf-8');
          touched.add(abs);
          overview_members.set(e.path, Object.fromEntries((e.members ?? []).map((m) => [m.path, m.content_hash])));
        } else if (e.verdict === 'point') {
          const target = e.pointer?.target ?? '';
          const owner_abs = resolve(docs_path, target.split('#')[0] ?? '');
          const in_docs = !relative(docs_path, owner_abs).startsWith('..');
          // Outside the docs tree only a related repo's doc is allowed, and it is only ever read.
          if (!in_docs && !related_roots.some((rr) => !relative(rr, owner_abs).startsWith('..'))) throw new Error('pointer target is outside the docs tree and not in a related repo');
          if (!(await exists(owner_abs))) throw new Error(`pointer target not found: ${target}`);
          if (e.depends_on_merge) {
            if (!merged_ids.has(e.depends_on_merge)) throw new Error(`merge "${e.depends_on_merge}" was not applied`);
            if (owner_abs !== join(docs_path, [...applied].find((a) => (a.entry.id ?? a.entry.path) === e.depends_on_merge)!.entry.path)) throw new Error('pointer target is not the merged doc');
          }
          const owner_raw = await readFile(owner_abs, 'utf-8');
          if (!e.depends_on_merge && hash_content(owner_raw) !== e.target_hash) throw new Error('owner doc changed since the review was written (or target_hash missing)');
          await writeFile(abs, point_doc({ raw, e, abs, owner_abs, owner_raw, today }), 'utf-8');
          pointers.set(e.path, { target, section_hash: hash_content(section_of(parse_frontmatter<Record<string, unknown>>(owner_raw).content, target.split('#')[1] ?? '') ?? '') });
          touched.add(abs);
        } else if (e.verdict === 'phrases') {
          const next = phrases_doc(raw, e, cfg);
          if (next === null) { outcomes.push({ path: e.path, status: 'skipped', detail: 'no new phrases to add' }); continue; }
          await writeFile(abs, next, 'utf-8');
          touched.add(abs);
        } else if (e.verdict === 'archive') {
          const res = await archive_doc({ project_root: root, docs_path, file: e.path, today, ...(e.reason && { reason: e.reason }) });
          if (!res.ok) throw new Error(res.errors.join('; '));
          touched.add(abs);
          touched.add(join(docs_path, res.to ?? ''));
        } else if (e.verdict === 'secret') {
          if (!top0) throw new Error('the secret verdict needs a git repo');
          const m = move_secrets(top0, raw, e, secrets_cfg);
          if (m.gi) touched.add(m.gi);
          env_path = m.envPath;
          await writeFile(abs, m.next, 'utf-8');
          touched.add(abs);
          env_names_for = m.names;
        } else if (e.verdict === 'rewrite') {
          const draft = join(review_dir(root), 'drafts', e.path);
          await mkdir(dirname(draft), { recursive: true });
          await writeFile(draft, e.draft ?? '', 'utf-8');
        } else {
          await writeFile(abs, edit_doc(raw, e, today), 'utf-8');
          touched.add(abs);
        }
        if (e.verdict !== 'rewrite') domains.add(e.path.split('/')[0] ?? '');
        applied.push({ entry: e, file: review_ref, abs, ...(env_names_for && { env_names: env_names_for }) });
        outcomes.push({ path: e.path, status: 'applied' });
      } catch (err) {
        outcomes.push({ path: e.path, status: 'error', detail: (err as Error).message });
      }
    }
  }

  const result: ApplyResult = { outcomes, touched: [] };
  if (!applied.length) return result;

  const top = git_root(root);
  let commit: string | undefined;
  try {
    if (domains.size) {
      const reg = await regenerate_indexes({
        docs_path, silent: true,
        domains: [...domains].filter((d) => known.has(d)) as never,
      });
      reg.files_written.forEach((f) => touched.add(f));
    }
    if (top && touched.size) {
      const paths = [...touched].map((p) => relative(top, p));
      const present = paths.filter((p) => existsSync(join(top, p)));
      // -f: apply wrote these itself, so an ignored target (archive/) must still be staged.
      // An empty pathspec would stage the whole tree (ignored files included).
      if (present.length) git(top, ['add', '-A', '-f', '--', ...present]);
      const gone = paths.filter((p) => !present.includes(p));
      if (gone.length) git(top, ['rm', '-q', '--cached', '--ignore-unmatch', '--', ...gone]);
      // Last line of defence: the staged diff may not add a secret.
      const added = git(top, ['diff', '--cached', '-U0', '--no-color', '--', ...paths]).split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
      assert_no_secrets(added, 'the staged diff', secrets_cfg);
      const first = reviews[0]!;
      if (git(top, ['status', '--porcelain', '--', ...paths])) git(top, ['commit', '-q', '--only', '-m', `docs(reconcile): ${first.scope || 'docs'} batch ${first.batch}`, '--', ...paths]);
      commit = git(top, ['rev-parse', '--short', 'HEAD']);
    }
  } catch (err) {
    let msg = (err as Error).message;
    if (top) {
      try { rollback(top, [...touched, ...(env_path ? [env_path] : [])], snap); } catch (rb_err) { msg += `; rollback also failed: ${(rb_err as Error).message}`; }
    }
    const failed = new Set(applied.map((a) => a.entry.path));
    return { outcomes: outcomes.map((o) => (failed.has(o.path) && o.status === 'applied' ? { ...o, status: 'error' as const, detail: `rolled back: ${msg}` } : o)), touched: [] };
  }

  for (const a of applied) {
    const dest = a.entry.verdict === 'archive' || a.outside ? undefined : a.abs;
    const raw = dest ? await readFile(dest, 'utf-8') : undefined;
    const key = a.outside ? outside_key(a.entry.path) : a.entry.path;
    const prev = ledger.entries[key];
    const rec = record_entry(ledger, {
      path: key,
      lane: prev?.lane ?? a.entry.lane ?? 'check',
      content_hash: raw !== undefined ? hash_content(raw) : a.entry.content_hash,
    });
    Object.assign(rec, { verdict: a.entry.verdict ?? '', reviewed_on: today, review_file: a.file, ...(a.env_names && { env_names: a.env_names }), ...(pointers.has(a.entry.path) && { pointer: pointers.get(a.entry.path)! }), ...(overview_members.has(a.entry.path) && { members: overview_members.get(a.entry.path)! }), ...(commit && { applied_commit: commit }) });
  }
  await save_ledger(opts.ledger_file, ledger);
  return { ...result, ...(commit && { commit }), touched: [...touched] };
}
