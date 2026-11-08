/**
 * Plugin config loader for `.claude/hit-em-with-the-docs.json`.
 *
 * The runtime (`@theglitchking/claude-plugin-runtime`) owns the
 * `updatePolicy` field. This module reads the same file and adds the
 * 2.3.0 `vault` block for knowledge-base configuration. Missing or
 * malformed files fall back to defaults — never throws.
 */

import { readFileSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'path';
import { z } from 'zod';

export const DEFAULT_DOCS_ROOT = '.documentation';
export const DEFAULT_VAULT_ROOT = '.documentation/knowledge-base/';
export const DEFAULT_PLAYBOOK_GLOBS = ['.documentation/**/*.md'];
export const DEFAULT_AUDIT_WINDOW_DAYS = 90;

/** Kebab-case slug: matches the fact/incident id convention used elsewhere. */
const KEBAB_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Valid `category` values for a domain. Kept in sync with `DomainDefinition`
 * in `core/domains/constants.ts` — duplicated here intentionally so the config
 * loader carries no dependency on the domain layer (the registry imports the
 * config, not the other way around).
 */
export const DOMAIN_CATEGORY_VALUES = [
  'core',
  'development',
  'features',
  'advanced',
] as const;

/**
 * Schema for a single custom domain entry. Mirrors `DomainDefinition`. Used
 * by the registry merge layer and by `hewtd domain add` (which validates
 * strictly before writing). Collision with a built-in id is NOT checked here —
 * that requires knowing the built-in set, so it is enforced in the registry
 * merge (drop-with-warning) and in the CLI writer (hard error).
 */
export const custom_domain_schema = z.object({
  id: z.string().regex(KEBAB_SLUG_RE, 'domain id must be kebab-case'),
  name: z.string().min(1),
  description: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1, 'at least one keyword is required'),
  loadPriority: z.number().int().min(1).max(10),
  category: z.enum(DOMAIN_CATEGORY_VALUES),
});

export type CustomDomainConfig = z.infer<typeof custom_domain_schema>;

/**
 * Lenient `domains[]` parser: drops malformed entries instead of failing the
 * whole config load. This preserves `loadPluginConfig`'s never-throw contract —
 * a hand-edited config with one bad domain entry still loads the rest (and the
 * valid vault block). The CLI `domain add` command does the strict, user-facing
 * validation; this is the last-line filter for the runtime.
 */
const lenient_domains_array = z
  .preprocess((value) => {
    if (!Array.isArray(value)) return [];
    return value.filter((entry) => custom_domain_schema.safeParse(entry).success);
  }, z.array(custom_domain_schema))
  .default([]);

/**
 * Schema for `.claude/hit-em-with-the-docs.json`. Every field is optional
 * with a sensible default. The runtime's `updatePolicy` is preserved via
 * `.passthrough()`.
 */
const vault_config_schema = z
  .object({
    root: z.string().default(DEFAULT_VAULT_ROOT),
    playbook_paths: z.array(z.string()).default(DEFAULT_PLAYBOOK_GLOBS),
    audit_window_days: z.number().int().positive().default(DEFAULT_AUDIT_WINDOW_DAYS),
  })
  .default({});

export const DEFAULT_ARCHIVE_CANDIDATE_DAYS = 365;

/**
 * Archival policy. Governs candidate DETECTION and archival aggressiveness.
 * The safe default is propose-don't-impose: nothing is ever auto-archived
 * (`auto: false`), age alone never qualifies a doc (`require_orphaned: true`),
 * and the recency threshold is generous (docs churn slower than code).
 */
const archive_config_schema = z
  .object({
    honor_status_deprecated: z.boolean().default(true),
    candidate_after_days: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_ARCHIVE_CANDIDATE_DAYS),
    require_orphaned: z.boolean().default(true),
    auto: z.boolean().default(false),
  })
  .default({});

/**
 * Lifecycle enforcement (2.8.0). Governs the PreToolUse guard, which is what
 * makes the policy binding on an agent rather than merely documented. Both
 * rules default ON — but they are opt-out, because a guard nobody can disable
 * is a guard people uninstall the plugin to escape.
 */
const enforcement_config_schema = z
  .object({
    block_index_edits: z.boolean().default(true),
    block_doc_deletion: z.boolean().default(true),
  })
  .default({});

/**
 * A project-declared `status` value. Lowercase word characters plus `-`/`_`,
 * matching the shape of the built-ins (`draft`) and of the vocabularies
 * projects actually adopt (`complete`, `current`, `in_progress`).
 */
