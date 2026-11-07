/**
 * Link-cluster detection for overview docs (#51). A cluster is a densely linked
 * domain, or a label-propagation community, of non-generated docs. Generated files
 * (INDEX/REGISTRY) link to everything, so they never count as members or as an
 * overview; they only feed `generatedOnlyHub`.
 */

import { readFile } from 'fs/promises';
import { basename, join } from 'path';
import { parseFrontmatter } from '../../utils/frontmatter.js';
import type { OverviewConfig } from '../../utils/config.js';
import { buildLinkGraph } from './tracker.js';

const SKIP_DIRS = new Set(['drafts', 'reports', 'archive']);
const MIN_DENSITY = 0.15;
const MAX_ROUNDS = 20;
const HUB_MIN_OUT = 20;
const HUB_SHARE = 0.1;
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
  /** Most-linked member: where a missing-overview warning is reported. */
  top: string;
  /** Tags on 2+ members, most common first (max 3). */
  sharedTags: string[];
}

export async function findClusters(
  docsPath: string,
  cfg: Pick<OverviewConfig, 'min_cluster_size' | 'min_link_coverage'>
): Promise<DocCluster[]> {
  const graph = await buildLinkGraph(docsPath);
  const info = new Map<string, { generated: boolean; overview: boolean; domain: string; tags: string[] }>();
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
      tags: Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === 'string') : [],
      domain: n.domain ?? n.id.split(/[\\/]/)[0]!,
    });
  }

  // De-duplicated out-links per doc, restricted to kept docs.
  const out = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.source === e.target || !info.has(e.source) || !info.has(e.target)) continue;
    (out.get(e.source) ?? out.set(e.source, new Set()).get(e.source)!).add(e.target);
  }

  const plain = [...info.keys()].filter((id) => !info.get(id)!.generated).sort();
  // Landing docs that link to a large share of the tree bridge every group; they stay out of
  // community detection (and member lists) but can still qualify as an overview.
  const hubMin = Math.max(HUB_MIN_OUT, Math.ceil(plain.length * HUB_SHARE));
  const hubs = plain.filter((id) => (out.get(id)?.size ?? 0) >= hubMin);
  const core = plain.filter((id) => !hubs.includes(id));
  const coreSet = new Set(core);

  // Undirected, non-generated, non-hub neighbours.
  const nbr = new Map(core.map((id) => [id, new Set<string>()]));
  for (const [src, targets] of out) {
    if (!coreSet.has(src)) continue;
    for (const t of targets) if (coreSet.has(t)) (nbr.get(src)!.add(t), nbr.get(t)!.add(src));
  }
  // A flow is densely linked inside: enough of the possible pairs, or most members tied to 3+ others (a chain is not a flow).
  const isDense = (members: string[]): boolean => {
    const set = new Set(members);
    const deg = members.map((m) => [...nbr.get(m)!].filter((t) => set.has(t)).length);
    const pairs = deg.reduce((x, y) => x + y, 0) / 2;
    return pairs >= MIN_DENSITY * (members.length * (members.length - 1)) / 2 ||
      deg.filter((d) => d >= 3).length > members.length / 2;
  };

  const groups: Array<{ id: string; kind: DocCluster['kind']; members: string[] }> = [];
  const byDomain = new Map<string, string[]>();
  for (const id of core) (byDomain.get(info.get(id)!.domain) ?? byDomain.set(info.get(id)!.domain, []).get(info.get(id)!.domain)!).push(id);
  for (const [domain, members] of byDomain) {
    if (members.length >= cfg.min_cluster_size && isDense(members)) groups.push({ id: domain, kind: 'domain', members });
  }

  // Deterministic label propagation: fixed visiting order, ties to the smallest label, capped rounds.
  const label = new Map(core.map((id) => [id, id]));
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let changed = false;
    for (const id of core) {
      const votes = new Map<string, number>();
      // Edges weigh 1 + shared neighbours, so a lone bridge link never outvotes a group's own ties.
      for (const t of nbr.get(id)!) {
        const w = 1 + [...nbr.get(id)!].filter((u) => nbr.get(t)!.has(u)).length;
        votes.set(label.get(t)!, (votes.get(label.get(t)!) ?? 0) + w);
      }
      let best = label.get(id)!;
      let bestN = 0;
      for (const [l, n] of [...votes].sort((x, y) => x[0].localeCompare(y[0]))) if (n > bestN) (best = l, bestN = n);
      if (bestN > 0 && best !== label.get(id)) (label.set(id, best), changed = true);
    }
    if (!changed) break;
  }
  const comms = new Map<string, string[]>();
  for (const id of core) (comms.get(label.get(id)!) ?? comms.set(label.get(id)!, []).get(label.get(id)!)!).push(id);
  const subs: typeof groups = [];
  for (const members of comms.values()) {
    if (members.length < cfg.min_cluster_size || !isDense(members)) continue;
    const domains = new Set(members.map((m) => info.get(m)!.domain));
    if (domains.size > 1) groups.push({ id: `component:${members[0]}`, kind: 'component', members });
    else if (members.length * 2 <= (byDomain.get([...domains][0]!)?.length ?? 0)) subs.push({ id: `component:${members[0]}`, kind: 'component', members });
  }
  // A domain split into 2+ flows is reported as those flows, not also as the whole domain.
  for (const sub of subs) {
    const d = info.get(sub.members[0]!)!.domain;
    const n = subs.filter((o) => info.get(o.members[0]!)!.domain === d).length;
    if (n >= 2) { const i = groups.findIndex((g) => g.id === d && g.kind === 'domain'); if (i >= 0) groups.splice(i, 1); }
    groups.push(sub);
  }

  return groups.map((g) => {
    const set = new Set(g.members);
    const coverageOf = (id: string): number => {
      const hits = [...(out.get(id) ?? [])].filter((t) => t !== id && set.has(t)).length;
      const others = set.size - (set.has(id) ? 1 : 0);
      return others > 0 ? hits / others : 0;
    };
    const ranked = [...g.members, ...hubs]
      .map((id) => ({ id, cov: coverageOf(id), kind: info.get(id)!.overview }))
      .sort((a, b) => Number(b.kind) - Number(a.kind) || b.cov - a.cov || a.id.localeCompare(b.id));
    const qualified = ranked.filter((r) => r.cov >= cfg.min_link_coverage);
    const best = qualified[0];
    const generatedHub = [...info].some(([id, i]) => i.generated && coverageOf(id) >= cfg.min_link_coverage);
    const top = [...ranked].filter((r) => set.has(r.id)).sort((a, b) => b.cov - a.cov || a.id.localeCompare(b.id))[0]!.id;
    const tagCount = new Map<string, number>();
    for (const m of g.members) for (const t of info.get(m)!.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    const sharedTags = [...tagCount].filter(([, n]) => n >= 2)
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 3).map(([t]) => t);
    return {
      ...g,
      overview: best?.id,
      coverage: (best ?? [...ranked].sort((a, b) => b.cov - a.cov)[0])?.cov ?? 0,
      kindOverview: best?.kind ?? false,
      generatedOnlyHub: !best && generatedHub,
      top,
      sharedTags,
    };
  });
}
