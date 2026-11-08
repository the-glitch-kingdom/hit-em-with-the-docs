/**
 * Back-links from overview members to their `kind: overview` doc (#51).
 * Inserts `Part of: [Title](rel.md)` after the first H1 of each member that
 * does not already link to the overview. Only the inserted line changes; the
 * frontmatter block is kept byte-identical. Idempotent: a second run finds the
 * link and writes nothing.
 */

import { readFile, writeFile } from 'fs/promises';
import { basename, dirname, join, relative } from 'path';
import { parse_frontmatter } from '../../utils/frontmatter.js';
import { build_link_graph } from './tracker.js';
import { is_out_of_overview_scope } from './clusters.js';

export interface BacklinkChange {
  /** Member path relative to the docs root. */
  file: string;
  /** Overview paths (relative to the docs root) the member now links to, sorted. */
  overviews: string[];
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export async function add_overview_backlinks(docs_path: string, options: { dry_run?: boolean } = {}): Promise<BacklinkChange[]> {
  const graph = await build_link_graph(docs_path);
  const read = new Map<string, { raw_text: string; data: Record<string, unknown> }>();
  const load_doc = async (id: string) => {
    if (!read.has(id)) {
      const raw_text = await readFile(join(docs_path, id), 'utf-8');
      let data: Record<string, unknown> = {};
      try { data = parse_frontmatter<Record<string, unknown>>(raw_text).data; } catch { /* plain doc */ }
      read.set(id, { raw_text: raw_text, data });
    }
    return read.get(id)!;
  };
  const is_generated = (id: string, doc: Record<string, unknown>) =>
    doc.generated === true || ['INDEX.md', 'REGISTRY.md'].includes(basename(id));

  const linked = new Set(graph.edges.map((edge) => `${edge.source}\0${edge.target}`));
  const wanted = new Map<string, Set<string>>(); // member -> overviews
  const overview_ids = new Set<string>();
  for (const node of graph.nodes) {
    const { data } = await load_doc(node.id);
    if (data.kind === 'overview' && !is_out_of_overview_scope(node.id, data)) overview_ids.add(node.id);
  }

  for (const edge of graph.edges) {
    if (!overview_ids.has(edge.source) || edge.source === edge.target) continue;
    if (linked.has(`${edge.target}\0${edge.source}`)) continue;
    const match = await load_doc(edge.target);
    if (is_generated(edge.target, match.data) || is_out_of_overview_scope(edge.target, match.data)) continue;
    // Text check too: a path the link parser can't read (spaces, parens) must not be re-inserted every run.
    if (match.raw_text.includes(`](${relative(dirname(edge.target), edge.source).split('\\').join('/')})`)) continue;
    (wanted.get(edge.target) ?? wanted.set(edge.target, new Set()).get(edge.target)!).add(edge.source);
  }

  const changes: BacklinkChange[] = [];
  for (const [file, set] of [...wanted].sort(([a], [b]) => a.localeCompare(b))) {
    const overviews = [...set].sort();
    const lines: string[] = [];
    for (const ov of overviews) {
      const { raw_text: raw_text, data } = await load_doc(ov);
      const h1 = raw_text.replace(FRONTMATTER, '').match(/^# (.+)$/m)?.[1];
      const title = (typeof data.title === 'string' && data.title) || h1 || basename(ov, '.md');
      const doc_path = relative(dirname(file), ov).split('\\').join('/');
      lines.push(`Part of: [${title.replace(/[[\]]/g, '\\$&')}](${doc_path})`);
    }
    const block = lines.join('\n');
    const { raw_text: raw_text } = await load_doc(file);
    const frontmatter = raw_text.match(FRONTMATTER)?.[0] ?? '';
    const body = raw_text.slice(frontmatter.length);
    const h1 = body.match(/^# .*(\r?\n|$)/m);
    let next: string;
    if (h1 && h1.index !== undefined) {
      const end = h1.index + h1[0].length;
      const nl = h1[1] || '\n';
      next = frontmatter + body.slice(0, end) + (h1[1] ? '' : nl) + nl + block + nl + body.slice(end);
    } else {
      next = frontmatter + block + '\n\n' + body;
    }
    if (!options.dry_run) await writeFile(join(docs_path, file), next);
    changes.push({ file, overviews });
  }
  return changes;
}
