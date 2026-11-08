import { readFile } from 'fs/promises';
import { join, relative, dirname, resolve } from 'path';
import { find_markdown_files, path_exists } from '../../utils/glob.js';
import { extract_links } from '../../utils/markdown.js';
import { logger } from '../../utils/logger.js';
import { detect_domain_from_path } from '../domains/detector.js';
import { heading_anchors, LINK_BROKEN_ANCHOR } from './anchors.js';
import type { Domain } from '../domains/constants.js';

// Re-export types from utils/markdown.js
export { type MarkdownLink } from '../../utils/markdown.js';
export { heading_anchors as headingAnchors, section_of as sectionOf, LINK_BROKEN_ANCHOR } from './anchors.js';

export interface LinkCheckOptions {
  docsPath: string;
  domain?: string;
  checkExternal?: boolean;
  silent?: boolean;
}

export interface LinkCheckResult {
  totalFiles: number;
  totalLinks: number;
  validLinks: number;
  brokenLinks: BrokenLink[];
  /** Advisory LINK_BROKEN_ANCHOR warnings (#59); never counted as broken links. */
  anchorWarnings: BrokenLink[];
  crossDomainLinks: CrossDomainLink[];
  externalLinks: ExternalLink[];
  stats: LinkStats;
}

export interface BrokenLink {
  sourceFile: string;
  targetPath: string;
  lineNumber: number;
  linkText: string;
  reason: string;
}

export interface CrossDomainLink {
  sourceFile: string;
  sourceDomain: Domain | null;
  targetPath: string;
  targetDomain: Domain | null;
  linkText: string;
}

export interface ExternalLink {
  sourceFile: string;
  url: string;
  linkText: string;
  status?: number;
}

export interface LinkStats {
  internalLinks: number;
  externalLinks: number;
  crossDomainLinks: number;
  brokenPercentage: number;
  topConnectedDomains: { from: string; to: string; count: number }[];
}

/**
 * Check all links in documentation
 */
