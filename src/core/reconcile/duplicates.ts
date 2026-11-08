/**
 * Duplicate-section detection (#59 addendum): a doc that holds a copy of another doc's
 * section is flagged with the likely owner, so the judgment pass can propose merge-then-point.
 * Read-only. Sections compare by 5-word shingle Jaccard, so lightly edited copies match.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { readdir } from 'fs/promises';
import { basename, join, relative } from 'path';
import { normalize_block } from '../audit/retrieval.js';
import { flat_sections } from '../links/anchors.js';
import type { PluginConfig } from '../../utils/config.js';
import { parse_frontmatter } from '../../utils/frontmatter.js';
import { extract_tokens } from './search.js';
import { find_secrets } from './secrets.js';

export interface Duplicate {
  /** docs-relative path of the doc that should own the text */
  owner: string;
  /** anchor of the owner's section */
  section: string;
  /** Jaccard overlap of 5-word shingles, 0..1 */
  overlap: number;
  /** other docs equally good as owner (no label or age winner): left to the judgment pass */
  tie?: string[];
}

const SHINGLE = 5;
const BAR = 0.5;
const SKIP_DIRS = new Set(['archive', 'drafts']);

interface Sec { doc: string; anchor: string; label: Set<string>; words: Set<string>; shingles: Set<string>; doc_size: number }

