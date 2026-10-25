import { readdir, readFile, writeFile } from 'fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { type Domain } from '../core/domains/constants.js';
import { getAllDomains } from '../core/domains/registry.js';
import { parseFrontmatter } from '../utils/frontmatter.js';
import { formatDate } from '../core/metadata/generator.js';
import { pathExists } from '../utils/glob.js';
import { loadPluginConfigSync, resolveVaultRoot } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import {
  generateRootIndex,
  generateDomainIndexContent,
  type IndexEntry,
} from './index-generator.js';
import {
  generateRootRegistry,
  generateDomainRegistryContent,
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
function vaultOwnedPrefixes(docsPath: string): string[] {
  const docsAbs = resolve(docsPath);
  const projectRoot = dirname(docsAbs);
  const vaultAbs = resolveVaultRoot(projectRoot, loadPluginConfigSync(projectRoot));
  const rel = relative(docsAbs, vaultAbs);
  if (!rel || rel.startsWith('..')) return [];
  const vaultPath = rel.split(sep).join('/');
  return VAULT_GENERATED_SUBDIRS.map((sub) => `${vaultPath}/${sub}`);
}

export interface RegenerateOptions {
  /** Path to the documentation root (e.g. `.documentation`). */
  docsPath: string;
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
  dryRun?: boolean;
}

export interface RegenerateResult {
  /** Per-domain document counts — all domains, regardless of the filter. */
  documentCounts: Record<string, number>;
  /** Absolute paths of every INDEX.md / REGISTRY.md written. */
  filesWritten: string[];
  /** Total documents across all domains. */
  totalDocuments: number;
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
export async function listDomainDocFiles(
  docsPath: string,
  domain: string
): Promise<string[]> {
  const vaultPrefixes = vaultOwnedPrefixes(docsPath);
  const inVault = (docRelPath: string): boolean => {
    const fromDocsRoot = `${domain}/${docRelPath}`;
    return vaultPrefixes.some((prefix) => fromDocsRoot.startsWith(`${prefix}/`));
  };

  try {
    const names = await readdir(join(docsPath, domain), { recursive: true });
    return names
      .map((n) => n.split(sep).join('/'))
      .filter((n) => n.endsWith('.md'))
      .filter((n) => !SYSTEM_FILES.has(basename(n)))
      .filter((n) => !n.split('/').some((seg) => EXCLUDED_DIRS.has(seg)))
      .filter((n) => !inVault(n))
      .sort();
  } catch {
    return [];
  }
}

/** Normalise a frontmatter date (Date | ISO string | plain date) to YYYY-MM-DD. */
function normalizeDate(value: unknown): string {
  if (value instanceof Date) return formatDate(value);
  if (typeof value === 'string') {
    const match = value.match(/\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : value;
  }
  return formatDate(new Date());
}

/** Count words in a markdown body (frontmatter already stripped). */
function countWords(body: string): number {
  return body.split(/\s+/).filter(Boolean).length;
}

/**
 * Derive a human title from a file name when frontmatter has no title. Takes
 * the basename: the input is a domain-relative subpath, and title-casing the
 * whole thing would render `backend/entity-schema-contract.md` as
 * "Backend/entity Schema Contract".
 */
function titleFromFileName(fileName: string): string {
  return basename(fileName)
    .replace(/\.md$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Build IndexEntry[] for one domain by reading every document's frontmatter.
 * `pathPrefix` is prepended to each entry's `path` — `''` for domain-relative
 * paths (domain INDEX/REGISTRY) or `'<domain>/'` for root-relative paths.
 */
async function buildDomainEntries(
  docsPath: string,
  domain: string,
  pathPrefix: string
): Promise<IndexEntry[]> {
  const files = await listDomainDocFiles(docsPath, domain);
  const entries: IndexEntry[] = [];

  for (const fileName of files) {
    let raw: string;
    try {
      raw = await readFile(join(docsPath, domain, fileName), 'utf-8');
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
      ({ data, content } = parseFrontmatter<Record<string, unknown>>(raw));
    } catch (error) {
      logger.warn(
        `Unparseable frontmatter in ${domain}/${fileName} — indexing it with ` +
          `defaults. Fix the YAML to control how it appears: ` +
          `${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
      );
    }

    entries.push({
      path: pathPrefix + fileName,
      title:
        typeof data.title === 'string' && data.title.trim()
          ? data.title
          : titleFromFileName(fileName),
      tier: typeof data.tier === 'string' ? data.tier : 'guide',
      status: typeof data.status === 'string' ? data.status : 'active',
      lastUpdated: normalizeDate(data.last_updated),
      wordCount:
        typeof data.word_count === 'number'
          ? data.word_count
          : countWords(content),
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
export async function regenerateIndexes(
  options: RegenerateOptions
): Promise<RegenerateResult> {
  const { docsPath, silent = false, dryRun = false } = options;
  const allDomains = getAllDomains();
  const targetDomains = options.domains ?? allDomains;

  const result: RegenerateResult = {
    documentCounts: {},
    filesWritten: [],
    totalDocuments: 0,
  };

  // Scan every domain — the root INDEX needs counts for all of them even
  // when only a subset of domain files is being rewritten.
  const rootEntriesByDomain: Record<string, IndexEntry[]> = {};
  // Generated files link only to domains with a folder on disk (#45).
  const present: Domain[] = [];
  for (const domain of allDomains) {
    if (await pathExists(join(docsPath, domain))) present.push(domain);
  }

  for (const domain of allDomains) {
    const domainEntries = await buildDomainEntries(docsPath, domain, '');
    result.documentCounts[domain] = domainEntries.length;
    result.totalDocuments += domainEntries.length;
    rootEntriesByDomain[domain] = domainEntries.map((e) => ({
      ...e,
      path: `${domain}/${e.path}`,
    }));

    // Only (re)write a domain's own files when it is in the target set and
    // its directory actually exists on disk.
    if (!targetDomains.includes(domain) || !present.includes(domain)) continue;
    const domainDir = join(docsPath, domain);

    const indexPath = join(domainDir, 'INDEX.md');
    const registryPath = join(domainDir, 'REGISTRY.md');
    if (!dryRun) {
      await writeFile(
        indexPath,
        generateDomainIndexContent(domain, domainEntries, present),
        'utf-8'
      );
      await writeFile(
        registryPath,
        generateDomainRegistryContent(domain, domainEntries),
        'utf-8'
      );
    }
    result.filesWritten.push(indexPath, registryPath);
  }

  // Root INDEX.md / REGISTRY.md — always refreshed.
  if (await pathExists(docsPath)) {
    const rootIndexPath = join(docsPath, 'INDEX.md');
    const rootRegistryPath = join(docsPath, 'REGISTRY.md');
    if (!dryRun) {
      await writeFile(
        rootIndexPath,
        generateRootIndex(rootEntriesByDomain as Record<Domain, IndexEntry[]>),
        'utf-8'
      );
      await writeFile(rootRegistryPath, generateRootRegistry(present), 'utf-8');
    }
    result.filesWritten.push(rootIndexPath, rootRegistryPath);
  }

  if (!silent) {
    logger.success(
      `${dryRun ? 'Would regenerate' : 'Regenerated'} ${result.filesWritten.length} ` +
        `index file(s) — ${result.totalDocuments} document(s) across ` +
        `${allDomains.length} domains`
    );
  }

  return result;
}