export async function check_links(options: LinkCheckOptions): Promise<LinkCheckResult> {
  const {
    docsPath: docs_path,
    domain,
    checkExternal: check_external = false,
    silent = false,
  } = options;

  const result: LinkCheckResult = {
    totalFiles: 0,
    totalLinks: 0,
    validLinks: 0,
    brokenLinks: [],
    anchorWarnings: [],
    crossDomainLinks: [],
    externalLinks: [],
    stats: {
      internalLinks: 0,
      externalLinks: 0,
      crossDomainLinks: 0,
      brokenPercentage: 0,
      topConnectedDomains: [],
    },
  };

  if (!silent) {
    logger.header('Link Checker');
  }

  // Find all markdown files
  let files = await find_markdown_files(docs_path);

  // Filter by domain if specified
  if (domain) {
    files = files.filter((f) => {
      const rel = relative(docs_path, f);
      return rel.startsWith(domain + '/') || rel.startsWith(domain + '\\');
    });
  }

  result.totalFiles = files.length;

  if (!silent) {
    logger.info(`Checking ${files.length} files...`);
  }

  const domain_connections = new Map<string, number>();

  for (const file of files) {
    try {
      const content = await readFile(file, 'utf-8');
      const links = extract_links(content);
      const rel_file = relative(docs_path, file);
      const file_dir = dirname(file);

      for (const link of links) {
        result.totalLinks++;

        if (link.isInternal) {
          result.stats.internalLinks++;

          // Resolve the link path
          const target_path = resolve_link(link.url, file_dir, docs_path, file);

          // Check if target exists
          const exists = await path_exists(target_path);

          if (!exists) {
            result.brokenLinks.push({
              sourceFile: rel_file,
              targetPath: link.url,
              lineNumber: link.lineNumber,
              linkText: link.text,
              reason: 'Target file does not exist',
            });
          } else {
            result.validLinks++;

            const anchor = anchor_of(link.url);
            if (anchor && target_path.endsWith('.md')) {
              const md = target_path === file ? content : await readFile(target_path, 'utf-8').catch(() => null);
              if (md !== null && !heading_anchors(md).has(anchor)) {
                result.anchorWarnings.push({
                  sourceFile: rel_file,
                  targetPath: link.url,
                  lineNumber: link.lineNumber,
                  linkText: link.text,
                  reason: `${LINK_BROKEN_ANCHOR}: no heading #${anchor}`,
                });
              }
            }

            // Track cross-domain links
            const source_domain = detect_domain_from_path(file, docs_path).domain;
            const target_domain = detect_domain_from_path(target_path, docs_path).domain;

            if (source_domain && target_domain && source_domain !== target_domain) {
              result.stats.crossDomainLinks++;
              result.crossDomainLinks.push({
                sourceFile: rel_file,
                sourceDomain: source_domain,
                targetPath: link.url,
                targetDomain: target_domain,
                linkText: link.text,
              });

              // Track domain connections
              const conn_key = `${source_domain} -> ${target_domain}`;
              domain_connections.set(conn_key, (domain_connections.get(conn_key) ?? 0) + 1);
            }
          }
        } else {
          // extractLinks treats `#x` as non-internal; check it against the doc itself (counts unchanged)
          const self = link.url.startsWith('#') ? anchor_of(link.url) : null;
          if (self && !heading_anchors(content).has(self)) {
            result.anchorWarnings.push({
              sourceFile: rel_file,
              targetPath: link.url,
              lineNumber: link.lineNumber,
              linkText: link.text,
              reason: `${LINK_BROKEN_ANCHOR}: no heading #${self}`,
            });
          }
          // External link
          result.stats.externalLinks++;
          result.externalLinks.push({
            sourceFile: rel_file,
            url: link.url,
            linkText: link.text,
          });

          // Optionally check external links
          if (check_external) {
            // Note: External link checking would go here
            // For now, we just track them
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!silent) {
        logger.warn(`Error processing ${relative(docs_path, file)}: ${message}`);
      }
    }
  }

  // Calculate stats
  result.stats.brokenPercentage =
    result.stats.internalLinks > 0
      ? (result.brokenLinks.length / result.stats.internalLinks) * 100
      : 0;

  // Get top connected domains
  result.stats.topConnectedDomains = [...domain_connections.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split(' -> ');
      return { from: from ?? '', to: to ?? '', count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  if (!silent) {
    logger.newline();
    logger.success(`Link check complete!`);
    logger.info(`Total links: ${result.totalLinks}`);
    logger.info(`Valid: ${result.validLinks}`);
    if (result.brokenLinks.length > 0) {
      logger.warn(`Broken: ${result.brokenLinks.length}`);
    }
    logger.info(`Cross-domain: ${result.stats.crossDomainLinks}`);
    for (const w of result.anchorWarnings) {
      logger.warn(`${w.sourceFile}:${w.lineNumber} ${w.targetPath} - ${w.reason}`);
    }
  }

  return result;
}

function anchor_of(url: string): string | null {
  const raw = url.split('#')[1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Resolve a relative link to an absolute path
 */
function resolve_link(link_url: string, file_dir: string, docs_path: string, source_file = file_dir): string {
  // Remove anchor
  const path_part = link_url.split('#')[0] ?? '';

  if (!path_part) {
    // Same-doc anchor: the caller resolves it to the doc itself
    return source_file;
  }

  // Handle absolute links (from docs root)
  if (path_part.startsWith('/')) {
    return join(docs_path, path_part);
  }

  // Handle relative links
  return resolve(file_dir, path_part);
}

/**
 * Check a single link and return its status
 */
export async function check_single_link(
  link_url: string,
  source_file: string,
  docs_path: string
): Promise<{ valid: boolean; reason?: string }> {
  const file_dir = dirname(source_file);
  const target_path = resolve_link(link_url, file_dir, docs_path);

  const exists = await path_exists(target_path);

  if (!exists) {
    return { valid: false, reason: 'Target file does not exist' };
  }

  return { valid: true };
}

/**
 * Get broken links for a specific file
 */
export async function get_file_broken_links(
  file_path: string,
  docs_path: string
): Promise<BrokenLink[]> {
  const content = await readFile(file_path, 'utf-8');
  const links = extract_links(content);
  const broken_links: BrokenLink[] = [];
  const file_dir = dirname(file_path);
  const rel_file = relative(docs_path, file_path);

  for (const link of links) {
    if (link.isInternal) {
      const target_path = resolve_link(link.url, file_dir, docs_path);
      const exists = await path_exists(target_path);

      if (!exists) {
        broken_links.push({
          sourceFile: rel_file,
          targetPath: link.url,
          lineNumber: link.lineNumber,
          linkText: link.text,
          reason: 'Target file does not exist',
        });
      }
    }
  }

  return broken_links;
}
