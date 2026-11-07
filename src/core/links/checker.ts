import { readFile } from 'fs/promises';
import { join, relative, dirname, resolve } from 'path';
import { findMarkdownFiles, pathExists } from '../../utils/glob.js';
import { extractLinks } from '../../utils/markdown.js';
import { logger } from '../../utils/logger.js';
import { detectDomainFromPath } from '../domains/detector.js';
import { headingAnchors, LINK_BROKEN_ANCHOR } from './anchors.js';
import type { Domain } from '../domains/constants.js';

// Re-export types from utils/markdown.js
export { type MarkdownLink } from '../../utils/markdown.js';
export { headingAnchors, sectionOf, LINK_BROKEN_ANCHOR } from './anchors.js';

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
export async function checkLinks(options: LinkCheckOptions): Promise<LinkCheckResult> {
  const {
    docsPath,
    domain,
    checkExternal = false,
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
  let files = await findMarkdownFiles(docsPath);

  // Filter by domain if specified
  if (domain) {
    files = files.filter((f) => {
      const rel = relative(docsPath, f);
      return rel.startsWith(domain + '/') || rel.startsWith(domain + '\\');
    });
  }

  result.totalFiles = files.length;

  if (!silent) {
    logger.info(`Checking ${files.length} files...`);
  }

  const domainConnections = new Map<string, number>();

  for (const file of files) {
    try {
      const content = await readFile(file, 'utf-8');
      const links = extractLinks(content);
      const relFile = relative(docsPath, file);
      const fileDir = dirname(file);

      for (const link of links) {
        result.totalLinks++;

        if (link.isInternal) {
          result.stats.internalLinks++;

          // Resolve the link path
          const targetPath = resolveLink(link.url, fileDir, docsPath, file);

          // Check if target exists
          const exists = await pathExists(targetPath);

          if (!exists) {
            result.brokenLinks.push({
              sourceFile: relFile,
              targetPath: link.url,
              lineNumber: link.lineNumber,
              linkText: link.text,
              reason: 'Target file does not exist',
            });
          } else {
            result.validLinks++;

            const anchor = anchorOf(link.url);
            if (anchor && targetPath.endsWith('.md')) {
              const md = targetPath === file ? content : await readFile(targetPath, 'utf-8').catch(() => null);
              if (md !== null && !headingAnchors(md).has(anchor)) {
                result.anchorWarnings.push({
                  sourceFile: relFile,
                  targetPath: link.url,
                  lineNumber: link.lineNumber,
                  linkText: link.text,
                  reason: `${LINK_BROKEN_ANCHOR}: no heading #${anchor}`,
                });
              }
            }

            // Track cross-domain links
            const sourceDomain = detectDomainFromPath(file, docsPath).domain;
            const targetDomain = detectDomainFromPath(targetPath, docsPath).domain;

            if (sourceDomain && targetDomain && sourceDomain !== targetDomain) {
              result.stats.crossDomainLinks++;
              result.crossDomainLinks.push({
                sourceFile: relFile,
                sourceDomain,
                targetPath: link.url,
                targetDomain,
                linkText: link.text,
              });

              // Track domain connections
              const connKey = `${sourceDomain} -> ${targetDomain}`;
              domainConnections.set(connKey, (domainConnections.get(connKey) ?? 0) + 1);
            }
          }
        } else {
          // extractLinks treats `#x` as non-internal; check it against the doc itself (counts unchanged)
          const self = link.url.startsWith('#') ? anchorOf(link.url) : null;
          if (self && !headingAnchors(content).has(self)) {
            result.anchorWarnings.push({
              sourceFile: relFile,
              targetPath: link.url,
              lineNumber: link.lineNumber,
              linkText: link.text,
              reason: `${LINK_BROKEN_ANCHOR}: no heading #${self}`,
            });
          }
          // External link
          result.stats.externalLinks++;
          result.externalLinks.push({
            sourceFile: relFile,
            url: link.url,
            linkText: link.text,
          });

          // Optionally check external links
          if (checkExternal) {
            // Note: External link checking would go here
            // For now, we just track them
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!silent) {
        logger.warn(`Error processing ${relative(docsPath, file)}: ${message}`);
      }
    }
  }

  // Calculate stats
  result.stats.brokenPercentage =
    result.stats.internalLinks > 0
      ? (result.brokenLinks.length / result.stats.internalLinks) * 100
      : 0;

  // Get top connected domains
  result.stats.topConnectedDomains = [...domainConnections.entries()]
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
  }

  return result;
}

function anchorOf(url: string): string | null {
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
function resolveLink(linkUrl: string, fileDir: string, docsPath: string, sourceFile = fileDir): string {
  // Remove anchor
  const pathPart = linkUrl.split('#')[0] ?? '';

  if (!pathPart) {
    // Same-doc anchor: the caller resolves it to the doc itself
    return sourceFile;
  }

  // Handle absolute links (from docs root)
  if (pathPart.startsWith('/')) {
    return join(docsPath, pathPart);
  }

  // Handle relative links
  return resolve(fileDir, pathPart);
}

/**
 * Check a single link and return its status
 */
export async function checkSingleLink(
  linkUrl: string,
  sourceFile: string,
  docsPath: string
): Promise<{ valid: boolean; reason?: string }> {
  const fileDir = dirname(sourceFile);
  const targetPath = resolveLink(linkUrl, fileDir, docsPath);

  const exists = await pathExists(targetPath);

  if (!exists) {
    return { valid: false, reason: 'Target file does not exist' };
  }

  return { valid: true };
}

/**
 * Get broken links for a specific file
 */
export async function getFileBrokenLinks(
  filePath: string,
  docsPath: string
): Promise<BrokenLink[]> {
  const content = await readFile(filePath, 'utf-8');
  const links = extractLinks(content);
  const brokenLinks: BrokenLink[] = [];
  const fileDir = dirname(filePath);
  const relFile = relative(docsPath, filePath);

  for (const link of links) {
    if (link.isInternal) {
      const targetPath = resolveLink(link.url, fileDir, docsPath);
      const exists = await pathExists(targetPath);

      if (!exists) {
        brokenLinks.push({
          sourceFile: relFile,
          targetPath: link.url,
          lineNumber: link.lineNumber,
          linkText: link.text,
          reason: 'Target file does not exist',
        });
      }
    }
  }

  return brokenLinks;
}
