import { readFile } from 'fs/promises';
import { relative, dirname, resolve } from 'path';
import { find_markdown_files } from '../../utils/glob.js';
import { extract_links } from '../../utils/markdown.js';
import { detect_domain_from_path } from '../domains/detector.js';
import type { Domain } from '../domains/constants.js';
import { get_all_domains } from '../domains/registry.js';

export interface LinkGraph {
  nodes: LinkNode[];
  edges: LinkEdge[];
}

export interface LinkNode {
  id: string;
  path: string;
  domain: Domain | null;
  title?: string;
  inDegree: number;
  outDegree: number;
}

export interface LinkEdge {
  source: string;
  target: string;
  linkText: string;
  lineNumber: number;
}

export interface DomainConnectionMatrix {
  domains: Domain[];
  matrix: number[][];
  totalConnections: number;
}

/**
 * Build a complete link graph for the documentation
 */
export async function build_link_graph(docs_path: string): Promise<LinkGraph> {
  const files = await find_markdown_files(docs_path);
  const nodes = new Map<string, LinkNode>();
  const edges: LinkEdge[] = [];

  // First pass: create nodes
  for (const file of files) {
    const rel_path = relative(docs_path, file);
    const domain = detect_domain_from_path(file, docs_path).domain;

    nodes.set(rel_path, {
      id: rel_path,
      path: rel_path,
      domain,
      inDegree: 0,
      outDegree: 0,
    });
  }

  // Second pass: find edges and update degrees
  for (const file of files) {
    const content = await readFile(file, 'utf-8');
    const links = extract_links(content);
    const rel_path = relative(docs_path, file);
    const file_dir = dirname(file);

    for (const link of links) {
      if (link.isInternal) {
        // Resolve the link
        const path_part = link.url.split('#')[0] ?? '';
        if (!path_part) continue;

        let target_path: string;
        if (path_part.startsWith('/')) {
          target_path = path_part.slice(1);
        } else {
          target_path = relative(docs_path, resolve(file_dir, path_part));
        }

        // Normalize path separators
        target_path = target_path.replace(/\\/g, '/');

        if (nodes.has(target_path)) {
          edges.push({
            source: rel_path,
            target: target_path,
            linkText: link.text,
            lineNumber: link.lineNumber,
          });

          // Update degrees
          const source_node = nodes.get(rel_path);
          const target_node = nodes.get(target_path);

          if (source_node) source_node.outDegree++;
          if (target_node) target_node.inDegree++;
        }
      }
    }
  }

  return {
    nodes: [...nodes.values()],
    edges,
  };
}

/**
 * Build a domain connection matrix showing how domains link to each other
 */
export async function build_domain_connection_matrix(
  docs_path: string
): Promise<DomainConnectionMatrix> {
  const graph = await build_link_graph(docs_path);

  // Snapshot the active domain set once so the matrix axes and the index
  // lookups below share a single, stable ordering for this call.
  const domains = get_all_domains();

  // Initialize matrix
  const matrix: number[][] = domains.map(() =>
    domains.map(() => 0)
  );

  let total_connections = 0;

  // Count connections between domains
  for (const edge of graph.edges) {
    const source_node = graph.nodes.find((n) => n.id === edge.source);
    const target_node = graph.nodes.find((n) => n.id === edge.target);

    if (source_node?.domain && target_node?.domain) {
      const source_idx = domains.indexOf(source_node.domain);
      const target_idx = domains.indexOf(target_node.domain);

      if (source_idx !== -1 && target_idx !== -1) {
        matrix[source_idx]![target_idx]!++;
        total_connections++;
      }
    }
  }

  return {
    domains,
    matrix,
    totalConnections: total_connections,
  };
}

/**
 * Get top connected domain pairs
 */
export async function get_top_connected_domains(
  docs_path: string,
  limit: number = 10
): Promise<{ from: Domain; to: Domain; count: number }[]> {
  const { domains, matrix } = await build_domain_connection_matrix(docs_path);
  const connections: { from: Domain; to: Domain; count: number }[] = [];

  for (let i = 0; i < domains.length; i++) {
    for (let j = 0; j < domains.length; j++) {
      const count = matrix[i]![j] ?? 0;
      if (count > 0) {
        connections.push({
          from: domains[i]!,
          to: domains[j]!,
          count,
        });
      }
    }
  }

  return connections
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * Get backlinks for a specific file
 */
export async function get_backlinks(
  target_file: string,
  docs_path: string
): Promise<{ source: string; linkText: string; lineNumber: number }[]> {
  const graph = await build_link_graph(docs_path);
  const target_path = relative(docs_path, target_file).replace(/\\/g, '/');

  return graph.edges
    .filter((e) => e.target === target_path)
    .map((e) => ({
      source: e.source,
      linkText: e.linkText,
      lineNumber: e.lineNumber,
    }));
}

/**
 * Find orphan files (files with no incoming links)
 */
export async function find_orphan_files(docs_path: string): Promise<string[]> {
  const graph = await build_link_graph(docs_path);

  return graph.nodes
    .filter((n) => n.inDegree === 0)
    .filter((n) => {
      // Exclude index files
      const name = n.path.split('/').pop() ?? '';
      return !['INDEX.md', 'REGISTRY.md', 'README.md'].includes(name);
    })
    .map((n) => n.path);
}

/**
 * Find highly connected files (hubs)
 */
export async function find_hub_files(
  docs_path: string,
  min_degree: number = 5
): Promise<LinkNode[]> {
  const graph = await build_link_graph(docs_path);

  return graph.nodes
    .filter((n) => n.inDegree >= min_degree || n.outDegree >= min_degree)
    .sort((a, b) => (b.inDegree + b.outDegree) - (a.inDegree + a.outDegree));
}

/**
 * Get link statistics summary
 */
export async function get_link_statistics(docs_path: string): Promise<{
  totalNodes: number;
  totalEdges: number;
  avgInDegree: number;
  avgOutDegree: number;
  orphanCount: number;
  hubCount: number;
  crossDomainPercentage: number;
}> {
  const graph = await build_link_graph(docs_path);

  const total_in_degree = graph.nodes.reduce((sum, n) => sum + n.inDegree, 0);
  const total_out_degree = graph.nodes.reduce((sum, n) => sum + n.outDegree, 0);

  const orphans = graph.nodes.filter((n) => n.inDegree === 0).length;
  const hubs = graph.nodes.filter((n) => n.inDegree >= 5 || n.outDegree >= 5).length;

  // Count cross-domain edges
  let cross_domain_edges = 0;
  for (const edge of graph.edges) {
    const source_node = graph.nodes.find((n) => n.id === edge.source);
    const target_node = graph.nodes.find((n) => n.id === edge.target);

    if (source_node?.domain && target_node?.domain && source_node.domain !== target_node.domain) {
      cross_domain_edges++;
    }
  }

  return {
    totalNodes: graph.nodes.length,
    totalEdges: graph.edges.length,
    avgInDegree: graph.nodes.length > 0 ? total_in_degree / graph.nodes.length : 0,
    avgOutDegree: graph.nodes.length > 0 ? total_out_degree / graph.nodes.length : 0,
    orphanCount: orphans,
    hubCount: hubs,
    crossDomainPercentage:
      graph.edges.length > 0 ? (cross_domain_edges / graph.edges.length) * 100 : 0,
  };
}
