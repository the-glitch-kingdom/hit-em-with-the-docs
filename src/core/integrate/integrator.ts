import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, relative, basename, dirname, resolve, isAbsolute } from 'path';
import { logger } from '../../utils/logger.js';
import { parseFrontmatter, setFrontmatter } from '../../utils/frontmatter.js';
import { pathExists, findMarkdownFiles } from '../../utils/glob.js';
import { detectDomain } from '../domains/detector.js';
import { isValidDomain } from '../domains/registry.js';
import { classifyTier } from '../domains/classifier.js';
import { generateMetadata, mergeMetadata } from '../metadata/generator.js';
import { type PartialDocumentMetadata } from '../metadata/schema.js';
import type { Domain } from '../domains/constants.js';
import { regenerateIndexes } from '../../generators/regenerate.js';
import levenshtein from 'fast-levenshtein';

export interface IntegrateOptions {
  filePath: string;
  docsPath: string;
  auto?: boolean;
  dryRun?: boolean;
  force?: boolean;
  silent?: boolean;
  /** Target domain, overriding the frontmatter `domains:` and detection (#39). */
  domain?: string;
}

export interface IntegrateResult {
  success: boolean;
  integrated: boolean;
  originalPath: string;
  targetPath?: string;
  domain?: Domain;
  tier?: string;
  duplicates?: DuplicateMatch[];
  metadata?: PartialDocumentMetadata;
  error?: string;
}

export interface DuplicateMatch {
  path: string;
  title: string;
  similarity: number;
}

/**
 * Integrate a document into the documentation system
 */
