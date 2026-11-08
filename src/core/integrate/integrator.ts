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
import { loadPluginConfig, type PluginConfig } from '../../utils/config.js';
import { scanText } from '../reconcile/secrets.js';
import { gitRoot } from '../reconcile/triage.js';
import { buildRepoIndex, extractReferences, resolveReferences, type RelatedRepo } from '../reconcile/references.js';
import { execFileSync } from 'child_process';

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
  /** Files/URLs this run added to the doc's `sources` (citation counts in `sourceCounts`). */
  sourcesAdded?: string[];
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
    const { data: existingMetadata, content: body } = parseFrontmatter<PartialDocumentMetadata>(content);

    // Secret guard (#61): the whole input is new, so any secret in it refuses the write.
    // --force does not bypass this; only the allowlist/baseline does. Findings are masked.
    const root = gitRoot(docsPath) ?? dirname(resolve(docsPath));
    const config = await loadPluginConfig(root);
    const found = scanText(content, basename(filePath), config.reconcile.secrets);
    const secrets = found.filter((f) => f.kind === 'secret');
    if (!silent) for (const f of found.filter((f) => f.kind === 'personal')) logger.warn(`personal data (${f.rule}) at ${f.file}:${f.line}`);
    if (secrets.length) {
      result.error =
        `Refusing to integrate: ${secrets.length} secret(s) found (rule file:line first4…length): ` +
        secrets.slice(0, 5).map((f) => `${f.rule} ${f.file}:${f.line} ${f.masked}`).join(', ') +
        (secrets.length > 5 ? ` (+${secrets.length - 5} more)` : '') +
        '. Move the value with `hewtd reconcile --secrets` (value to .env.hewtd, pointer left in the doc), ' +
        'or baseline a false positive with `hewtd secrets --baseline-add <file:line> --reason "..."`. --force does not bypass this.';
      return result;
    }

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

    // Sources (#61): record cited code files, never `last_verified`.
    const added = await citedSources(body, root, config, Array.isArray(existingMetadata.sources) ? existingMetadata.sources : undefined, silent);
    if (added.length) {
      finalMetadata.sources = [...(Array.isArray(existingMetadata.sources) ? existingMetadata.sources : []), ...added.map((a) => a.path)];
      result.sourcesAdded = added.map((a) => a.path);
      if (!silent) for (const a of added) logger.info(`  ${dryRun ? 'Would add' : 'Adding'} source: ${a.path} (cited ${a.count}x)`);
    }

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
 * Candidate `sources` for a new doc: file-level, de-duplicated, most-cited first (ties by first
 * mention), appended after any hand-written entries until `integrate.sources_max` is reached.
 * Best effort: outside a git repo there is nothing to resolve, so nothing is added.
 */
export async function citedSources(
  body: string,
  root: string,
  config: PluginConfig,
  hand: unknown[] | undefined,
  silent: boolean
): Promise<Array<{ path: string; count: number }>> {
  const room = config.integrate.sources_max - (hand?.length ?? 0);
  if (room <= 0) return [];
  // `path#symbol` and `path#anchor` fold into the path before extraction
  const text = body.replace(/(\.[A-Za-z]\w{0,4})#[\w.:-]+(?=[`\s)\]]|$)/g, '$1');
  const count = (s: string): number => text.split(s).length - 1;
  const cand = new Map<string, { count: number; first: number }>();
  const add = (path: string, ref: string): void => {
    const c = cand.get(path) ?? { count: 0, first: text.indexOf(ref) };
    c.count += count(ref);
    cand.set(path, c);
  };
  try {
    const idx = buildRepoIndex(root, config.reconcile.schema_sources);
    const related: RelatedRepo[] = config.reconcile.related_repos.map((r) => ({ name: r.name, root: resolve(root, r.path) }));
    const refs = await resolveReferences(idx, extractReferences(text), { related });
    for (const r of refs) {
      if (r.status === 'missing' || r.status === 'unknown') {
        if (!silent && r.status === 'missing' && r.kind !== 'doc-link') logger.warn(`  ${r.status}: ${r.ref} (not recorded in sources)`);
        continue;
      }
      if (r.status !== 'ok') continue;
      if (r.kind === 'path' && r.where) add(r.where, r.ref);
      else if (r.kind === 'command' && r.ref.startsWith('npm')) {
        const dir = idx.scripts.get(r.ref.replace(/^\S+ run /, ''));
        if (r.where) add(r.where, r.ref);
        else if (dir !== undefined) add(dir ? `${dir}/package.json` : 'package.json', r.ref);
      } else if ((r.kind === 'symbol' || r.kind === 'env') && r.where && !/^[\w.-]+:/.test(r.where)) {
        const only = uniqueFile(root, r.ref);
        if (only) add(only, r.ref);
      }
    }
  } catch {
    return []; // not a git checkout: nothing resolvable
  }
  for (const m of text.matchAll(/\]\((https?:\/\/[^)\s]+)\)|`(https?:\/\/[^`\s]+)`/g)) add((m[1] ?? m[2])!, (m[1] ?? m[2])!);
  const have = new Set((hand ?? []).filter((h): h is string => typeof h === 'string'));
  return [...cand]
    .filter(([p]) => !have.has(p))
    .sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
    .slice(0, room)
    .map(([path, c]) => ({ path, count: c.count }));
}

/** Data and generated files: a name found there is not a citation of that file (#58). */
const NOT_CODE = ['*.md', '*.mdx', '*.json', '*.jsonl', '*.csv', '*.tsv', '*.txt', '*.log', '*.svg', '*.xml', '*.lock', '*.min.js', '*.map', '*.snap'];

/** The one tracked code file holding `name`, or undefined when it is in none or several (#58). */
function uniqueFile(root: string, name: string): string | undefined {
  try {
    const out = execFileSync('git', ['grep', '-I', '-l', '-w', '-F', '-e', name, '--', '.', ...NOT_CODE.map((g) => `:!${g}`)], { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const files = out.split('\n').filter(Boolean);
    return files.length === 1 ? files[0] : undefined;
  } catch {
    return undefined;
  }
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
