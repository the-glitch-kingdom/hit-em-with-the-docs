/**
 * Link-cluster detection for overview docs (#51). A cluster is a domain, or a
 * cross-domain connected component, of non-generated docs. Generated files
 * (INDEX/REGISTRY) link to everything, so they never count as members or as an
 * overview; they only feed `generatedOnlyHub`.
 */

import { readFile } from 'fs/promises';
import { basename, join } from 'path';
import { parseFrontmatter } from '../../utils/frontmatter.js';
import type { OverviewConfig } from '../../utils/config.js';
import { buildLinkGraph } from './tracker.js';

const SKIP_DIRS = new Set(['drafts', 'reports', 'archive']);
const GENERATED_NAMES = new Set(['INDEX.md', 'REGISTRY.md']);

/** Docs that never take part in clusters or back-links: drafts, reports, archive, plans, draft/archived status. */
export function isOutOfOverviewScope(rel: string, data: Record<string, unknown>): boolean {
  return (
    rel.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg)) ||
    data.tier === 'plan' ||
    data.status === 'archived' ||
    data.status === 'draft'
  );
}

export interface DocCluster {
  /** Domain name, or `component:<first member>` for a cross-domain component. */
  id: string;
  kind: 'domain' | 'component';
  members: string[];
  overview?: string | undefined;
  /** Link coverage of the overview, or of the best non-generated doc when none qualifies. */
  coverage: number;
  kindOverview: boolean;
  generatedOnlyHub: boolean;
}

export async function findClusters(
  docsPath: string,
  cfg: Pick<OverviewConfig, 'min_cluster_size' | 'min_link_coverage'>
): Promise<DocCluster[]> {
  const graph = await buildLinkGraph(docsPath);
  const info = new Map<string, { generated: boolean; overview: boolean; domain: string }>();
  for (const n of graph.nodes) {
    let data: Record<string, unknown> = {};
    try {
      data = parseFrontmatter<Record<string, unknown>>(await readFile(join(docsPath, n.id), 'utf-8')).data;
    } catch {
      // unreadable: treat as plain doc
    }
    if (isOutOfOverviewScope(n.id, data)) continue;
    info.set(n.id, {
      generated: data.generated === true || GENERATED_NAMES.has(basename(n.id)),
      overview: data.kind === 'overview',
      domain: n.domain ?? n.id.split(/[\\/]/)[0]!,
    });
  }

  // De-duplicated out-links per doc, restricted to kept docs.
  const out = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.source === e.target || !info.has(e.source) || !info.has(e.target)) continue;
    (out.get(e.source) ?? out.set(e.source, new Set()).get(e.source)!).add(e.target);
  }

  const plain = [...info.keys()].filter((id) => !info.get(id)!.generated);
  const groups: Array<{ id: string; kind: DocCluster['kind']; members: string[] }> = [];

  const byDomain = new Map<string, string[]>();
  for (const id of plain) (byDomain.get(info.get(id)!.domain) ?? byDomain.set(info.get(id)!.domain, []).get(info.get(id)!.domain)!).push(id);
  for (const [domain, members] of byDomain) {
    if (members.length >= cfg.min_cluster_size) groups.push({ id: domain, kind: 'domain', members });
  }

  // Union-find over undirected non-generated edges.
  const parent = new Map(plain.map((id) => [id, id]));
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  for (const [src, targets] of out) {
    if (!parent.has(src)) continue;
    for (const t of targets) if (parent.has(t)) parent.set(find(src), find(t));
  }
  const comps = new Map<string, string[]>();
  for (const id of plain) (comps.get(find(id)) ?? comps.set(find(id), []).get(find(id))!).push(id);
  for (const members of comps.values()) {
    const domains = new Set(members.map((m) => info.get(m)!.domain));
    if (members.length >= cfg.min_cluster_size && domains.size > 1) {
      groups.push({ id: `component:${members[0]}`, kind: 'component', members });
    }
  }

  return groups.map((g) => {
    const set = new Set(g.members);
    const coverageOf = (id: string): number => {
      const hits = [...(out.get(id) ?? [])].filter((t) => t !== id && set.has(t)).length;
      const others = set.size - (set.has(id) ? 1 : 0);
      return others > 0 ? hits / others : 0;
    };
    const ranked = g.members
      .map((id) => ({ id, cov: coverageOf(id), kind: info.get(id)!.overview }))
      .sort((a, b) => Number(b.kind) - Number(a.kind) || b.cov - a.cov || a.id.localeCompare(b.id));
    const qualified = ranked.filter((r) => r.cov >= cfg.min_link_coverage);
    const best = qualified[0];
    const generatedHub = [...info].some(([id, i]) => i.generated && coverageOf(id) >= cfg.min_link_coverage);
    return {
      ...g,
      overview: best?.id,
      coverage: (best ?? [...ranked].sort((a, b) => b.cov - a.cov)[0])?.cov ?? 0,
      kindOverview: best?.kind ?? false,
      generatedOnlyHub: !best && generatedHub,
    };
  });
}
