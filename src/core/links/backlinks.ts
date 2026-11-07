/**
 * Back-links from overview members to their `kind: overview` doc (#51).
 * Inserts `Part of: [Title](rel.md)` after the first H1 of each member that
 * does not already link to the overview. Only the inserted line changes; the
 * frontmatter block is kept byte-identical. Idempotent: a second run finds the
 * link and writes nothing.
 */

import { readFile, writeFile } from 'fs/promises';
import { basename, dirname, join, relative } from 'path';
import { parseFrontmatter } from '../../utils/frontmatter.js';
import { buildLinkGraph } from './tracker.js';
import { isOutOfOverviewScope } from './clusters.js';

export interface BacklinkChange {
  /** Member path relative to the docs root. */
  file: string;
  /** Overview paths (relative to the docs root) the member now links to, sorted. */
  overviews: string[];
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export async function addOverviewBacklinks(docsPath: string, opts: { dryRun?: boolean } = {}): Promise<BacklinkChange[]> {
  const graph = await buildLinkGraph(docsPath);
  const read = new Map<string, { raw: string; data: Record<string, unknown> }>();
  const load = async (id: string) => {
    if (!read.has(id)) {
      const raw = await readFile(join(docsPath, id), 'utf-8');
      let data: Record<string, unknown> = {};
      try { data = parseFrontmatter<Record<string, unknown>>(raw).data; } catch { /* plain doc */ }
      read.set(id, { raw, data });
    }
    return read.get(id)!;
  };
  const isGenerated = (id: string, d: Record<string, unknown>) =>
    d.generated === true || ['INDEX.md', 'REGISTRY.md'].includes(basename(id));

  const linked = new Set(graph.edges.map((e) => `${e.source}\0${e.target}`));
  const wanted = new Map<string, Set<string>>(); // member -> overviews
  const overviewIds = new Set<string>();
  for (const n of graph.nodes) {
    const { data } = await load(n.id);
    if (data.kind === 'overview' && !isOutOfOverviewScope(n.id, data)) overviewIds.add(n.id);
  }

  for (const e of graph.edges) {
    if (!overviewIds.has(e.source) || e.source === e.target) continue;
    if (linked.has(`${e.target}\0${e.source}`)) continue;
    const m = await load(e.target);
    if (isGenerated(e.target, m.data) || isOutOfOverviewScope(e.target, m.data)) continue;
    // Text check too: a path the link parser can't read (spaces, parens) must not be re-inserted every run.
    if (m.raw.includes(`](${relative(dirname(e.target), e.source).split('\\').join('/')})`)) continue;
    (wanted.get(e.target) ?? wanted.set(e.target, new Set()).get(e.target)!).add(e.source);
  }

  const changes: BacklinkChange[] = [];
  for (const [file, set] of [...wanted].sort(([a], [b]) => a.localeCompare(b))) {
    const overviews = [...set].sort();
    const lines: string[] = [];
    for (const ov of overviews) {
      const { raw, data } = await load(ov);
      const h1 = raw.replace(FRONTMATTER, '').match(/^# (.+)$/m)?.[1];
      const title = (typeof data.title === 'string' && data.title) || h1 || basename(ov, '.md');
      const rel = relative(dirname(file), ov).split('\\').join('/');
      lines.push(`Part of: [${title.replace(/[[\]]/g, '\\$&')}](${rel})`);
    }
    const block = lines.join('\n');
    const { raw } = await load(file);
    const fm = raw.match(FRONTMATTER)?.[0] ?? '';
    const body = raw.slice(fm.length);
    const h1 = body.match(/^# .*(\r?\n|$)/m);
    let next: string;
    if (h1 && h1.index !== undefined) {
      const end = h1.index + h1[0].length;
      const nl = h1[1] || '\n';
      next = fm + body.slice(0, end) + (h1[1] ? '' : nl) + nl + block + nl + body.slice(end);
    } else {
      next = fm + block + '\n\n' + body;
    }
    if (!opts.dryRun) await writeFile(join(docsPath, file), next);
    changes.push({ file, overviews });
  }
  return changes;
}
