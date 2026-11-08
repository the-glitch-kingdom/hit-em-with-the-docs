/**
 * Overview seeding (#59): propose a cross-domain member list for a flow or question.
 * Reads the docs tree and the ledger; the only write is the members file under
 * .hewtd/reconcile/ (never the docs tree).
 */
import { readFileSync } from 'fs';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { dirname, join, posix, relative } from 'path';
import type { PluginConfig } from '../../utils/config.js';
import { parse_frontmatter } from '../../utils/frontmatter.js';
import { extract_links, slugify } from '../../utils/markdown.js';
import { hash_content, type Ledger } from './ledger.js';
import { render_review, review_dir, next_batch } from './review.js';
import { find_duplicates, type Duplicate } from './duplicates.js';
import { search_docs } from './search.js';
import { assert_no_secrets } from './secrets.js';

export type MemberState = 'reconciled' | 'unreviewed' | 'stale' | 'secret';
/** `duplicates`: sections of this member copied from another member; propose merge-then-point alongside the overview. */
export interface OverviewMember { path: string; state: MemberState; via: 'search' | 'link'; duplicates?: Duplicate[] }
export interface OverviewSeed {
  question: string;
  members: OverviewMember[];
  existingOverview?: { path: string; coverage: number };
}

const posix_path = (p: string): string => p.split('\\').join('/');

/** Doc-relative internal links of a doc, resolved to docs-relative paths (anchors stripped). */
function link_targets(rel: string, content: string): string[] {
  const out: string[] = [];
  for (const l of extract_links(content)) {
    if (!l.is_internal || /^[a-z][a-z0-9+.-]*:/i.test(l.url)) continue;
    const u = l.url.split('#')[0]!;
    if (u.endsWith('.md')) out.push(posix.normalize(posix.join(posix.dirname(rel), u)));
  }
  return out;
}

async function all_docs(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'archive') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await all_docs(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

export function member_state(ledger: Ledger, rel: string, hash: string): MemberState {
  const e = ledger.entries[rel];
  if (e?.lane === 'secret') return 'secret';
  if (!e) return 'unreviewed';
  if (e.content_hash !== hash) return 'stale';
  return e.verdict === 'verify' || e.lane === 'clean' ? 'reconciled' : 'unreviewed';
}

export async function seed_overview(opts: {
  docs_path: string; config: PluginConfig; ledger: Ledger; question: string; limit?: number | undefined;
}): Promise<OverviewSeed> {
  const { docs_path, config, ledger, question } = opts;
  const limit = opts.limit ?? 12;
  const hits = await search_docs(docs_path, question, { limit: Number.MAX_SAFE_INTEGER, config });
  const scored = new Set(hits.map((h) => h.path));
  const picked = new Map<string, 'search' | 'link'>();
  // Half the cap comes straight from search; the rest are linked docs that also scored.
  for (const h of hits.slice(0, Math.ceil(limit / 2))) picked.set(h.path, 'search');
  for (const seed of [...picked.keys()]) {
    for (const t of link_targets(seed, readFileSync(join(docs_path, seed), 'utf-8'))) {
      if (picked.size >= limit) break;
      if (scored.has(t) && !picked.has(t)) picked.set(t, 'link');
    }
  }
  for (const h of hits) if (picked.size < limit && !picked.has(h.path)) picked.set(h.path, 'search');

  const dups = await find_duplicates(docs_path, config);
  const members: OverviewMember[] = [...picked].map(([path, via]) => {
    const copies = (dups.get(path) ?? []).filter((c) => picked.has(c.owner));
    return { path, via, state: member_state(ledger, path, hash_content(readFileSync(join(docs_path, path), 'utf-8'))), ...(copies.length && { duplicates: copies }) };
  });

  let existing_overview: OverviewSeed['existingOverview'];
  const want = new Set(members.map((m) => m.path));
  for (const abs of await all_docs(docs_path)) {
    const raw = readFileSync(abs, 'utf-8');
    const { data, content } = parse_frontmatter<Record<string, unknown>>(raw);
    if (data.kind !== 'overview' || !want.size) continue;
    const rel = posix_path(relative(docs_path, abs));
    const covered = new Set(link_targets(rel, content).filter((t) => want.has(t))).size / want.size;
    if (covered >= config.overview.min_link_coverage && covered > (existing_overview?.coverage ?? 0)) {
      existing_overview = { path: rel, coverage: Math.round(covered * 100) / 100 };
    }
  }
  return { question, members, ...(existing_overview ? { existingOverview: existing_overview } : {}) };
}

/** The members file: the user confirms the list from it before anything is drafted. */
export async function write_members_file(root: string, seed: OverviewSeed): Promise<string> {
  const file = join(review_dir(root), `overview-${slugify(seed.question).slice(0, 60) || 'overview'}.json`);
  const text = JSON.stringify(seed, null, 2) + '\n';
  assert_no_secrets(text, 'the overview members file');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text, 'utf-8');
  return file;
}

/** `--write-review --overview <members-file>`: a one-entry review skeleton, members hashed now; the draft is filled by the slash command. */
export async function write_overview_review(opts: { root: string; docs_path: string; members_file: string; batch?: string | undefined }): Promise<string> {
  const seed = JSON.parse(await readFile(opts.members_file, 'utf-8')) as OverviewSeed;
  const members = await Promise.all(seed.members.filter((m) => m.state !== 'secret').map(async (m) => ({
    path: m.path, content_hash: hash_content(await readFile(join(opts.docs_path, m.path), 'utf-8')),
  })));
  if (!members.length) throw new Error('members file has no usable members');
  const dir = review_dir(opts.root);
  const batch = opts.batch ?? (await next_batch(dir));
  const folder = posix.dirname(members[0]!.path);
  const slug = slugify(seed.question).slice(0, 60) || 'overview';
  const entry = {
    path: posix.join(folder === '.' ? '' : folder, `overview-${slug}.md`), content_hash: hash_content(''), verdict: null,
    members, draft: '', frontmatter: { title: seed.question, purpose: '', symptoms: [seed.question] },
  };
  const file = join(dir, `review-${batch}-1.md`);
  await mkdir(dir, { recursive: true });
  await writeFile(file, render_review({ batch, shard: 1, scope: 'overview' }, [entry]), { encoding: 'utf-8', flag: 'wx' });
  return file;
}
