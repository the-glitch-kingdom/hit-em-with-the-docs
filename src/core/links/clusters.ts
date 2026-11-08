/**
 * Link-cluster detection for overview docs (#51). A cluster is a densely linked
 * domain, or a label-propagation community, of non-generated docs. Generated files
 * (INDEX/REGISTRY) link to everything, so they never count as members or as an
 * overview; they only feed `generated_only_hub`.
 */

import { readFile } from 'fs/promises';
import { basename, join } from 'path';
import { parse_frontmatter } from '../../utils/frontmatter.js';
import type { OverviewConfig } from '../../utils/config.js';
import { build_link_graph } from './tracker.js';

const SKIP_DIRS = new Set(['drafts', 'reports', 'archive']);
const MIN_DENSITY = 0.15;
const MAX_ROUNDS = 20;
const HUB_MIN_OUT = 20;
const HUB_SHARE = 0.1;
const GENERATED_NAMES = new Set(['INDEX.md', 'REGISTRY.md']);
const MERGE_JACCARD = 0.6;
const MERGE_CONTAINED = 0.8;
// Root-level landing docs (README.md etc.) link broadly by nature, whatever the tree size.
const LANDING = /^(readme|index|overview)\.mdx?$/i;

/** Docs that never take part in clusters or back-links: drafts, reports, archive, plans, draft/archived status. */
export function is_out_of_overview_scope(doc_path: string, data: Record<string, unknown>): boolean {
  return (
    doc_path.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg)) ||
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
  kind_overview: boolean;
  generated_only_hub: boolean;
  /** Most-linked member: where a missing-overview warning is reported. */
  top: string;
  /** Tags on 2+ members, most common first (max 3). */
  shared_tags: string[];
}