const STATUS_VALUE_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export const status_value_schema = z
  .string()
  .regex(STATUS_VALUE_RE, 'status value must be lowercase, - or _ separated');

/**
 * Extra `status` values this project recognizes, ADDED to hewtd's four
 * built-ins — never replacing them. The built-ins are not a style preference:
 * `archive` writes `status: archived`, `unarchive` writes `status: active`,
 * the deprecation nudge keys on `status: deprecated`, and every generated
 * INDEX/REGISTRY is emitted with `status: active`. A project that could drop
 * them would invalidate hewtd's own output with its own config.
 *
 * Lenient like `domains[]`: malformed entries are dropped rather than failing
 * the whole config load, preserving `loadPluginConfig`'s never-throw contract.
 */
const lenient_status_array = z
  .preprocess((value) => {
    if (!Array.isArray(value)) return [];
    return value.filter((entry) => status_value_schema.safeParse(entry).success);
  }, z.array(status_value_schema))
  .default([]);

const DEFAULT_GENERIC_TITLES = [
  'Admin', 'Reference', 'Guide', 'Overview', 'Notes', 'README', 'Index', 'Introduction',
];

/**
 * Retrieval-readiness audit thresholds (#50). Every key falls back to its
 * default on an invalid value (`.catch`) so a hand-edited config never throws.
 * `disabled` lists RETRIEVAL_* codes to silence.
 */
const retrieval_config_schema = z
  .object({
    purpose_min_words: z.number().int().positive().catch(8),
    generic_titles: z.array(z.string()).catch(DEFAULT_GENERIC_TITLES),
    oversized_chars: z.number().int().positive().catch(15000),
    oversized_headings: z.number().int().positive().catch(12),
    near_duplicate: z.boolean().catch(true),
    near_duplicate_min_chars: z.number().int().positive().catch(300),
    disabled: z.array(z.string()).catch([]),
  })
  .catch({
    purpose_min_words: 8,
    generic_titles: DEFAULT_GENERIC_TITLES,
    oversized_chars: 15000,
    oversized_headings: 12,
    near_duplicate: true,
    near_duplicate_min_chars: 300,
    disabled: [],
  })
  .default({});

/**
 * Overview-doc cluster thresholds (#51). Lenient like `retrieval`: any invalid
 * key falls back to its default. `disabled` lists OVERVIEW_* codes to silence.
 */
const overview_config_schema = z
  .object({
    min_cluster_size: z.number().int().positive().catch(5),
    min_link_coverage: z.number().gt(0).lte(1).catch(0.6),
    backlinks: z.boolean().catch(true),
    disabled: z.array(z.string()).catch([]),
  })
  .catch({ min_cluster_size: 5, min_link_coverage: 0.6, backlinks: true, disabled: [] })
  .default({});

export const DEFAULT_RECONCILE_KEEP_IN_PLACE = [
  'README.md', 'SECURITY.md', 'LICENSE.md', 'CONTRIBUTING.md', 'CHANGELOG.md', '.github/**', '.claude/**',
];
/** Empty on purpose: a guessed schema flagged 34 live tables `missing` (#58). Set `schema_sources` to opt in. */
export const DEFAULT_RECONCILE_SCHEMA_SOURCES: string[] = [];

/** Sibling checkouts reconcile may read (never write) to resolve references and cross-links (#58). */
const related_repo_schema = z.object({ name: z.string().regex(/^[\w.-]+$/), path: z.string().min(1) });
const lenient_related_repos = z
  .array(z.unknown())
  .transform((a) => a.flatMap((item) => { const result = related_repo_schema.safeParse(item); return result.success ? [result.data] : []; }))
  .catch([]);

/** Secret scan (#59). An allow entry needs a `reason` and a `fingerprint` or `pattern`; others are dropped with a warning. */
export interface SecretAllow { fingerprint?: string | undefined; pattern?: string | undefined; file?: string | undefined; reason: string }
const lenient_secret_allow = z
  .array(z.unknown())
  .transform((a) => a.flatMap((item): SecretAllow[] => {
    const entry = item as Partial<SecretAllow> | null;
    const ok = !!entry && typeof entry === 'object' && typeof entry.reason === 'string' && entry.reason.trim() &&
      (typeof entry.fingerprint === 'string' || typeof entry.pattern === 'string') &&
      (entry.file === undefined || typeof entry.file === 'string');
    if (!ok) { console.warn('hewtd: ignoring reconcile.secrets.allow entry without a reason and a fingerprint or pattern'); return []; }
    return [{ fingerprint: entry.fingerprint, pattern: entry.pattern, file: entry.file, reason: entry.reason!.trim() }];
  }))
  .catch([]);
