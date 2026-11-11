import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, relative, basename, dirname, resolve, isAbsolute } from 'path';
import { logger } from '../../utils/logger.js';
import { parse_frontmatter, with_frontmatter } from '../../utils/frontmatter.js';
import { is_path_present, find_markdown_files } from '../../utils/glob.js';
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
import { find_git_top, triage_docs, type TriageDoc } from '../reconcile/triage.js';
import { build_repo_index, extract_references, resolve_references, type RelatedRepo } from '../reconcile/references.js';
import { write_review_skeletons } from '../reconcile/review.js';
import { execFileSync } from 'child_process';
import { get_cold_pathspec } from '../reconcile/rotation.js';

export interface IntegrateOptions {
  file_path: string;
  docs_root: string;
  auto?: boolean;
  dry_run?: boolean;
  force?: boolean;
  silent?: boolean;
  /** Target domain, overriding the frontmatter `domains:` and detection (#39). */
  domain?: string;
  /** Also write the review skeleton for the new doc (`hewtd reconcile --write-review`, #98). */
  review?: boolean;
}

export interface IntegrateResult {
  success: boolean;
  integrated: boolean;
  original_path: string;
  target_path?: string;
  domain?: Domain;
  tier?: string;
  duplicates?: DuplicateMatch[];
  metadata?: PartialDocumentMetadata;
  /** Files/URLs this run added to the doc's `sources` (citation counts in `sourceCounts`). */
  sources_added?: string[];
  /** Where the new doc lands in reconcile triage (lane, reasons, missing refs); absent on a dry run, outside a git checkout, or when `silent` without `review`. */
  triage?: Pick<TriageDoc, 'lane' | 'reasons' | 'missing'> & { unknown: string[] };
  /** Review skeleton written by `review: true`, relative to the repo root. */
  review_file?: string;
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
    file_path,
    docs_root: docs_root,
    auto = false,
    dry_run = false,
    force = false,
    silent = false,
    domain: domain_override,
    review = false,
  } = options;

  const result: IntegrateResult = {
    success: false,
    integrated: false,
    original_path: file_path,
  };

  if (!silent) {
    logger.header('Document Integration');
    logger.info(`File: ${file_path}`);
    if (dry_run) logger.info('Running in dry-run mode');
  }

  try {
    // Check if file exists
    if (!(await is_path_present(file_path))) {
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
    const repo_root = find_git_top(docs_root) ?? dirname(resolve(docs_root));
    const config = await load_plugin_config(repo_root);
    const found = scan_text(content, basename(file_path), config.reconcile.secrets);
    const secrets = found.filter((finding) => finding.kind === 'secret');
    if (!silent) for (const personal_finding of found.filter((file_item) => file_item.kind === 'personal')) logger.warn(`personal data (${personal_finding.rule}) at ${personal_finding.file}:${personal_finding.line}`);
    if (secrets.length) {
      result.error =
        `Refusing to integrate: ${secrets.length} secret(s) found (rule file:line first4…length): ` +
        secrets.slice(0, 5).map((secret) => `${secret.rule} ${secret.file}:${secret.line} ${secret.masked}`).join(', ') +
        (secrets.length > 5 ? ` (+${secrets.length - 5} more)` : '') +
        '. Move the value with `hewtd reconcile --secrets` (value to .env.hewtd, pointer left in the doc), ' +
        'or baseline a false positive with `hewtd secrets --baseline-add <file:line> --reason "..."`. --force does not bypass this.';
      return result;
    }

    // Detect domain
    const domain_result = detect_domain(file_path, content, docs_root);
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
      docs_root
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
      const high_similarity = duplicates.some((duplicate) => duplicate.similarity > 0.7);
      if (high_similarity && !force && !auto) {
        result.error = 'Potential duplicate detected. Use --force to override.';
        return result;
      }
    }

    // Generate metadata
    const generated = generate_metadata({
      file_path,
      content,
      docs_root: docs_root,
      existing_metadata,
      infer_purpose: false,
    });

    const final_metadata = merge_metadata(existing_metadata, generated);
    result.metadata = final_metadata;

    // Sources (#61): record cited code files, never `last_verified`.
    const added = await load_cited_sources(body, repo_root, config, Array.isArray(existing_metadata.sources) ? existing_metadata.sources : undefined, silent);
    if (added.length) {
      final_metadata.sources = [...(Array.isArray(existing_metadata.sources) ? existing_metadata.sources : []), ...added.map((a) => a.path)];
      result.sources_added = added.map((a) => a.path);
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
        ...(existing_metadata.domains ?? []).filter((doc) => doc !== domain_override),
      ]; // only the requested domain plus the doc's own, never a detected extra (#98)
    }
    const file_name = basename(file_path);
    const target_path = join(docs_root, target_domain, file_name);
    result.target_path = target_path;
    const copied = resolve(file_path) !== resolve(target_path);

    // Never overwrite a different doc; --force only bypasses the duplicate check.
    if (copied && (await is_path_present(target_path))) {
      const same_body = parse_frontmatter(await readFile(target_path, 'utf-8')).content.trim() === parse_frontmatter(content).content.trim();
      result.error = same_body
        ? `${relative(docs_root, target_path)} is already integrated (same content apart from the frontmatter hewtd added). Nothing was written.`
        : `${relative(docs_root, target_path)} already exists and is a different doc; give the file another name or use --domain. Nothing was written.`;
      return result;
    }

    // A doc already in the tree must not be copied (that leaves two). Moving it
    // would break inbound links, so only the in-place rewrite is allowed.
    const doc_path = relative(resolve(docs_root), resolve(file_path));
    if (doc_path && !doc_path.startsWith('..') && !isAbsolute(doc_path) && resolve(file_path) !== resolve(target_path)) {
      result.error = `${doc_path} is already in the docs tree; use maintain --fix / metadata-sync`;
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
      logger.info(`Target path: ${relative(docs_root, target_path)}`);
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
    if (!(await is_path_present(target_dir))) {
      await mkdir(target_dir, { recursive: true });
    }

    // Write file with updated metadata
    const new_content = with_frontmatter(content, final_metadata as unknown as Record<string, unknown>);
    await writeFile(target_path, new_content, 'utf-8');

    // Regenerate the target domain's INDEX.md / REGISTRY.md (and the root
    // indexes) from disk. This replaces the old regex-append path, which
    // could only update an already-populated table and silently no-op'd on
    // a freshly scaffolded INDEX.md — so the first document into any domain
    // was never registered. A failure here now propagates to the caller
    // instead of being swallowed, so `integrate` cannot report a false
    // success. See https://github.com/TheGlitchKing/hit-em-with-the-docs/issues/7
    await regenerate_indexes({ docs_root: docs_root, domains: [target_domain], silent });

    result.success = true;
    result.integrated = true;

    if (!silent) {
      logger.newline();
      logger.success('Document integrated successfully!');
      if (copied) {
        logger.info('The original file was copied, not moved: delete it yourself if you no longer need it.');
        if (is_tracked(file_path)) logger.info('Until you remove or archive the tracked original, reconcile counts it as another mention of the names in this doc.');
      }
    }
    await report_triage(result, { repo_root, docs_root, config, review, silent, source: copied ? file_path : undefined });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.error = message;

    if (!silent) {
      logger.error(`Integration failed: ${message}`);
    }
  }

  return result;
}

