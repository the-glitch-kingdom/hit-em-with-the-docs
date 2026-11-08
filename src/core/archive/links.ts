/**
 * Inbound-link detection for the archival process.
 *
 * Archiving a doc that active docs still link to would turn live references
 * into dead ones — exactly the failure archival must prevent. This reuses the
 * existing link graph (which already excludes `archive/`, since it scans via
 * `findMarkdownFiles`) to find every active doc that links to a target.
 */

import { relative, resolve, sep } from 'path';
import { build_link_graph } from '../links/tracker.js';
import { is_generated_index_relative } from '../enforce/guard.js';

export interface InboundLink {
  /** docs-relative path of the doc that links to the target. */
  source: string;
  line_number: number;
  link_text: string;
}

/**
 * Find all active (non-archived) docs that link to `targetRelPath`
 * (a path relative to `docs_root`). Returns one entry per inbound link.
 *
 * Links from generated root/domain `INDEX.md` / `REGISTRY.md` are not counted:
 * the archive's own reindex removes those rows, and counting them forced
 * `--force`, which also switched the check off for real inbound links (#39).
 */
export async function find_inbound_links(
  docs_root: string,
  target_rel_path: string
): Promise<InboundLink[]> {
  const normalized_target = target_rel_path.replace(/\\/g, '/');
  const graph = await build_link_graph(docs_root);
  return graph.edges
    .filter((edge) => edge.target.replace(/\\/g, '/') === normalized_target)
    // ponytail: built-in domain shapes only; a custom domain id containing a
    // slash is treated as hand-written, which blocks (the safe direction).
    .filter((edge) => !is_generated_index_relative(edge.source))
    .map((edge) => ({
      source: edge.source.replace(/\\/g, '/'),
      line_number: edge.line_number,
      link_text: edge.link_text,
    }));
}

/**
 * Normalize a file arg to a docs-relative POSIX path. Accepts an absolute path,
 * a path relative to `base` (the project root, e.g. `.documentation/api/x.md`),
 * or a docs-relative path (`api/x.md`). Before #39 only absolute and
 * docs-relative worked: a project-relative path became
 * `<docs>/.documentation/...` and was reported as not found.
 */
export function resolve_doc_path(docs_root: string, file: string, base = process.cwd()): string {
  const abs_path = resolve(base, file);
  const doc_path = abs_path.startsWith(docs_root + sep) ? relative(docs_root, abs_path) : file;
  return doc_path.replace(/\\/g, '/').replace(/^\.\//, '');
}
