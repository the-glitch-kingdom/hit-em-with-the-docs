import { readdir, readFile, writeFile } from 'fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { type Domain } from '../core/domains/constants.js';
import { get_all_domains } from '../core/domains/registry.js';
import { parse_frontmatter } from '../utils/frontmatter.js';
import { format_date } from '../core/metadata/generator.js';
import { is_path_present } from '../utils/glob.js';
import {
  load_plugin_config,
  load_plugin_config_sync,
  resolve_vault_root,
  resolve_playbook_globs,
} from '../utils/config.js';
import { build_citer_index } from '../core/knowledge-base/citers.js';
import { write_facts_index } from './facts-index.js';
import { write_incidents_index } from './incidents-index.js';
import { write_symptoms_index } from './symptoms-index.js';
import { logger } from '../utils/logger.js';
import {
  generate_root_index,
  generate_domain_index_content,
  type IndexEntry,
} from './index-generator.js';
import {
  generate_root_registry,
  generate_domain_registry_content,
} from './registry-generator.js';

/** Generated files that are never themselves treated as documents. */
const SYSTEM_FILES = new Set(['INDEX.md', 'REGISTRY.md']);

/**
 * Directory names that are never part of the active corpus, at any depth
 * inside a domain. Before the walk went recursive these were excluded by
 * accident — a flat readdir physically could not reach them — so this set is
 * what keeps a hand-made `features/archive/` or a vendored doc tree from being
 * published into a live index.
 */
const EXCLUDED_DIRS = new Set([
  'archive',
  'drafts',
  'reports',
  '_templates',
  'node_modules',
  '.documentation',
]);

/**
 * Vault subtrees that have their own generators (`facts-index`,
 * `incidents-index`, `symptoms-index`) and their own lifecycle tiers
 * (`fact`, `incident-narrative`, `incident-facts`).
 *
 * Only these are withheld from the generic domain index — not the whole vault
 * root. A project that registers the vault root as a domain (as
 * `knowledge-base` commonly is) still gets its top-level docs indexed as it
 * always has; what it must never get is every fact and incident narrative
 * swept into a generic INDEX/REGISTRY, indexed a second time and rendered as
 * if they were ordinary guides.
 */
const VAULT_GENERATED_SUBDIRS = ['facts', 'incidents', 'symptoms'];

/**
 * Prefixes, relative to the docs root, that the vault's own generators own —
 * e.g. `['knowledge-base/facts', 'knowledge-base/incidents', ...]`. Empty when
 * the configured vault lives outside the docs tree entirely.
 */
function get_vault_owned_prefixes(docs_root: string): string[] {
  const docs_abs = resolve(docs_root);
  const repo_root = dirname(docs_abs);
  const vault_abs = resolve_vault_root(repo_root, load_plugin_config_sync(repo_root));
  const doc_path = relative(docs_abs, vault_abs);
  if (!doc_path || doc_path.startsWith('..')) return [];
  const vault_path = doc_path.split(sep).join('/');
  return VAULT_GENERATED_SUBDIRS.map((sub) => `${vault_path}/${sub}`);
}

export interface RegenerateOptions {
  /** Path to the documentation root (e.g. `.documentation`). */
  docs_root: string;
  /**
   * Restrict domain INDEX.md/REGISTRY.md writes to these domains. The root
   * INDEX.md/REGISTRY.md are always refreshed regardless. Defaults to all
   * domains.
   */
  domains?: Domain[];
  silent?: boolean;
  /**
   * Compute everything, write nothing. `filesWritten` then lists the files
   * that WOULD be written. Exists so users can preview the (large, one-time)
   * diff the 2.7.1 recursive walk produces before committing to it.
   */
  dry_run?: boolean;
}

export interface RegenerateResult {
  /** Per-domain document counts — all domains, regardless of the filter. */
  document_counts: Record<string, number>;
  /** Absolute paths of every INDEX.md / REGISTRY.md written. */
  files_written: string[];
  /** Total documents across all domains. */
  total_documents: number;
}

/**
 * List the document files in a domain directory, walking subfolders. Returns
 * sorted, domain-relative POSIX paths (`backend/entity-schema-contract.md`).
 * Empty when the domain directory does not exist.
 *
 * This is the shared spine for three consumers — the index generator, the
 * `index-drift` audit rule, and the `domain remove` orphan count — so what it
 * excludes, the whole system excludes: the generated INDEX/REGISTRY at any
 * depth, `EXCLUDED_DIRS`, and the vault's generator-owned subtrees (issue #12).
 */
