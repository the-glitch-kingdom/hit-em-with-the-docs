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
  in_degree: number;
  out_degree: number;
}

export interface LinkEdge {
  source: string;
  target: string;
  link_text: string;
  line_number: number;
}

export interface DomainConnectionMatrix {
  domains: Domain[];
  matrix: number[][];
  total_connections: number;
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
      in_degree: 0,
      out_degree: 0,
    });
  }

  // Second pass: find edges and update degrees
  for (const file of files) {
    const content = await readFile(file, 'utf-8');
    const links = extract_links(content);
    const rel_path = relative(docs_path, file);
    const file_dir = dirname(file);

    for (const link of links) {
      if (link.is_internal) {
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
            link_text: link.text,
            line_number: link.line_number,
          });

          // Update degrees
          const source_node = nodes.get(rel_path);
          const target_node = nodes.get(target_path);

          if (source_node) source_node.out_degree++;
          if (target_node) target_node.in_degree++;
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
    const source_node = graph.nodes.find((node) => node.id === edge.source);
    const target_node = graph.nodes.find((node) => node.id === edge.target);

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
    total_connections,
  };
}

/**
 * Get top connected domain pairs
 */
export async function find_top_connected_domains(
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
export async function find_backlinks(
  target_file: string,
  docs_path: string
): Promise<{ source: string; link_text: string; line_number: number }[]> {
  const graph = await build_link_graph(docs_path);
  const target_path = relative(docs_path, target_file).replace(/\\/g, '/');

  return graph.edges
    .filter((edge) => edge.target === target_path)
    .map((edge) => ({
      source: edge.source,
      link_text: edge.link_text,
      line_number: edge.line_number,
    }));
}

/**
 * Find orphan files (files with no incoming links)
 */
export async function find_orphan_files(docs_path: string): Promise<string[]> {
  const graph = await build_link_graph(docs_path);

  return graph.nodes
    .filter((node) => node.in_degree === 0)
    .filter((node) => {
      // Exclude index files
      const name = node.path.split('/').pop() ?? '';
      return !['INDEX.md', 'REGISTRY.md', 'README.md'].includes(name);
    })
    .map((node) => node.path);
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
    .filter((node) => node.in_degree >= min_degree || node.out_degree >= min_degree)
    .sort((a, b) => (b.in_degree + b.out_degree) - (a.in_degree + a.out_degree));
}

/**
 * Get link statistics summary
 */
export async function load_link_statistics(docs_path: string): Promise<{
  total_nodes: number;
  total_edges: number;
  avg_in_degree: number;
  avg_out_degree: number;
  orphan_count: number;
  hub_count: number;
  cross_domain_percentage: number;
}> {
  const graph = await build_link_graph(docs_path);

  const total_in_degree = graph.nodes.reduce((sum, node) => sum + node.in_degree, 0);
  const total_out_degree = graph.nodes.reduce((sum, node) => sum + node.out_degree, 0);

  const orphans = graph.nodes.filter((node) => node.in_degree === 0).length;
  const hubs = graph.nodes.filter((node) => node.in_degree >= 5 || node.out_degree >= 5).length;

  // Count cross-domain edges
  let cross_domain_edges = 0;
  for (const edge of graph.edges) {
    const source_node = graph.nodes.find((node) => node.id === edge.source);
    const target_node = graph.nodes.find((node) => node.id === edge.target);

    if (source_node?.domain && target_node?.domain && source_node.domain !== target_node.domain) {
      cross_domain_edges++;
    }
  }

  return {
    total_nodes: graph.nodes.length,
    total_edges: graph.edges.length,
    avg_in_degree: graph.nodes.length > 0 ? total_in_degree / graph.nodes.length : 0,
    avg_out_degree: graph.nodes.length > 0 ? total_out_degree / graph.nodes.length : 0,
    orphan_count: orphans,
    hub_count: hubs,
    cross_domain_percentage:
      graph.edges.length > 0 ? (cross_domain_edges / graph.edges.length) * 100 : 0,
  };
}