export async function integrateDocument(
  options: IntegrateOptions
): Promise<IntegrateResult> {
  const {
    filePath,
    docsPath,
    auto = false,
    dryRun = false,
    force = false,
    silent = false,
    domain: domainOverride,
  } = options;

  const result: IntegrateResult = {
    success: false,
    integrated: false,
    originalPath: filePath,
  };

  if (!silent) {
    logger.header('Document Integration');
    logger.info(`File: ${filePath}`);
    if (dryRun) logger.info('Running in dry-run mode');
  }

  try {
    // Check if file exists
    if (!(await pathExists(filePath))) {
      result.error = 'File does not exist';
      return result;
    }

    if (domainOverride !== undefined && !isValidDomain(domainOverride)) {
      result.error = `Unknown domain: ${domainOverride}. \`hewtd domain list\` shows the valid ids.`;
      return result;
    }

    // Read file content
    const content = await readFile(filePath, 'utf-8');
    const { data: existingMetadata } = parseFrontmatter<PartialDocumentMetadata>(content);

    // Detect domain
    const domainResult = detectDomain(filePath, content, docsPath);
    if (domainResult.domain) {
      result.domain = domainResult.domain;
    }

    if (!silent) {
      logger.info(`Detected domain: ${result.domain ?? 'unknown'} (${(domainResult.confidence * 100).toFixed(0)}% confidence)`);
    }

    // Classify tier
    const tierResult = classifyTier(content);
    result.tier = tierResult.tier;

    if (!silent) {
      logger.info(`Detected tier: ${result.tier} (${(tierResult.confidence * 100).toFixed(0)}% confidence)`);
    }

    // Check for duplicates
    const duplicates = await findDuplicates(
      existingMetadata.title ?? basename(filePath, '.md'),
      content,
      docsPath
    );

    if (duplicates.length > 0) {
      result.duplicates = duplicates;

      if (!silent) {
        logger.warn(`Found ${duplicates.length} potential duplicate(s):`);
        for (const dup of duplicates) {
          logger.warn(`  - ${dup.path} (${(dup.similarity * 100).toFixed(0)}% similar)`);
        }
      }

      // If high similarity and not force, don't integrate
      const highSimilarity = duplicates.some((d) => d.similarity > 0.7);
      if (highSimilarity && !force && !auto) {
        result.error = 'Potential duplicate detected. Use --force to override.';
        return result;
      }
    }

    // Generate metadata
    const generated = generateMetadata({
      filePath,
      content,
      docsRoot: docsPath,
      existingMetadata,
    });

    const finalMetadata = mergeMetadata(existingMetadata, generated);
    result.metadata = finalMetadata;

    // Determine target path. An explicit choice beats keyword detection:
    // `--domain`, then the doc's own first declared domain, then detection.
    // Before #39 the declared domain was kept in the metadata but ignored
    // here, so a doc could land in a folder its own frontmatter disagreed with.
    const declared = existingMetadata.domains?.[0];
    const targetDomain =
      domainOverride ??
      (typeof declared === 'string' && isValidDomain(declared) ? declared : undefined) ??
      result.domain ??
      'features';
    result.domain = targetDomain as Domain;
    if (domainOverride) {
      finalMetadata.domains = [
        domainOverride,
        ...(finalMetadata.domains ?? []).filter((d) => d !== domainOverride),
      ];
    }
    const fileName = basename(filePath);
    const targetPath = join(docsPath, targetDomain, fileName);
    result.targetPath = targetPath;

    // A doc already in the tree must not be copied (that leaves two). Moving it
    // would break inbound links, so only the in-place rewrite is allowed.
    const rel = relative(resolve(docsPath), resolve(filePath));
    if (rel && !rel.startsWith('..') && !isAbsolute(rel) && resolve(filePath) !== resolve(targetPath)) {
      result.error = `${rel} is already in the docs tree; use maintain --fix / metadata-sync`;
      return result;
    }

    if (!silent) {
      logger.newline();
      logger.info('Generated metadata:');
      logger.info(`  Title: ${finalMetadata.title}`);
      logger.info(`  Tier: ${finalMetadata.tier}`);
      logger.info(`  Domains: ${finalMetadata.domains?.join(', ')}`);
      logger.info(`  Status: ${finalMetadata.status}`);
      logger.newline();
      logger.info(`Target path: ${relative(docsPath, targetPath)}`);
    }

    if (dryRun) {
      result.success = true;
      if (!silent) {
        logger.info('Dry-run complete. No changes made.');
      }
      return result;
    }

    // Create target directory if needed
    const targetDir = dirname(targetPath);
    if (!(await pathExists(targetDir))) {
      await mkdir(targetDir, { recursive: true });
    }

    // Write file with updated metadata
    const newContent = setFrontmatter(content, finalMetadata as unknown as Record<string, unknown>);
    await writeFile(targetPath, newContent, 'utf-8');

    // Regenerate the target domain's INDEX.md / REGISTRY.md (and the root
    // indexes) from disk. This replaces the old regex-append path, which
    // could only update an already-populated table and silently no-op'd on
    // a freshly scaffolded INDEX.md — so the first document into any domain
    // was never registered. A failure here now propagates to the caller
    // instead of being swallowed, so `integrate` cannot report a false
    // success. See https://github.com/TheGlitchKing/hit-em-with-the-docs/issues/7
    await regenerateIndexes({ docsPath, domains: [targetDomain], silent });

    result.success = true;
    result.integrated = true;

    if (!silent) {
      logger.newline();
      logger.success('Document integrated successfully!');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.error = message;

    if (!silent) {
      logger.error(`Integration failed: ${message}`);
    }
  }

  return result;
}

/**
 * Find potential duplicate documents
 */
async function findDuplicates(
  title: string,
  content: string,
  docsPath: string
): Promise<DuplicateMatch[]> {
  const files = await findMarkdownFiles(docsPath);
  const duplicates: DuplicateMatch[] = [];

  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');

  for (const file of files) {
    try {
      const fileContent = await readFile(file, 'utf-8');
      const { data } = parseFrontmatter<PartialDocumentMetadata>(fileContent);

      const existingTitle = data.title ?? basename(file, '.md');
      const normalizedExisting = existingTitle.toLowerCase().replace(/[^a-z0-9]/g, '');

      // Calculate title similarity using Levenshtein distance
      const titleDistance = levenshtein.get(normalizedTitle, normalizedExisting);
      const maxLen = Math.max(normalizedTitle.length, normalizedExisting.length);
      const titleSimilarity = maxLen > 0 ? 1 - titleDistance / maxLen : 1;

      // Also check content similarity (simple approach: word overlap)
      const contentSimilarity = calculateContentSimilarity(content, fileContent);

      // Combined similarity
      const similarity = titleSimilarity * 0.6 + contentSimilarity * 0.4;

      if (similarity > 0.5) {
        duplicates.push({
          path: relative(docsPath, file),
          title: existingTitle,
          similarity,
        });
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return duplicates.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Calculate content similarity using word overlap
 */
function calculateContentSimilarity(content1: string, content2: string): number {
  const words1 = new Set(content1.toLowerCase().match(/\b\w+\b/g) ?? []);
  const words2 = new Set(content2.toLowerCase().match(/\b\w+\b/g) ?? []);

  let intersection = 0;
  for (const word of words1) {
    if (words2.has(word)) {
      intersection++;
    }
  }

  const union = words1.size + words2.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Batch integrate multiple documents
 */
export async function batchIntegrate(
  files: string[],
  options: Omit<IntegrateOptions, 'filePath'>
): Promise<IntegrateResult[]> {
  const results: IntegrateResult[] = [];

  for (const file of files) {
    const result = await integrateDocument({
      ...options,
      filePath: file,
    });
    results.push(result);
  }

  return results;
}