export async function list_domain_doc_files(
  docs_root: string,
  domain: string
): Promise<string[]> {
  const vault_prefixes = get_vault_owned_prefixes(docs_root);
  const is_in_vault = (doc_rel_path: string): boolean => {
    const from_docs_root = `${domain}/${doc_rel_path}`;
    return vault_prefixes.some((prefix) => from_docs_root.startsWith(`${prefix}/`));
  };

  try {
    const names = await readdir(join(docs_root, domain), { recursive: true });
    return names
      .map((name) => name.split(sep).join('/'))
      .filter((file_name) => file_name.endsWith('.md'))
      .filter((file_name) => !SYSTEM_FILES.has(basename(file_name)))
      .filter((file_name) => !file_name.split('/').some((seg) => EXCLUDED_DIRS.has(seg)))
      .filter((file_name) => !is_in_vault(file_name))
      .sort();
  } catch {
    return [];
  }
}

/** Normalise a frontmatter date (Date | ISO string | plain date) to YYYY-MM-DD. */
function normalize_date(value: unknown): string {
  if (value instanceof Date) return format_date(value);
  if (typeof value === 'string') {
    const match = value.match(/\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : value;
  }
  return format_date(new Date());
}

/** Count words in a markdown body (frontmatter already stripped). */
function count_words(body: string): number {
  return body.split(/\s+/).filter(Boolean).length;
}

/**
 * Derive a human title from a file name when frontmatter has no title. Takes
 * the basename: the input is a domain-relative subpath, and title-casing the
 * whole thing would render `backend/entity-schema-contract.md` as
 * "Backend/entity Schema Contract".
 */
function format_title_from_file_name(file_name: string): string {
  return basename(file_name)
    .replace(/\.md$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (first_letter) => first_letter.toUpperCase());
}

/**
 * Build IndexEntry[] for one domain by reading every document's frontmatter.
 * `pathPrefix` is prepended to each entry's `path` — `''` for domain-relative
 * paths (domain INDEX/REGISTRY) or `'<domain>/'` for root-relative paths.
 */
async function build_domain_entries(
  docs_root: string,
  domain: string,
  path_prefix: string
): Promise<IndexEntry[]> {
  const files = await list_domain_doc_files(docs_root, domain);
  const entries: IndexEntry[] = [];

  for (const file_name of files) {
    let raw_text: string;
    try {
      raw_text = await readFile(join(docs_root, domain, file_name), 'utf-8');
    } catch {
      continue;
    }

    // A doc with malformed YAML must not take down the whole run. Before the
    // walk went recursive these files were simply never read; now that they
    // are, one bad frontmatter block in one nested doc would otherwise abort
    // `index`/`maintain` for the entire project with a gray-matter stack
    // trace. Index it anyway — the document exists and should be findable —
    // with filename-derived defaults, and say so.
    let data: Record<string, unknown> = {};
    let content = '';
    try {
      ({ data, content } = parse_frontmatter<Record<string, unknown>>(raw_text));
    } catch (error) {
      logger.warn(
        `Unparseable frontmatter in ${domain}/${file_name} — indexing it with ` +
          `defaults. Fix the YAML to control how it appears: ` +
          `${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
      );
    }

    entries.push({
      path: path_prefix + file_name,
      title:
        typeof data.title === 'string' && data.title.trim()
          ? data.title
          : format_title_from_file_name(file_name),
      tier: typeof data.tier === 'string' ? data.tier : 'guide',
      status: typeof data.status === 'string' ? data.status : 'active',
      last_updated: normalize_date(data.last_updated),
      ...(typeof data.purpose === 'string' && { purpose: data.purpose }),
      word_count:
        typeof data.word_count === 'number'
          ? data.word_count
          : count_words(content),
    });
  }

  return entries;
}

/**
 * Regenerate domain + root INDEX.md / REGISTRY.md from the documents on disk.
 *
 * This is the single source of truth for index generation, shared by
 * `integrate`, `maintain`, and the `index` CLI command. It replaces the
 * fragile regex-append path in `integrate` that could only update an
 * already-populated table — and silently no-op'd on a freshly scaffolded
 * INDEX.md, so the first document into any domain was never registered
 * (see https://github.com/TheGlitchKing/hit-em-with-the-docs/issues/7).
 */
export async function regenerate_indexes(
  options: RegenerateOptions
): Promise<RegenerateResult> {
  const { docs_root: docs_root, silent = false, dry_run = false } = options;
  const all_domains = get_all_domains();
  const target_domains = options.domains ?? all_domains;

  const result: RegenerateResult = {
    document_counts: {},
    files_written: [],
    total_documents: 0,
  };

  // Scan every domain — the root INDEX needs counts for all of them even
  // when only a subset of domain files is being rewritten.
  const root_entries_by_domain: Record<string, IndexEntry[]> = {};
  // Generated files link only to domains with a folder on disk (#45).
  const present: Domain[] = [];
  for (const domain of all_domains) {
    if (await is_path_present(join(docs_root, domain))) present.push(domain);
  }

  for (const domain of all_domains) {
    const domain_entries = await build_domain_entries(docs_root, domain, '');
    result.document_counts[domain] = domain_entries.length;
    result.total_documents += domain_entries.length;
    root_entries_by_domain[domain] = domain_entries.map((domain_entry) => ({
      ...domain_entry,
      path: `${domain}/${domain_entry.path}`,
    }));

    // Only (re)write a domain's own files when it is in the target set and
    // its directory actually exists on disk.
    if (!target_domains.includes(domain) || !present.includes(domain)) continue;
    const domain_dir = join(docs_root, domain);

    const index_path = join(domain_dir, 'INDEX.md');
    const registry_path = join(domain_dir, 'REGISTRY.md');
    if (!dry_run) {
      await writeFile(
        index_path,
        generate_domain_index_content(domain, domain_entries, present),
        'utf-8'
      );
      await writeFile(
        registry_path,
        generate_domain_registry_content(domain, domain_entries),
        'utf-8'
      );
    }
    result.files_written.push(index_path, registry_path);
  }

  // Root INDEX.md / REGISTRY.md — always refreshed.
  if (await is_path_present(docs_root)) {
    const root_index_path = join(docs_root, 'INDEX.md');
    const root_registry_path = join(docs_root, 'REGISTRY.md');
    if (!dry_run) {
      await writeFile(
        root_index_path,
        generate_root_index(root_entries_by_domain as Record<Domain, IndexEntry[]>),
        'utf-8'
      );
      await writeFile(root_registry_path, generate_root_registry(present), 'utf-8');
    }
    result.files_written.push(root_index_path, root_registry_path);
  }

  if (!silent) {
    logger.success(
      `${dry_run ? 'Would regenerate' : 'Regenerated'} ${result.files_written.length} ` +
        `index file(s) — ${result.total_documents} document(s) across ` +
        `${all_domains.length} domains`
    );
  }

  return result;
}

export interface KbIndexResult {
  facts: number;
  incidents: number;
  facts_path: string;
  incidents_path: string;
  symptoms_path: string;
}

/**
 * Rebuild the facts/incidents/symptoms indexes when a vault root exists; null
 * (and no writes) when it doesn't. With `dryRun` only counts the facts and
 * incidents; nothing is written.
 */
export async function generate_knowledge_base_indexes(
  docs_root: string,
  dry_run = false
): Promise<KbIndexResult | null> {
  // Config and playbook globs resolve relative to the project root (parent of docs_root).
  const repo_root = dirname(docs_root);
  const config = await load_plugin_config(repo_root);
  const vault_root = resolve_vault_root(repo_root, config);
  if (!(await is_path_present(vault_root))) return null;

  const playbook_globs = resolve_playbook_globs(repo_root, config);
  const index = await build_citer_index({ repo_root: repo_root, vault_root, playbook_globs });
  const facts_path = join(vault_root, 'facts', 'INDEX.md');
  const base = { facts: index.facts.size, incidents: index.incidents.size };
  if (dry_run) {
    return { ...base, facts_path, incidents_path: '', symptoms_path: '' };
  }
  return {
    ...base,
    facts_path: await write_facts_index({ vault_root, index }),
    incidents_path: await write_incidents_index({ vault_root, index }),
    symptoms_path: await write_symptoms_index({ vault_root, index }),
  };
}