async function list_markdown_files(dir_path: string, found: string[] = []): Promise<string[]> {
  for (const entry of (await readdir(dir_path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const entry_path = join(dir_path, entry.name);
    if (entry.isDirectory()) await list_markdown_files(entry_path, found);
    else if (entry.name.endsWith('.md') && entry.name !== 'INDEX.md' && entry.name !== 'REGISTRY.md') found.push(entry_path);
  }
  return found;
}

function find_first_commit(docs_path: string, doc_path: string): number | undefined {
  try {
    // eslint-disable-next-line id-denylist -- child_process option name
    const log_output = execFileSync('git', ['log', '--follow', '--diff-filter=A', '--format=%ct', '--', doc_path], { cwd: docs_path, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const timestamp = log_output.trim().split('\n').pop();
    return timestamp ? Number(timestamp) : undefined;
  } catch { return undefined; }
}

const compute_jaccard = (a: Set<string>, b: Set<string>): number => {
  let shared_count = 0;
  for (const token of a) if (b.has(token)) shared_count++;
  return shared_count / (a.size + b.size - shared_count);
};

/**
 * Copy-holding docs keyed by docs-relative path. The whole tree is read, so a scoped triage
 * still finds owners outside its scope. Sections under the size floor are ignored.
 * Shingles found in more than MAX_POSTING sections are skipped (boilerplate), which bounds the pairwise work.
 */
const MAX_POSTING = 20;

export async function find_duplicates(docs_path: string, config: PluginConfig): Promise<Map<string, Duplicate[]>> {
  const floor = config.retrieval.near_duplicate_min_chars;
  const sections: Sec[] = [];
  for (const abs_path of await list_markdown_files(docs_path)) {
    const raw_text = readFileSync(abs_path, 'utf-8');
    const doc_path = relative(docs_path, abs_path).split('\\').join('/');
    const { data, content } = parse_frontmatter<Record<string, unknown>>(raw_text);
    if (data.generated === true || data.tier === 'plan') continue;
    if (find_secrets(raw_text, doc_path, config.reconcile.secrets).some((raw_secret) => raw_secret.finding.kind === 'secret')) continue;
    const doc_label = `${typeof data.title === 'string' ? data.title : ''} ${typeof data.purpose === 'string' ? data.purpose : ''} ${basename(doc_path, '.md')}`;
    const doc_size = extract_tokens(content).length || 1;
    for (const section of flat_sections(content)) {
      if (normalize_block(section.text).length < floor) continue;
      const tokens = extract_tokens(normalize_block(section.text));
      const shingles = new Set<string>();
      for (let i = 0; i + SHINGLE <= tokens.length; i++) shingles.add(tokens.slice(i, i + SHINGLE).join(' '));
      if (shingles.size) sections.push({ doc: doc_path, anchor: section.anchor, label: new Set(extract_tokens(`${section.heading} ${doc_label}`)), words: new Set(tokens), shingles, doc_size });
    }
  }

  const index = new Map<string, number[]>();
  sections.forEach((section, i) => { for (const shingle of section.shingles) (index.get(shingle) ?? index.set(shingle, []).get(shingle)!).push(i); });
  const parent = sections.map((_, i) => i);
  const find_root = (item: number): number => (parent[item] === item ? item : (parent[item] = find_root(parent[item]!)));
  for (let i = 0; i < sections.length; i++) {
    const shared_counts = new Map<number, number>();
    for (const shingle of sections[i]!.shingles) {
      const posting = index.get(shingle)!;
      if (posting.length > MAX_POSTING) continue; // boilerplate shared by many sections is not a copied procedure
      for (const j of posting) if (j > i && sections[j]!.doc !== sections[i]!.doc) shared_counts.set(j, (shared_counts.get(j) ?? 0) + 1);
    }
    for (const [j, shared_count] of shared_counts) {
      if (shared_count / (sections[i]!.shingles.size + sections[j]!.shingles.size - shared_count) >= BAR) parent[find_root(j)] = find_root(i);
    }
  }

  const clusters = new Map<number, Sec[]>();
  sections.forEach((section, i) => (clusters.get(find_root(i)) ?? clusters.set(find_root(i), []).get(find_root(i))!).push(section));
  const first_commit_dates = new Map<string, number | undefined>();
  const find_age = (doc: string): number | undefined => (first_commit_dates.has(doc) ? first_commit_dates.get(doc) : (first_commit_dates.set(doc, find_first_commit(docs_path, doc)), first_commit_dates.get(doc)));

  const duplicates_by_doc = new Map<string, Duplicate[]>();
  for (const members of clusters.values()) {
    if (new Set(members.map((member) => member.doc)).size < 2) continue;
    // Owner: the section whose heading/title/purpose best names the shared text, plus how much of its doc the text is
    // (a procedure doc is mostly its procedure; a big guide embedding it is not), then the older doc.
    const shared_words = members.map((member) => member.words).reduce((a, b) => new Set([...a].filter((word) => b.has(word))));
    const compute_score = (member: Sec): number => (member.label.size ? [...member.label].filter((word) => shared_words.has(word)).length / member.label.size : 0) + member.words.size / member.doc_size;
    const best = Math.max(...members.map(compute_score));
    let top_members = members.filter((member) => Math.abs(compute_score(member) - best) < 1e-9);
    if (new Set(top_members.map((member) => member.doc)).size > 1) {
      const ages = top_members.map((member) => find_age(member.doc));
      if (ages.every((a) => a !== undefined)) {
        const oldest = Math.min(...(ages as number[]));
        const older = top_members.filter((member) => find_age(member.doc) === oldest);
        if (new Set(older.map((member) => member.doc)).size === 1) top_members = older;
      }
    }
    top_members.sort((a, b) => a.doc.localeCompare(b.doc) || a.anchor.localeCompare(b.anchor));
    const owner = top_members[0]!;
    const tie = [...new Set(top_members.map((member) => member.doc))].filter((doc) => doc !== owner.doc);
    for (const member of members) {
      if (member.doc === owner.doc) continue;
      const overlap = compute_jaccard(member.shingles, owner.shingles);
      if (overlap < BAR) continue;
      (duplicates_by_doc.get(member.doc) ?? duplicates_by_doc.set(member.doc, []).get(member.doc)!).push({ owner: owner.doc, section: owner.anchor, overlap: Math.round(overlap * 100) / 100, ...(tie.length && { tie }) });
    }
  }
  return duplicates_by_doc;
}
