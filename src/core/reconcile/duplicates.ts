/**
 * Duplicate-section detection (#59 addendum): a doc that holds a copy of another doc's
 * section is flagged with the likely owner, so the judgment pass can propose merge-then-point.
 * Read-only. Sections compare by 5-word shingle Jaccard, so lightly edited copies match.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { readdir } from 'fs/promises';
import { basename, join, relative } from 'path';
import { normalizeBlock } from '../audit/retrieval.js';
import { flatSections } from '../links/anchors.js';
import type { PluginConfig } from '../../utils/config.js';
import { parseFrontmatter } from '../../utils/frontmatter.js';
import { tokenize } from './search.js';
import { findSecrets } from './secrets.js';

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

interface Sec { doc: string; anchor: string; label: Set<string>; words: Set<string>; shingles: Set<string>; docSize: number }

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.endsWith('.md') && e.name !== 'INDEX.md' && e.name !== 'REGISTRY.md') out.push(p);
  }
  return out;
}

function firstCommit(docsPath: string, rel: string): number | undefined {
  try {
    const out = execFileSync('git', ['log', '--follow', '--diff-filter=A', '--format=%ct', '--', rel], { cwd: docsPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const t = out.trim().split('\n').pop();
    return t ? Number(t) : undefined;
  } catch { return undefined; }
}

const jaccard = (a: Set<string>, b: Set<string>): number => {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
};

/**
 * Copy-holding docs keyed by docs-relative path. The whole tree is read, so a scoped triage
 * still finds owners outside its scope. Sections under the size floor are ignored.
 * shortcut: inverted index over shingles is quadratic on pervasive boilerplate; fine below a few thousand sections.
 */
export async function findDuplicates(docsPath: string, config: PluginConfig): Promise<Map<string, Duplicate[]>> {
  const floor = config.retrieval.near_duplicate_min_chars;
  const secs: Sec[] = [];
  for (const abs of await walk(docsPath)) {
    const raw = readFileSync(abs, 'utf-8');
    const rel = relative(docsPath, abs).split('\\').join('/');
    const { data, content } = parseFrontmatter<Record<string, unknown>>(raw);
    if (data.generated === true || data.tier === 'plan') continue;
    if (findSecrets(raw, rel, config.reconcile.secrets).some((r) => r.finding.kind === 'secret')) continue;
    const docLabel = `${typeof data.title === 'string' ? data.title : ''} ${typeof data.purpose === 'string' ? data.purpose : ''} ${basename(rel, '.md')}`;
    const docSize = tokenize(content).length || 1;
    for (const s of flatSections(content)) {
      if (normalizeBlock(s.text).length < floor) continue;
      const w = tokenize(normalizeBlock(s.text));
      const shingles = new Set<string>();
      for (let i = 0; i + SHINGLE <= w.length; i++) shingles.add(w.slice(i, i + SHINGLE).join(' '));
      if (shingles.size) secs.push({ doc: rel, anchor: s.anchor, label: new Set(tokenize(`${s.heading} ${docLabel}`)), words: new Set(w), shingles, docSize });
    }
  }

  const index = new Map<string, number[]>();
  secs.forEach((s, i) => { for (const sh of s.shingles) (index.get(sh) ?? index.set(sh, []).get(sh)!).push(i); });
  const parent = secs.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  for (let i = 0; i < secs.length; i++) {
    const shared = new Map<number, number>();
    for (const sh of secs[i]!.shingles) for (const j of index.get(sh)!) if (j > i && secs[j]!.doc !== secs[i]!.doc) shared.set(j, (shared.get(j) ?? 0) + 1);
    for (const [j, n] of shared) {
      if (n / (secs[i]!.shingles.size + secs[j]!.shingles.size - n) >= BAR) parent[find(j)] = find(i);
    }
  }

  const clusters = new Map<number, Sec[]>();
  secs.forEach((s, i) => (clusters.get(find(i)) ?? clusters.set(find(i), []).get(find(i))!).push(s));
  const born = new Map<string, number | undefined>();
  const age = (d: string): number | undefined => (born.has(d) ? born.get(d) : (born.set(d, firstCommit(docsPath, d)), born.get(d)));

  const out = new Map<string, Duplicate[]>();
  for (const members of clusters.values()) {
    if (new Set(members.map((m) => m.doc)).size < 2) continue;
    // Owner: the section whose heading/title/purpose best names the shared text, plus how much of its doc the text is
    // (a procedure doc is mostly its procedure; a big guide embedding it is not), then the older doc.
    const shared = members.map((m) => m.words).reduce((a, b) => new Set([...a].filter((w) => b.has(w))));
    const score = (m: Sec): number => (m.label.size ? [...m.label].filter((w) => shared.has(w)).length / m.label.size : 0) + m.words.size / m.docSize;
    const best = Math.max(...members.map(score));
    let top = members.filter((m) => Math.abs(score(m) - best) < 1e-9);
    if (new Set(top.map((m) => m.doc)).size > 1) {
      const ages = top.map((m) => age(m.doc));
      if (ages.every((a) => a !== undefined)) {
        const oldest = Math.min(...(ages as number[]));
        const older = top.filter((m) => age(m.doc) === oldest);
        if (new Set(older.map((m) => m.doc)).size === 1) top = older;
      }
    }
    top.sort((a, b) => a.doc.localeCompare(b.doc) || a.anchor.localeCompare(b.anchor));
    const owner = top[0]!;
    const tie = [...new Set(top.map((m) => m.doc))].filter((d) => d !== owner.doc);
    for (const m of members) {
      if (m.doc === owner.doc) continue;
      const overlap = jaccard(m.shingles, owner.shingles);
      if (overlap < BAR) continue;
      (out.get(m.doc) ?? out.set(m.doc, []).get(m.doc)!).push({ owner: owner.doc, section: owner.anchor, overlap: Math.round(overlap * 100) / 100, ...(tie.length && { tie }) });
    }
  }
  return out;
}
