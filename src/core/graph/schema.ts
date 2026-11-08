/**
 * Types for `.hewtd/graph.json` v1. Contract: docs/graph-export.md and
 * schemas/graph.v1.schema.json (kept in sync by tests/unit/graph-schema.test.ts).
 * Additive fields keep version 1; removal, rename or meaning change bumps it.
 */

export const GRAPH_VERSION = 1 as const;

export const GRAPH_VERDICTS = [
  'verified',
  'fields-only',
  'check',
  'stale',
  'archive-candidate',
  'secret',
  'unreviewed',
] as const;
export type GraphVerdict = (typeof GRAPH_VERDICTS)[number];

export const GRAPH_REF_KINDS = ['file', 'symbol', 'env', 'command', 'table', 'column', 'doc'] as const;
export type GraphRefKind = (typeof GRAPH_REF_KINDS)[number];

export interface GraphRef {
  kind: GraphRefKind;
  target: string;
  file?: string;
  /** A `related_repos` sibling, when the file lives there. */
  repo?: string;
  /** Symbol refs: `file` defines the symbol, or only mentions it. */
  file_kind?: 'definition' | 'reference';
  /** true found, false missing, null could not be checked. */
  resolved: boolean | null;
  /** YYYY-MM-DD of the last commit touching a resolved file. */
  code_changed?: string;
}

export interface GraphDoc {
  body_changed: string | null;
  verdict: GraphVerdict;
  last_verified: string | null;
  refs: GraphRef[];
  owner_of: string[];
  points_to: Array<{ from: string | null; to: string }>;
  duplicates: Array<{ section: string; owner: string }>;
}

export interface GraphSymbol {
  file: string;
  file_kind?: 'definition' | 'reference';
  cited_by: string[];
}

export interface GraphV1 {
  version: typeof GRAPH_VERSION;
  /** HEAD sha, or null outside git. No timestamp: regeneration is byte-identical. */
  source_commit: string | null;
  docs: Record<string, GraphDoc>;
  symbols: Record<string, GraphSymbol>;
}