const secrets_config_schema = z
  .object({
    allow: lenient_secret_allow,
    disabled_rules: z.array(z.string()).catch([]),
  })
  .catch({ allow: [] as SecretAllow[], disabled_rules: [] as string[] })
  .default({});

/** Reconcile (#54). Lenient like `retrieval`: any invalid key falls back to its default. */
const reconcile_config_schema = z
  .object({
    keep_in_place: z.array(z.string()).catch(DEFAULT_RECONCILE_KEEP_IN_PLACE),
    ledger_path: z.string().min(1).catch('.hewtd/reconcile.json'),
    schema_sources: z.array(z.string()).catch(DEFAULT_RECONCILE_SCHEMA_SOURCES),
    related_repos: lenient_related_repos,
    secrets: secrets_config_schema,
    /** Optional doc search hook (#59): argv template with a `{query}` placeholder; stdout lines are doc paths. */
    search_command: z.string().min(1).optional().catch(undefined),
    /** `reconcile --gaps` (#66): cap on user_phrase entries per doc, existing ones included. */
    gaps: z
      .object({ max_phrases_per_doc: z.number().int().positive().catch(5) })
      .catch({ max_phrases_per_doc: 5 })
      .default({}),
    team: z
      .object({
        min_docs: z.number().int().positive().catch(12),
        min_bytes: z.number().int().positive().catch(250000),
        max_agents: z.number().int().positive().catch(4),
        docs_per_agent: z.number().int().positive().catch(8),
      })
      .catch({ min_docs: 12, min_bytes: 250000, max_agents: 4, docs_per_agent: 8 })
      .default({}),
  })
  .catch({
    keep_in_place: DEFAULT_RECONCILE_KEEP_IN_PLACE,
    ledger_path: '.hewtd/reconcile.json',
    schema_sources: DEFAULT_RECONCILE_SCHEMA_SOURCES,
    related_repos: [] as Array<{ name: string; path: string }>,
    secrets: { allow: [] as SecretAllow[], disabled_rules: [] as string[] },
    gaps: { max_phrases_per_doc: 5 },
    team: { min_docs: 12, min_bytes: 250000, max_agents: 4, docs_per_agent: 8 },
  })
  .default({});

/** Integrate (#61). Lenient: an invalid cap falls back to 10; 0 turns `sources` recording off. */
const integrate_config_schema = z
  .object({ sources_max: z.number().int().nonnegative().catch(10) })
  .catch({ sources_max: 10 })
  .default({});

const plugin_config_schema = z
  .object({
    /**
     * Where this project's documentation lives — the single source of truth for
     * a question the CLI previously only ever answered per-invocation, via
     * `--path`. Commands that WRITE consult it to confirm they were aimed at the
     * documentation tree and not at a source tree (#25).
     */
    docs_root: z.string().min(1).default(DEFAULT_DOCS_ROOT),
    vault: vault_config_schema,
    enforcement: enforcement_config_schema,
    domains: lenient_domains_array,
    status: lenient_status_array,
    archive: archive_config_schema,
    retrieval: retrieval_config_schema,
    overview: overview_config_schema,
    reconcile: reconcile_config_schema,
    integrate: integrate_config_schema,
    /** Write `.hewtd/graph.json` on `hewtd index` and after `reconcile --apply` (#65). */
    graph_export: z.boolean().catch(true).default(true),
    /** Reports directory, relative to the repo root. Unset = `<docs root>/reports`. */
    reports_dir: z.string().min(1).optional().catch(undefined),
  })
  .passthrough();

export type VaultConfig = z.infer<typeof vault_config_schema>;
export type EnforcementConfig = z.infer<typeof enforcement_config_schema>;
export type ArchiveConfig = z.infer<typeof archive_config_schema>;
export type RetrievalConfig = z.infer<typeof retrieval_config_schema>;
export type OverviewConfig = z.infer<typeof overview_config_schema>;
export type SecretsConfig = z.infer<typeof secrets_config_schema>;
export type ReconcileConfig = z.infer<typeof reconcile_config_schema>;
export type PluginConfig = z.infer<typeof plugin_config_schema>;

const CONFIG_FILENAME = '.claude/hit-em-with-the-docs.json';

/**
 * Load the plugin config for a project, applying defaults. Never throws —
 * missing file, malformed JSON, and invalid shapes all fall through to
 * defaults. Pass `projectRoot` (defaults to `process.cwd()`) to control
 * which directory to read from.
 */
