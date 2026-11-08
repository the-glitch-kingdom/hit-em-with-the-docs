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
import { extract_links, format_slug } from '../../utils/markdown.js';
import { compute_content_hash, type Ledger } from './ledger.js';
import { render_review, resolve_review_dir, find_next_batch } from './review.js';
import { find_duplicates, type Duplicate } from './duplicates.js';
import { find_docs } from './search.js';
import { validate_no_secrets } from './secrets.js';

export type MemberState = 'reconciled' | 'unreviewed' | 'stale' | 'secret';
/** `duplicates`: sections of this member copied from another member; propose merge-then-point alongside the overview. */
export interface OverviewMember { path: string; state: MemberState; via: 'search' | 'link'; duplicates?: Duplicate[] }
export interface OverviewSeed {
  question: string;
  members: OverviewMember[];
  existingOverview?: { path: string; coverage: number };
}

const format_posix_path = (path_text: string): string => path_text.split('\\').join('/');

/** Doc-relative internal links of a doc, resolved to docs-relative paths (anchors stripped). */
function extract_link_targets(doc_path: string, content: string): string[] {
  const found: string[] = [];
  for (const line of extract_links(content)) {
    if (!line.is_internal || /^[a-z][a-z0-9+.-]*:/i.test(line.url)) continue;
    const unit = line.url.split('#')[0]!;
    if (unit.endsWith('.md')) found.push(posix.normalize(posix.join(posix.dirname(doc_path), unit)));
  }
  return found;
}

async function list_all_docs(dir_path: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir_path, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'archive') continue;
    const path_text = join(dir_path, entry.name);
    if (entry.isDirectory()) await list_all_docs(path_text, found);
    else if (entry.name.endsWith('.md')) found.push(path_text);
  }
  return found;
}

export function get_member_state(ledger: Ledger, doc_path: string, hash: string): MemberState {
  const entry = ledger.entries[doc_path];
  if (entry?.lane === 'secret') return 'secret';
  if (!entry) return 'unreviewed';
  if (entry.content_hash !== hash) return 'stale';
  return entry.verdict === 'verify' || entry.lane === 'clean' ? 'reconciled' : 'unreviewed';
}

export async function load_overview_seed(options: {
  docs_root: string; config: PluginConfig; ledger: Ledger; question: string; limit?: number | undefined;
}): Promise<OverviewSeed> {
  const { docs_root: docs_root, config, ledger, question } = options;
  const limit = options.limit ?? 12;
  const matches = await find_docs(docs_root, question, { limit: Number.MAX_SAFE_INTEGER, config });
  const scored = new Set(matches.map((match) => match.path));
  const picked = new Map<string, 'search' | 'link'>();
  // Half the cap comes straight from search; the rest are linked docs that also scored.
  for (const match of matches.slice(0, Math.ceil(limit / 2))) picked.set(match.path, 'search');
  for (const seed of [...picked.keys()]) {
    for (const link_target of extract_link_targets(seed, readFileSync(join(docs_root, seed), 'utf-8'))) {
      if (picked.size >= limit) break;
      if (scored.has(link_target) && !picked.has(link_target)) picked.set(link_target, 'link');
    }
  }
  for (const match of matches) if (picked.size < limit && !picked.has(match.path)) picked.set(match.path, 'search');

  const dups = await find_duplicates(docs_root, config);
  const members: OverviewMember[] = [...picked].map(([path, via]) => {
    const copies = (dups.get(path) ?? []).filter((duplicate) => picked.has(duplicate.owner));
    return { path, via, state: get_member_state(ledger, path, compute_content_hash(readFileSync(join(docs_root, path), 'utf-8'))), ...(copies.length && { duplicates: copies }) };
  });

  let existing_overview: OverviewSeed['existingOverview'];
  const want = new Set(members.map((member) => member.path));
  for (const abs_path of await list_all_docs(docs_root)) {
    const raw_text = readFileSync(abs_path, 'utf-8');
    const { data, content } = parse_frontmatter<Record<string, unknown>>(raw_text);
    if (data.kind !== 'overview' || !want.size) continue;
    const doc_path = format_posix_path(relative(docs_root, abs_path));
    const covered = new Set(extract_link_targets(doc_path, content).filter((link_target) => want.has(link_target))).size / want.size;
    if (covered >= config.overview.min_link_coverage && covered > (existing_overview?.coverage ?? 0)) {
      existing_overview = { path: doc_path, coverage: Math.round(covered * 100) / 100 };
    }
  }
  return { question, members, ...(existing_overview ? { existingOverview: existing_overview } : {}) };
}

/** The members file: the user confirms the list from it before anything is drafted. */
export async function write_members_file(repo_root: string, seed: OverviewSeed): Promise<string> {
  const file = join(resolve_review_dir(repo_root), `overview-${format_slug(seed.question).slice(0, 60) || 'overview'}.json`);
  const json_text = JSON.stringify(seed, null, 2) + '\n';
  validate_no_secrets(json_text, 'the overview members file');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, json_text, 'utf-8');
  return file;
}

/** `--write-review --overview <members-file>`: a one-entry review skeleton, members hashed now; the draft is filled by the slash command. */
export async function write_overview_review(options: { root: string; docs_root: string; members_file: string; batch?: string | undefined }): Promise<string> {
  const seed = JSON.parse(await readFile(options.members_file, 'utf-8')) as OverviewSeed;
  const members = await Promise.all(seed.members.filter((member) => member.state !== 'secret').map(async (member) => ({
    path: member.path, content_hash: compute_content_hash(await readFile(join(options.docs_root, member.path), 'utf-8')),
  })));
  if (!members.length) throw new Error('members file has no usable members');
  const dir_path = resolve_review_dir(options.root);
  const batch = options.batch ?? (await find_next_batch(dir_path));
  const folder = posix.dirname(members[0]!.path);
  const slug = format_slug(seed.question).slice(0, 60) || 'overview';
  const entry = {
    path: posix.join(folder === '.' ? '' : folder, `overview-${slug}.md`), content_hash: compute_content_hash(''), verdict: null,
    members, draft: '', frontmatter: { title: seed.question, purpose: '', symptoms: [seed.question] },
  };
  const file = join(dir_path, `review-${batch}-1.md`);
  await mkdir(dir_path, { recursive: true });
  await writeFile(file, render_review({ batch, shard: 1, scope: 'overview' }, [entry]), { encoding: 'utf-8', flag: 'wx' });
  return file;
}
