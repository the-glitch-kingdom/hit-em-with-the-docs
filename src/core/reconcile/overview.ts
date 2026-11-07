/**
 * Overview seeding (#59): propose a cross-domain member list for a flow or question.
 * Reads the docs tree and the ledger; the only write is the members file under
 * .hewtd/reconcile/ (never the docs tree).
 */
import { readFileSync } from 'fs';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { dirname, join, posix, relative } from 'path';
import type { PluginConfig } from '../../utils/config.js';
import { parseFrontmatter } from '../../utils/frontmatter.js';
import { extractLinks, slugify } from '../../utils/markdown.js';
import { hashContent, type Ledger } from './ledger.js';
import { renderReview, reviewDir, nextBatch } from './review.js';
import { searchDocs } from './search.js';
import { assertNoSecrets } from './secrets.js';

export type MemberState = 'reconciled' | 'unreviewed' | 'stale' | 'secret';
export interface OverviewMember { path: string; state: MemberState; via: 'search' | 'link' }
export interface OverviewSeed {
  question: string;
  members: OverviewMember[];
  existingOverview?: { path: string; coverage: number };
}

const posixPath = (p: string): string => p.split('\\').join('/');

/** Doc-relative internal links of a doc, resolved to docs-relative paths (anchors stripped). */
function linkTargets(rel: string, content: string): string[] {
  const out: string[] = [];
  for (const l of extractLinks(content)) {
    if (!l.isInternal || /^[a-z][a-z0-9+.-]*:/i.test(l.url)) continue;
    const u = l.url.split('#')[0]!;
    if (u.endsWith('.md')) out.push(posix.normalize(posix.join(posix.dirname(rel), u)));
  }
  return out;
}

async function allDocs(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'archive') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await allDocs(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

export function memberState(ledger: Ledger, rel: string, hash: string): MemberState {
  const e = ledger.entries[rel];
  if (e?.lane === 'secret') return 'secret';
  if (!e) return 'unreviewed';
  if (e.content_hash !== hash) return 'stale';
  return e.verdict === 'verify' || e.lane === 'clean' ? 'reconciled' : 'unreviewed';
}

export async function seedOverview(opts: {
  docsPath: string; config: PluginConfig; ledger: Ledger; question: string; limit?: number | undefined;
}): Promise<OverviewSeed> {
  const { docsPath, config, ledger, question } = opts;
  const limit = opts.limit ?? 12;
  const hits = await searchDocs(docsPath, question, { limit: Number.MAX_SAFE_INTEGER, config });
  const scored = new Set(hits.map((h) => h.path));
  const picked = new Map<string, 'search' | 'link'>();
  // Half the cap comes straight from search; the rest are linked docs that also scored.
  for (const h of hits.slice(0, Math.ceil(limit / 2))) picked.set(h.path, 'search');
  for (const seed of [...picked.keys()]) {
    for (const t of linkTargets(seed, readFileSync(join(docsPath, seed), 'utf-8'))) {
      if (picked.size >= limit) break;
      if (scored.has(t) && !picked.has(t)) picked.set(t, 'link');
    }
  }
  for (const h of hits) if (picked.size < limit && !picked.has(h.path)) picked.set(h.path, 'search');

  const members = [...picked].map(([path, via]) => ({
    path, via, state: memberState(ledger, path, hashContent(readFileSync(join(docsPath, path), 'utf-8'))),
  }));

  let existingOverview: OverviewSeed['existingOverview'];
  const want = new Set(members.map((m) => m.path));
  for (const abs of await allDocs(docsPath)) {
    const raw = readFileSync(abs, 'utf-8');
    const { data, content } = parseFrontmatter<Record<string, unknown>>(raw);
    if (data.kind !== 'overview' || !want.size) continue;
    const rel = posixPath(relative(docsPath, abs));
    const covered = new Set(linkTargets(rel, content).filter((t) => want.has(t))).size / want.size;
    if (covered >= config.overview.min_link_coverage && covered > (existingOverview?.coverage ?? 0)) {
      existingOverview = { path: rel, coverage: Math.round(covered * 100) / 100 };
    }
  }
  return { question, members, ...(existingOverview ? { existingOverview } : {}) };
}

/** The members file: the user confirms the list from it before anything is drafted. */
export async function writeMembersFile(root: string, seed: OverviewSeed): Promise<string> {
  const file = join(reviewDir(root), `overview-${slugify(seed.question).slice(0, 60) || 'overview'}.json`);
  const text = JSON.stringify(seed, null, 2) + '\n';
  assertNoSecrets(text, 'the overview members file');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, 'utf-8');
  return file;
}

/** `--write-review --overview <members-file>`: a one-entry review skeleton, members hashed now; the draft is filled by the slash command. */
export async function writeOverviewReview(opts: { root: string; docsPath: string; membersFile: string; batch?: string | undefined }): Promise<string> {
  const seed = JSON.parse(await readFile(opts.membersFile, 'utf-8')) as OverviewSeed;
  const members = await Promise.all(seed.members.filter((m) => m.state !== 'secret').map(async (m) => ({
    path: m.path, content_hash: hashContent(await readFile(join(opts.docsPath, m.path), 'utf-8')),
  })));
  if (!members.length) throw new Error('members file has no usable members');
  const dir = reviewDir(opts.root);
  const batch = opts.batch ?? (await nextBatch(dir));
  const folder = posix.dirname(members[0]!.path);
  const slug = slugify(seed.question).slice(0, 60) || 'overview';
  const entry = {
    path: posix.join(folder === '.' ? '' : folder, `overview-${slug}.md`), content_hash: hashContent(''), verdict: null,
    members, draft: '', frontmatter: { title: seed.question, purpose: '', symptoms: [seed.question] },
  };
  const file = join(dir, `review-${batch}-1.md`);
  await mkdir(dir, { recursive: true });
  await writeFile(file, renderReview({ batch, shard: 1, scope: 'overview' }, [entry]), { encoding: 'utf-8', flag: 'wx' });
  return file;
}
