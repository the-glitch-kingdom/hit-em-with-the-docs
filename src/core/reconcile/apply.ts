/**
 * `hewtd reconcile --apply` (#54): the only writer. Merges review files,
 * rejects overlap, re-hashes each doc, applies accepted entries serially and
 * commits once per batch.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, relative } from 'path';
import { parseFrontmatter, setFrontmatter } from '../../utils/frontmatter.js';
import { formatDate } from '../metadata/generator.js';
import { archiveDoc } from '../archive/manage.js';
import { regenerateIndexes } from '../../generators/regenerate.js';
import { getAllDomains } from '../domains/registry.js';
import { hashContent, recordEntry, saveLedger, type Ledger } from './ledger.js';
import { gitRoot } from './triage.js';
import { assertNoSecrets } from './secrets.js';
import { loadPluginConfig } from '../../utils/config.js';
import { applyOutsideEntry, outsideKey } from './outside.js';
import { parseReview, reviewDir, type ReviewEntry } from './review.js';

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

const exists = (p: string) => stat(p).then(() => true, () => false);
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).trim();

/**
 * Files that differ from HEAD before the batch starts (dirty tracked files anywhere, plus
 * untracked and ignored files under the docs tree), with their contents, so a rollback
 * returns to the pre-apply state rather than to HEAD.
 */
function snapshot(top: string, docsRel: string): Map<string, Buffer> {
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
  const rels = [...paths(['--untracked-files=no']), ...paths(['--untracked-files=all', '--ignored', '--', docsRel])];
  for (const r of rels) {
    try { if (statSync(join(top, r)).isFile()) snap.set(r, readFileSync(join(top, r))); } catch { /* deleted in the worktree */ }
  }
  return snap;
}

/** Undo a failed batch: touched paths back to their pre-apply state, batch-created files removed. */
function rollback(top: string, abs: string[], snap: Map<string, Buffer>): void {
  const rels = abs.map((p) => relative(top, p));
  const inHead = new Set(git(top, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...rels]).split('\0').filter(Boolean));
  const tracked = rels.filter((r) => inHead.has(r));
  const created = rels.filter((r) => !inHead.has(r) && !snap.has(r));
  if (tracked.length) git(top, ['restore', '--staged', '--worktree', '--source=HEAD', '--', ...tracked]);
  const unstage = rels.filter((r) => !inHead.has(r));
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
function editDoc(raw: string, e: ReviewEntry, today: string): string {
  const { data, content } = parseFrontmatter<Record<string, unknown>>(raw);
  let body = content;
  for (const p of e.patch ?? []) {
    if (body.split(p.old).length !== 2) throw new Error(`patch text not found exactly once: ${JSON.stringify(p.old.slice(0, 40))}`);
    body = body.replace(p.old, () => p.new);
  }
  const { last_verified: _ignored, ...fm } = e.frontmatter ?? {};
  const next: Record<string, unknown> = { ...data, ...fm };
  if (e.sources) next.sources = e.sources;
  if (e.verdict === 'verify') next.last_verified = today;
  if (e.verdict === 'unverifiable') next.confidence = 'low';
  return setFrontmatter(body, next, raw);
}