export async function load_plugin_config(project_root?: string): Promise<PluginConfig> {
  const repo_root = project_root ?? process.cwd();
  const config_path = resolve(repo_root, CONFIG_FILENAME);

  let raw_text: unknown;
  try {
    const contents = await readFile(config_path, 'utf-8');
    raw_text = JSON.parse(contents);
  } catch {
    raw_text = {};
  }

  const parsed = plugin_config_schema.safeParse(raw_text);
  const config = parsed.success ? parsed.data : plugin_config_schema.parse({}); // malformed: defaults, not a crash
  // The committed secrets baseline joins the allowlist, so every secret check honours it (#61).
  const { load_baseline, build_baseline_allow: baseline_allow } = await import('../core/reconcile/secrets.js');
  config.reconcile.secrets.allow = [...config.reconcile.secrets.allow, ...baseline_allow(await load_baseline(repo_root))];
  return config;
}

/**
 * Synchronous variant — used in test setup where async loading is awkward.
 * Same fail-open behavior.
 */
export function load_plugin_config_sync(project_root?: string): PluginConfig {
  const repo_root = project_root ?? process.cwd();
  const config_path = resolve(repo_root, CONFIG_FILENAME);

  let raw_text: unknown;
  try {
    const contents = readFileSync(config_path, 'utf-8');
    raw_text = JSON.parse(contents);
  } catch {
    raw_text = {};
  }

  const parsed = plugin_config_schema.safeParse(raw_text);
  if (parsed.success) {
    return parsed.data;
  }
  return plugin_config_schema.parse({});
}

/**
 * Read the RAW config object (unparsed, no defaults applied) for a project.
 * Returns `{}` when the file is missing or unreadable/malformed. Use this when
 * you need to MUTATE the config and write it back without clobbering keys this
 * module doesn't model (e.g. the runtime's `updatePolicy`). Never throws.
 */
export async function load_raw_config(
  project_root?: string
): Promise<Record<string, unknown>> {
  const repo_root = project_root ?? process.cwd();
  const config_path = resolve(repo_root, CONFIG_FILENAME);
  try {
    const contents = await readFile(config_path, 'utf-8');
    const parsed = JSON.parse(contents);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Write the RAW config object back to `.claude/hit-em-with-the-docs.json`,
 * creating the `.claude/` directory if needed. Pretty-printed with a trailing
 * newline. Returns the absolute path written.
 */
export async function write_raw_config(
  project_root: string,
  data: Record<string, unknown>
): Promise<string> {
  const config_path = resolve(project_root, CONFIG_FILENAME);
  await mkdir(dirname(config_path), { recursive: true });
  await writeFile(config_path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  return config_path;
}

/** Absolute path to a project's config file (whether or not it exists). */
export function resolve_config_file_path(project_root: string): string {
  return resolve(project_root, CONFIG_FILENAME);
}

/**
 * Resolve the documentation root for a project, applying config + defaults.
 * The returned path is absolute.
 */
export function resolve_docs_root(project_root: string, config: PluginConfig): string {
  return resolve(project_root, config.docs_root);
}

/**
 * Resolve the vault root for a project, applying config + defaults.
 * The returned path is absolute.
 */
export function resolve_vault_root(project_root: string, config: PluginConfig): string {
  return resolve(project_root, config.vault.root);
}

/**
 * Resolve playbook scan globs relative to project root, as absolute glob
 * patterns. Returned globs are suitable for `glob` library consumption.
 */
export function resolve_playbook_globs(
  project_root: string,
  config: PluginConfig
): string[] {
  return config.vault.playbook_paths.map((playbook_path) => join(project_root, playbook_path));
}

/**
 * Where reports are written. Default `<docsPath>/reports`; `reports_dir`
 * (relative to the repo root, the parent of docsPath) overrides it. A path
 * that escapes the repo root warns and falls back to the default.
 */
export async function resolve_reports_dir(docs_path: string): Promise<string> {
  const project_root = dirname(docs_path);
  const configured = (await load_plugin_config(project_root)).reports_dir;
  if (!configured) return join(docs_path, 'reports');
  const dir_path = resolve(project_root, configured);
  const repo_path = relative(project_root, dir_path);
  if (repo_path === '..' || repo_path.startsWith(`..${sep}`) || isAbsolute(repo_path)) {
    // Lenient like the rest of the config: bad value → default, never a crash.
    console.warn(`hewtd: reports_dir "${configured}" must stay inside the repo root; using ${join(docs_path, 'reports')}`);
    return join(docs_path, 'reports');
  }
  return dir_path;
}