export async function find_clusters(
  docs_root: string,
  config: Pick<OverviewConfig, 'min_cluster_size' | 'min_link_coverage'>
): Promise<DocCluster[]> {
  const graph = await build_link_graph(docs_root);
  const info = new Map<string, { generated: boolean; overview: boolean; domain: string; tags: string[] }>();
  for (const node of graph.nodes) {
    let data: Record<string, unknown> = {};
    try {
      data = parse_frontmatter<Record<string, unknown>>(await readFile(join(docs_root, node.id), 'utf-8')).data;
    } catch {
      // unreadable: treat as plain doc
    }
    if (is_out_of_overview_scope(node.id, data)) continue;
    info.set(node.id, {
      generated: data.generated === true || GENERATED_NAMES.has(basename(node.id)),
      overview: data.kind === 'overview',
      tags: Array.isArray(data.tags) ? data.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      domain: node.domain ?? node.id.split(/[\\/]/)[0]!,
    });
  }

  // De-duplicated out-links per doc, restricted to kept docs.
  const found = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.source === edge.target || !info.has(edge.source) || !info.has(edge.target)) continue;
    (found.get(edge.source) ?? found.set(edge.source, new Set()).get(edge.source)!).add(edge.target);
  }

  const plain = [...info.keys()].filter((id) => !info.get(id)!.generated).sort();
  // Landing docs that link to a large share of the tree bridge every group; they stay out of
  // community detection (and member lists) but can still qualify as an overview.
  const hub_min = Math.max(HUB_MIN_OUT, Math.ceil(plain.length * HUB_SHARE));
  const hubs = plain.filter((id) => (found.get(id)?.size ?? 0) >= hub_min || (!/[\\/]/.test(id) && LANDING.test(id)));
  const core = plain.filter((id) => !hubs.includes(id));
  const core_set = new Set(core);

  // Undirected, non-generated, non-hub neighbours.
  const nbr = new Map(core.map((id) => [id, new Set<string>()]));
  for (const [source, targets] of found) {
    if (!core_set.has(source)) continue;
    for (const token of targets) if (core_set.has(token)) (nbr.get(source)!.add(token), nbr.get(token)!.add(source));
  }
  // A flow is densely linked inside: enough of the possible pairs, or most members tied to 3+ others (a chain is not a flow).
  const is_dense = (members: string[]): boolean => {
    const set = new Set(members);
    const deg = members.map((member) => [...nbr.get(member)!].filter((token) => set.has(token)).length);
    const pairs = deg.reduce((total, degree) => total + degree, 0) / 2;
    return pairs >= MIN_DENSITY * (members.length * (members.length - 1)) / 2 ||
      deg.filter((doc) => doc >= 3).length > members.length / 2;
  };

  const groups: Array<{ id: string; kind: DocCluster['kind']; members: string[] }> = [];
  const by_domain = new Map<string, string[]>();
  for (const id of core) (by_domain.get(info.get(id)!.domain) ?? by_domain.set(info.get(id)!.domain, []).get(info.get(id)!.domain)!).push(id);
  for (const [domain, members] of by_domain) {
    if (members.length >= config.min_cluster_size && is_dense(members)) groups.push({ id: domain, kind: 'domain', members });
  }

  // Deterministic label propagation: fixed visiting order, ties to the smallest label, capped rounds.
  const label = new Map(core.map((id) => [id, id]));
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let changed = false;
    for (const id of core) {
      const votes = new Map<string, number>();
      // Edges weigh 1 + shared neighbours, so a lone bridge link never outvotes a group's own ties.
      for (const token of nbr.get(id)!) {
        const word = 1 + [...nbr.get(id)!].filter((unit) => nbr.get(token)!.has(unit)).length;
        votes.set(label.get(token)!, (votes.get(label.get(token)!) ?? 0) + word);
      }
      let best = label.get(id)!;
      let best_n = 0;
      for (const [line, count] of [...votes].sort((a, b) => a[0].localeCompare(b[0]))) if (count > best_n) (best = line, best_n = count);
      if (best_n > 0 && best !== label.get(id)) (label.set(id, best), changed = true);
    }
    if (!changed) break;
  }
  const comms = new Map<string, string[]>();
  for (const id of core) (comms.get(label.get(id)!) ?? comms.set(label.get(id)!, []).get(label.get(id)!)!).push(id);
  const subs: typeof groups = [];
  for (const members of comms.values()) {
    if (members.length < config.min_cluster_size || !is_dense(members)) continue;
    const domains = new Set(members.map((member) => info.get(member)!.domain));
    if (domains.size > 1) groups.push({ id: `component:${members[0]}`, kind: 'component', members });
    else if (members.length * 2 <= (by_domain.get([...domains][0]!)?.length ?? 0)) subs.push({ id: `component:${members[0]}`, kind: 'component', members });
  }
  // A domain split into 2+ flows is reported as those flows, not also as the whole domain;
  // a lone flow inside a domain that is already reported adds nothing.
  for (const sub of subs) {
    const doc = info.get(sub.members[0]!)!.domain;
    const count = subs.filter((other_sub) => info.get(other_sub.members[0]!)!.domain === doc).length;
    const i = groups.findIndex((group) => group.id === doc && group.kind === 'domain');
    if (count < 2 && i >= 0) continue;
    if (i >= 0) groups.splice(i, 1);
    groups.push(sub);
  }

  // Near-identical flows (heavy overlap) are one flow: fold the smaller into the larger.
  groups.sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id));
  for (let i = 0; i < groups.length; i++) {
    for (let j = groups.length - 1; j > i; j--) {
      const big = new Set(groups[i]!.members);
      const shared = groups[j]!.members.filter((member) => big.has(member)).length;
      const union = big.size + groups[j]!.members.length - shared;
      if (shared / union >= MERGE_JACCARD || shared / groups[j]!.members.length >= MERGE_CONTAINED) {
        groups[i]!.members = [...new Set([...groups[i]!.members, ...groups[j]!.members])].sort();
        groups.splice(j, 1);
        j = groups.length; // members changed: rescan against the grown flow
      }
    }
  }

  return groups.map((group) => {
    const set = new Set(group.members);
    const compute_coverage = (id: string): number => {
      const matches = [...(found.get(id) ?? [])].filter((token) => token !== id && set.has(token)).length;
      const others = set.size - (set.has(id) ? 1 : 0);
      return others > 0 ? matches / others : 0;
    };
    const ranked = [...group.members, ...hubs]
      .map((id) => ({ id, cov: compute_coverage(id), kind: info.get(id)!.overview }))
      .sort((a, b) => Number(b.kind) - Number(a.kind) || b.cov - a.cov || a.id.localeCompare(b.id));
    const qualified = ranked.filter((result) => result.cov >= config.min_link_coverage);
    const best = qualified[0];
    const generated_hub = [...info].some(([id, i]) => i.generated && compute_coverage(id) >= config.min_link_coverage);
    const best_id = [...ranked].filter((result) => set.has(result.id)).sort((a, b) => b.cov - a.cov || a.id.localeCompare(b.id))[0]!.id;
    const tag_count = new Map<string, number>();
    for (const match of group.members) for (const token of info.get(match)!.tags) tag_count.set(token, (tag_count.get(token) ?? 0) + 1);
    const shared_tags = [...tag_count].filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([token]) => token);
    return {
      ...group,
      overview: best?.id,
      coverage: (best ?? [...ranked].sort((a, b) => b.cov - a.cov)[0])?.cov ?? 0,
      kind_overview: best?.kind ?? false,
      generated_only_hub: !best && generated_hub,
      top: best_id,
      shared_tags,
    };
  });
}