/** True when git tracks the file (an untracked draft is not mention evidence for reconcile). */
function is_tracked(file_path: string): boolean {
  try {
    // eslint-disable-next-line id-denylist -- child_process option name
    execFileSync('git', ['ls-files', '--error-unmatch', '--', basename(file_path)], { cwd: dirname(resolve(file_path)), stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/** Say where the new doc stands in reconcile triage and what to do next (#98); best effort, never fails the integrate. */
async function report_triage(
  result: IntegrateResult,
  context: { repo_root: string; docs_root: string; config: PluginConfig; review: boolean; silent: boolean; source?: string | undefined }
): Promise<void> {
  const { repo_root, docs_root, config, review, silent, source } = context;
  if (silent && !review) return; // triage builds the repo index: batch callers (reconcile --outside) skip it
  const doc_path = relative(docs_root, result.target_path!).replace(/\\/g, '/');
  try {
    const triaged = await triage_docs({ root: repo_root, docs_root, rels: [doc_path], config, ...(source && { ignore_mentions: [relative(find_git_top(docs_root) ?? repo_root, resolve(source)).replace(/\\/g, '/')] }) });
    const doc = triaged.docs[0];
    if (!doc) return;
    // eslint-disable-next-line id-denylist -- serialized key (triage JSON)
    const unknown = doc.refs.filter((reference) => reference.status === 'unknown').map((reference) => reference.ref);
    result.triage = { lane: doc.lane, reasons: doc.reasons, missing: doc.missing, unknown };
    if (review) {
      const [file] = await write_review_skeletons({ root: repo_root, docs_root, triage: triaged, scope: doc_path, include_clean: true });
      if (file) result.review_file = relative(repo_root, file);
    }
  } catch (error) {
    if (!silent) logger.warn(`Could not triage the new doc: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (silent) return;
  const { lane, reasons, missing, unknown } = result.triage!;
  logger.newline();
  logger.info(`Reconcile lane: ${lane}${reasons.length ? ` (${reasons.join('; ')})` : ''}`);
  for (const reference of missing) logger.warn(`  missing reference: ${reference} (fix the doc, or list it under external_refs if it is fine)`);
  for (const reference of unknown) logger.info(`  unverified reference: ${reference} (not found in the code index; check it, or list it under external_refs)`);
  if (result.review_file) logger.info(`  wrote ${result.review_file}`);
  logger.info(result.review_file
    ? `Next: fill ${result.review_file} (verdict, sources, external_refs, purpose, symptoms), then \`hewtd reconcile --apply ${result.review_file}\`; or commit and run /hit-em-with-the-docs:reconcile ${doc_path}`
    : `Next: write purpose and symptoms, then \`hewtd reconcile --changed --write-review\` (no commit needed), judge the entry and --apply; or commit and run /hit-em-with-the-docs:reconcile ${doc_path}`);
}

/**
 * Candidate `sources` for a new doc: file-level, de-duplicated, most-cited first (ties by first
 * mention), appended after any hand-written entries until `integrate.sources_max` is reached.
 * Best effort: outside a git repo there is nothing to resolve, so nothing is added.
 */
export async function load_cited_sources(
  body: string,
  repo_root: string,
  config: PluginConfig,
  hand: unknown[] | undefined,
  silent: boolean
): Promise<Array<{ path: string; count: number }>> {
  const room = config.integrate.sources_max - (hand?.length ?? 0);
  if (room <= 0) return [];
  // `path#symbol` and `path#anchor` fold into the path before extraction
  const text = body.replace(/(\.[A-Za-z]\w{0,4})#[\w.:-]+(?=[`\s)\]]|$)/g, '$1');
  const count_occurrences = (needle: string): number => text.split(needle).length - 1;
  const candidate = new Map<string, { count: number; first: number }>();
  const add_cited_source = (path: string, reference: string): void => {
    const content = candidate.get(path) ?? { count: 0, first: text.indexOf(reference) };
    content.count += count_occurrences(reference);
    candidate.set(path, content);
  };
  try {
    const index = build_repo_index(repo_root, config.reconcile.schema_sources);
    const sibling_repos: RelatedRepo[] = config.reconcile.related_repos.map((sibling_repo) => ({ name: sibling_repo.name, root: resolve(repo_root, sibling_repo.path) }));
    const references = await resolve_references(index, extract_references(text), { related: sibling_repos });
    for (const resolved of references) {
      if (resolved.status === 'missing' || resolved.status === 'unknown') {
        if (!silent && resolved.status === 'missing' && resolved.kind !== 'doc-link') logger.warn(`  ${resolved.status}: ${resolved.ref} (not recorded in sources)`);
        continue;
      }
      if (resolved.status !== 'ok') continue;
      if (resolved.kind === 'path' && resolved.where) add_cited_source(resolved.where, resolved.ref);
      else if (resolved.kind === 'command' && resolved.ref.startsWith('npm')) {
        const script_dir = index.scripts.get(resolved.ref.replace(/^\S+ run /, ''));
        if (resolved.where) add_cited_source(resolved.where, resolved.ref);
        else if (script_dir !== undefined) add_cited_source(script_dir ? `${script_dir}/package.json` : 'package.json', resolved.ref);
      } else if ((resolved.kind === 'symbol' || resolved.kind === 'env') && resolved.where && !/^[\w.-]+:/.test(resolved.where)) {
        const only = find_unique_file(repo_root, resolved.ref);
        if (only) add_cited_source(only, resolved.ref);
      }
    }
  } catch {
    return []; // not a git checkout: nothing resolvable
  }
  for (const match of text.matchAll(/\]\((https?:\/\/[^)\s]+)\)|`(https?:\/\/[^`\s]+)`/g)) add_cited_source((match[1] ?? match[2])!, (match[1] ?? match[2])!);
  const have = new Set((hand ?? []).filter((heading): heading is string => typeof heading === 'string'));
  return [...candidate]
    .filter(([heading]) => !have.has(heading))
    .sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
    .slice(0, room)
    .map(([path, content]) => ({ path, count: content.count }));
}

/** Data and generated files: a name found there is not a citation of that file (#58). */
const NOT_CODE = ['*.md', '*.mdx', '*.json', '*.jsonl', '*.csv', '*.tsv', '*.txt', '*.log', '*.svg', '*.xml', '*.lock', '*.min.js', '*.map', '*.snap'];

/** The one tracked code file holding `name`, or undefined when it is in none or several (#58). */
function find_unique_file(repo_root: string, name: string): string | undefined {
  try {
    // eslint-disable-next-line id-denylist -- child_process/glob option name
    const found = execFileSync('git', ['grep', '-I', '-l', '-w', '-F', '-e', name, '--', '.', ...NOT_CODE.map((graph) => `:!${graph}`), ...get_cold_pathspec(repo_root)], { cwd: repo_root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const files = found.split('\n').filter(Boolean);
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
  docs_root: string
): Promise<DuplicateMatch[]> {
  const files = await find_markdown_files(docs_root);
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
      const content_similarity = compute_content_similarity(content, file_content);

      // Combined similarity
      const similarity = title_similarity * 0.6 + content_similarity * 0.4;

      if (similarity > 0.5) {
        duplicates.push({
          path: relative(docs_root, file),
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
function compute_content_similarity(content1: string, content2: string): number {
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
export async function integrate_batch(
  files: string[],
  options: Omit<IntegrateOptions, 'filePath'>
): Promise<IntegrateResult[]> {
  const results: IntegrateResult[] = [];

  for (const file of files) {
    const result = await integrate_document({
      ...options,
      file_path: file,
    });
    results.push(result);
  }

  return results;
}