export async function applyReviews(opts: {
  root: string;
  docsPath: string;
  files: string[];
  ledger: Ledger;
  ledgerFile: string;
  today?: string;
}): Promise<ApplyResult> {
  const { root, docsPath, ledger } = opts;
  const today = opts.today ?? formatDate(new Date());
  const secretsCfg = (await loadPluginConfig(root)).reconcile.secrets;
  const reviews = await Promise.all(opts.files.map((f) => parseReview(f)));
  const top0 = gitRoot(root);
  const snap = top0 ? snapshot(top0, relative(top0, docsPath) || '.') : new Map<string, Buffer>();

  // Merge shards; the same doc in two files is a hard error before anything is written.
  const owner = new Map<string, string>();
  for (const r of reviews) {
    for (const { entry } of r.entries) {
      const key = entry.outside ? outsideKey(entry.path) : entry.path;
      const prev = owner.get(key);
      if (prev) throw new Error(prev === r.file ? `${entry.path} appears twice in ${r.file}` : `${entry.path} appears in both ${prev} and ${r.file}`);
      owner.set(key, r.file);
    }
  }

  const outcomes: ApplyOutcome[] = [];
  const touched = new Set<string>(); // repo-relative via absolute paths
  const domains = new Set<string>();
  const applied: { entry: ReviewEntry; file: string; abs: string; outside?: boolean }[] = [];
  const known = new Set<string>(getAllDomains());

  for (const r of reviews) {
    const reviewRef = relative(root, r.file).split('\\').join('/');
    for (const { entry: e, accepted } of r.entries) {
      const abs = join(docsPath, e.path);
      // Hard guard: never write outside the project root (related repos are read-only).
      const rel = relative(root, abs);
      if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
        outcomes.push({ path: e.path, status: 'error', detail: 'path resolves outside the project root' });
        continue;
      }
      if (e.outside) {
        const key = outsideKey(e.path);
        if (ledger.entries[key]?.verdict && ledger.entries[key]?.review_file === reviewRef) { outcomes.push({ path: e.path, status: 'already-applied' }); continue; }
        if (!accepted) { outcomes.push({ path: e.path, status: 'rejected' }); continue; }
        if (!e.verdict) { outcomes.push({ path: e.path, status: 'skipped', detail: 'no verdict' }); continue; }
        const o = await applyOutsideEntry({ docsPath, entry: e });
        if (o.status !== 'applied') { outcomes.push({ path: e.path, status: o.status, ...(o.detail && { detail: o.detail }) }); continue; }
        o.touched.forEach((t) => touched.add(t));
        if (o.domain) domains.add(o.domain);
        applied.push({ entry: e, file: reviewRef, abs, outside: true });
        outcomes.push({ path: e.path, status: 'applied' });
        continue;
      }
      if (e.verdict === 'integrate' || e.verdict === 'delete') { outcomes.push({ path: e.path, status: 'error', detail: `"${e.verdict}" is only valid for outside entries` }); continue; }
      const led = ledger.entries[e.path];
      const done = !!led?.verdict && led.review_file === reviewRef;
      const present = await exists(abs);
      if (done && (!present || hashContent(await readFile(abs, 'utf-8')) === led.content_hash)) {
        outcomes.push({ path: e.path, status: 'already-applied' });
        continue;
      }
      if (!accepted) { outcomes.push({ path: e.path, status: 'rejected' }); continue; }
      if (!e.verdict) { outcomes.push({ path: e.path, status: 'skipped', detail: 'no verdict' }); continue; }
      if (!present) { outcomes.push({ path: e.path, status: 'error', detail: 'file not found' }); continue; }
      const raw = await readFile(abs, 'utf-8');
      if (hashContent(raw) !== e.content_hash) {
        outcomes.push({ path: e.path, status: 'stale', detail: 'doc changed since the review was written' });
        continue;
      }
      try {
        // Nothing the review proposes to write may carry a secret.
        assertNoSecrets([...(e.patch ?? []).map((p) => p.new), e.draft ?? '', JSON.stringify(e.frontmatter ?? {})].join('\n'), e.path, secretsCfg);
        if (e.verdict === 'archive') {
          const res = await archiveDoc({ projectRoot: root, docsPath, file: e.path, today, ...(e.reason && { reason: e.reason }) });
          if (!res.ok) throw new Error(res.errors.join('; '));
          touched.add(abs);
          touched.add(join(docsPath, res.to ?? ''));
        } else if (e.verdict === 'rewrite') {
          const draft = join(reviewDir(root), 'drafts', e.path);
          await mkdir(dirname(draft), { recursive: true });
          await writeFile(draft, e.draft ?? '', 'utf-8');
        } else {
          await writeFile(abs, editDoc(raw, e, today), 'utf-8');
          touched.add(abs);
        }
        if (e.verdict !== 'rewrite') domains.add(e.path.split('/')[0] ?? '');
        applied.push({ entry: e, file: reviewRef, abs });
        outcomes.push({ path: e.path, status: 'applied' });
      } catch (err) {
        outcomes.push({ path: e.path, status: 'error', detail: (err as Error).message });
      }
    }
  }

  const result: ApplyResult = { outcomes, touched: [] };
  if (!applied.length) return result;

  const top = gitRoot(root);
  let commit: string | undefined;
  try {
    if (domains.size) {
      const reg = await regenerateIndexes({
        docsPath, silent: true,
        domains: [...domains].filter((d) => known.has(d)) as never,
      });
      reg.filesWritten.forEach((f) => touched.add(f));
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
      assertNoSecrets(added, 'the staged diff', secretsCfg);
      const first = reviews[0]!;
      if (git(top, ['status', '--porcelain', '--', ...paths])) git(top, ['commit', '-q', '--only', '-m', `docs(reconcile): ${first.scope || 'docs'} batch ${first.batch}`, '--', ...paths]);
      commit = git(top, ['rev-parse', '--short', 'HEAD']);
    }
  } catch (err) {
    let msg = (err as Error).message;
    if (top) {
      try { rollback(top, [...touched], snap); } catch (rbErr) { msg += `; rollback also failed: ${(rbErr as Error).message}`; }
    }
    const failed = new Set(applied.map((a) => a.entry.path));
    return { outcomes: outcomes.map((o) => (failed.has(o.path) && o.status === 'applied' ? { ...o, status: 'error' as const, detail: `rolled back: ${msg}` } : o)), touched: [] };
  }

  for (const a of applied) {
    const dest = a.entry.verdict === 'archive' || a.outside ? undefined : a.abs;
    const raw = dest ? await readFile(dest, 'utf-8') : undefined;
    const key = a.outside ? outsideKey(a.entry.path) : a.entry.path;
    const prev = ledger.entries[key];
    const rec = recordEntry(ledger, {
      path: key,
      lane: prev?.lane ?? a.entry.lane ?? 'check',
      content_hash: raw !== undefined ? hashContent(raw) : a.entry.content_hash,
    });
    Object.assign(rec, { verdict: a.entry.verdict ?? '', reviewed_on: today, review_file: a.file, ...(commit && { applied_commit: commit }) });
  }
  await saveLedger(opts.ledgerFile, ledger);
  return { ...result, ...(commit && { commit }), touched: [...touched] };
}
