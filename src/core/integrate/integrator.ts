import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, relative, basename, dirname, resolve, isAbsolute } from 'path';
import { logger } from '../../utils/logger.js';
import { parse_frontmatter, set_frontmatter } from '../../utils/frontmatter.js';
import { path_exists, find_markdown_files } from '../../utils/glob.js';
import { detect_domain } from '../domains/detector.js';
import { is_valid_domain } from '../domains/registry.js';
import { classify_tier } from '../domains/classifier.js';
import { generate_metadata, merge_metadata } from '../metadata/generator.js';
import { type PartialDocumentMetadata } from '../metadata/schema.js';
import type { Domain } from '../domains/constants.js';
import { regenerate_indexes } from '../../generators/regenerate.js';
import levenshtein from 'fast-levenshtein';
import { load_plugin_config, type PluginConfig } from '../../utils/config.js';
import { scan_text } from '../reconcile/secrets.js';
import { git_root } from '../reconcile/triage.js';
import { build_repo_index, extract_references, resolve_references, type RelatedRepo } from '../reconcile/references.js';
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
export async function integrate_document(
  options: IntegrateOptions
): Promise<IntegrateResult> {
  const {
    filePath: file_path,
    docsPath: docs_path,
    auto = false,
    dryRun: dry_run = false,
    force = false,
    silent = false,
    domain: domain_override,
  } = options;

  const result: IntegrateResult = {
    success: false,
    integrated: false,
    originalPath: file_path,
  };

  if (!silent) {
    logger.header('Document Integration');
    logger.info(`File: ${file_path}`);
    if (dry_run) logger.info('Running in dry-run mode');
  }

  try {
    // Check if file exists
    if (!(await path_exists(file_path))) {
      result.error = 'File does not exist';
      return result;
    }

    if (domain_override !== undefined && !is_valid_domain(domain_override)) {
      result.error = `Unknown domain: ${domain_override}. \`hewtd domain list\` shows the valid ids.`;
      return result;
    }

    // Read file content
    const content = await readFile(file_path, 'utf-8');
    const { data: existing_metadata, content: body } = parse_frontmatter<PartialDocumentMetadata>(content);

    // Secret guard (#61): the whole input is new, so any secret in it refuses the write.
    // --force does not bypass this; only the allowlist/baseline does. Findings are masked.
    const root = git_root(docs_path) ?? dirname(resolve(docs_path));
    const config = await load_plugin_config(root);
    const found = scan_text(content, basename(file_path), config.reconcile.secrets);
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
    const domain_result = detect_domain(file_path, content, docs_path);
    if (domain_result.domain) {
      result.domain = domain_result.domain;
    }

    if (!silent) {
      logger.info(`Detected domain: ${result.domain ?? 'unknown'} (${(domain_result.confidence * 100).toFixed(0)}% confidence)`);
    }

    // Classify tier
    const tier_result = classify_tier(content);
    result.tier = tier_result.tier;

    if (!silent) {
      logger.info(`Detected tier: ${result.tier} (${(tier_result.confidence * 100).toFixed(0)}% confidence)`);
    }

    // Check for duplicates
    const duplicates = await find_duplicates(
      existing_metadata.title ?? basename(file_path, '.md'),
      content,
      docs_path
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
      const high_similarity = duplicates.some((d) => d.similarity > 0.7);
      if (high_similarity && !force && !auto) {
        result.error = 'Potential duplicate detected. Use --force to override.';
        return result;
      }
    }

    // Generate metadata
    const generated = generate_metadata({
      filePath: file_path,
      content,
      docsRoot: docs_path,
      existingMetadata: existing_metadata,
    });

    const final_metadata = merge_metadata(existing_metadata, generated);
    result.metadata = final_metadata;

    // Sources (#61): record cited code files, never `last_verified`.
    const added = await cited_sources(body, root, config, Array.isArray(existing_metadata.sources) ? existing_metadata.sources : undefined, silent);
    if (added.length) {
      final_metadata.sources = [...(Array.isArray(existing_metadata.sources) ? existing_metadata.sources : []), ...added.map((a) => a.path)];
      result.sourcesAdded = added.map((a) => a.path);
      if (!silent) for (const a of added) logger.info(`  ${dry_run ? 'Would add' : 'Adding'} source: ${a.path} (cited ${a.count}x)`);
    }

    // Determine target path. An explicit choice beats keyword detection:
    // `--domain`, then the doc's own first declared domain, then detection.
    // Before #39 the declared domain was kept in the metadata but ignored
    // here, so a doc could land in a folder its own frontmatter disagreed with.
    const declared = existing_metadata.domains?.[0];
    const target_domain =
      domain_override ??
      (typeof declared === 'string' && is_valid_domain(declared) ? declared : undefined) ??
      result.domain ??
      'features';
    result.domain = target_domain as Domain;
    if (domain_override) {
      final_metadata.domains = [
        domain_override,
        ...(final_metadata.domains ?? []).filter((d) => d !== domain_override),
      ];
    }
    const file_name = basename(file_path);
    const target_path = join(docs_path, target_domain, file_name);
    result.targetPath = target_path;

    // A doc already in the tree must not be copied (that leaves two). Moving it
    // would break inbound links, so only the in-place rewrite is allowed.
    const rel = relative(resolve(docs_path), resolve(file_path));
    if (rel && !rel.startsWith('..') && !isAbsolute(rel) && resolve(file_path) !== resolve(target_path)) {
      result.error = `${rel} is already in the docs tree; use maintain --fix / metadata-sync`;
      return result;
    }

    if (!silent) {
      logger.newline();
      logger.info('Generated metadata:');
      logger.info(`  Title: ${final_metadata.title}`);
      logger.info(`  Tier: ${final_metadata.tier}`);
      logger.info(`  Domains: ${final_metadata.domains?.join(', ')}`);
      logger.info(`  Status: ${final_metadata.status}`);
      logger.newline();
      logger.info(`Target path: ${relative(docs_path, target_path)}`);
    }

    if (dry_run) {
      result.success = true;
      if (!silent) {
        logger.info('Dry-run complete. No changes made.');
      }
      return result;
    }

    // Create target directory if needed
    const target_dir = dirname(target_path);
    if (!(await path_exists(target_dir))) {
      await mkdir(target_dir, { recursive: true });
    }

    // Write file with updated metadata
    const new_content = set_frontmatter(content, final_metadata as unknown as Record<string, unknown>);
    await writeFile(target_path, new_content, 'utf-8');

    // Regenerate the target domain's INDEX.md / REGISTRY.md (and the root
    // indexes) from disk. This replaces the old regex-append path, which
    // could only update an already-populated table and silently no-op'd on
    // a freshly scaffolded INDEX.md — so the first document into any domain
    // was never registered. A failure here now propagates to the caller
    // instead of being swallowed, so `integrate` cannot report a false
    // success. See https://github.com/TheGlitchKing/hit-em-with-the-docs/issues/7
    await regenerate_indexes({ docsPath: docs_path, domains: [target_domain], silent });

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
export async function cited_sources(
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
    const idx = build_repo_index(root, config.reconcile.schema_sources);
    const related: RelatedRepo[] = config.reconcile.related_repos.map((r) => ({ name: r.name, root: resolve(root, r.path) }));
    const refs = await resolve_references(idx, extract_references(text), { related });
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
        const only = unique_file(root, r.ref);
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
function unique_file(root: string, name: string): string | undefined {
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
async function find_duplicates(
  title: string,
  content: string,
  docs_path: string
): Promise<DuplicateMatch[]> {
  const files = await find_markdown_files(docs_path);
  const duplicates: DuplicateMatch[] = [];

  const normalized_title = title.toLowerCase().replace(/[^a-z0-9]/g, '');

  for (const file of files) {
    try {
      const file_content = await readFile(file, 'utf-8');
      const { data } = parse_frontmatter<PartialDocumentMetadata>(file_content);

      const existing_title = data.title ?? basename(file, '.md');
      const normalized_existing = existing_title.toLowerCase().replace(/[^a-z0-9]/g, '');

      // Calculate title similarity using Levenshtein distance
      const title_distance = levenshtein.get(normalized_title, normalized_existing);
      const max_len = Math.max(normalized_title.length, normalized_existing.length);
      const title_similarity = max_len > 0 ? 1 - title_distance / max_len : 1;

      // Also check content similarity (simple approach: word overlap)
      const content_similarity = calculate_content_similarity(content, file_content);

      // Combined similarity
      const similarity = title_similarity * 0.6 + content_similarity * 0.4;

      if (similarity > 0.5) {
        duplicates.push({
          path: relative(docs_path, file),
          title: existing_title,
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
function calculate_content_similarity(content1: string, content2: string): number {
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
export async function batch_integrate(
  files: string[],
  options: Omit<IntegrateOptions, 'filePath'>
): Promise<IntegrateResult[]> {
  const results: IntegrateResult[] = [];

  for (const file of files) {
    const result = await integrate_document({
      ...options,
      filePath: file,
    });
    results.push(result);
  }

  return results;
}
