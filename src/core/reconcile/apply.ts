/**
 * `hewtd reconcile --apply` (#54): the only writer. Merges review files,
 * rejects overlap, re-hashes each doc, applies accepted entries serially and
 * commits once per batch.
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname, join, relative } from 'path';
import { parseFrontmatter, setFrontmatter } from '../../utils/frontmatter.js';
import { formatDate } from '../metadata/generator.js';
import { archiveDoc } from '../archive/manage.js';
import { regenerateIndexes } from '../../generators/regenerate.js';
import { getAllDomains } from '../domains/registry.js';
import { hashContent, recordEntry, saveLedger, type Ledger } from './ledger.js';
import { gitRoot } from './triage.js';
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
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

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
  return setFrontmatter(body, next);
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
  const reviews = await Promise.all(opts.files.map((f) => parseReview(f)));

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

  if (domains.size) {
    const reg = await regenerateIndexes({
      docsPath, silent: true,
      domains: [...domains].filter((d) => known.has(d)) as never,
    });
    reg.filesWritten.forEach((f) => touched.add(f));
  }

  const top = gitRoot(root);
  let commit: string | undefined;
  if (top && touched.size) {
    const paths = [...touched].map((p) => relative(top, p));
    const present = paths.filter((p) => existsSync(join(top, p)));
    git(top, ['add', '-A', '--', ...present]);
    const first = reviews[0]!;
    if (git(top, ['status', '--porcelain', '--', ...paths])) git(top, ['commit', '-q', '--only', '-m', `docs(reconcile): ${first.scope || 'docs'} batch ${first.batch}`, '--', ...paths]);
    commit = git(top, ['rev-parse', '--short', 'HEAD']);
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
