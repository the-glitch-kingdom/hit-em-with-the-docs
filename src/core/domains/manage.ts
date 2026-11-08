/**
 * Custom-domain management: the deterministic WRITER behind
 * `hewtd domain add|remove|list`.
 *
 * All mutation logic lives here (not in the slash command) so it is unit-
 * testable and reused across the CLI, the GitHub Action, and the library
 * export — none of which have an LLM present. The slash command is a thin
 * interaction wrapper that calls this via the CLI.
 */

import {
  custom_domain_schema,
  load_raw_config,
  write_raw_config,
  resolve_config_file_path,
  DOMAIN_CATEGORY_VALUES,
  type CustomDomainConfig,
} from '../../utils/config.js';
import { is_builtin_domain, type DomainDefinition } from './constants.js';
import { build_registry, reset_registry } from './registry.js';
import { create_scaffold } from '../../generators/scaffold.js';
import { regenerate_indexes, list_domain_doc_files } from '../../generators/regenerate.js';
import { ARCHIVE_DIR } from '../../utils/glob.js';

/**
 * Reserved structural folder names that must never be registered as domains.
 * These are scan-special directories, not part of the active doc corpus.
 */
const RESERVED_DIR_NAMES = ['drafts', 'reports', ARCHIVE_DIR];

export interface DomainListResult {
  builtin: DomainDefinition[];
  custom: DomainDefinition[];
}

/**
 * List the active domain set, partitioned into built-in vs custom. Reads the
 * registry for the given project root (uncached, so it reflects on-disk config
 * even mid-process).
 */
export function list_domains(repo_root: string): DomainListResult {
  const registry = build_registry(repo_root);
  const builtin: DomainDefinition[] = [];
  const custom: DomainDefinition[] = [];
  for (const id of registry.ids) {
    const definition = registry.definitions.get(id)!;
    if (is_builtin_domain(id)) builtin.push(definition);
    else custom.push(definition);
  }
  return { builtin, custom };
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

export interface AddDomainInput {
  repo_root: string;
  /** Documentation root (e.g. absolute path to `.documentation`). */
  docs_root: string;
  spec: {
    id: string;
    name: string;
    description: string;
    keywords: string[];
    loadPriority: number;
    category: string;
  };
  dry_run?: boolean;
}

export interface AddDomainResult {
  ok: boolean;
  /** Validation / collision errors (empty when ok). */
  errors: string[];
  action: 'added' | 'dry_run' | 'rejected';
  spec?: CustomDomainConfig;
  config_path: string;
  domain_folder?: string;
  files_written?: string[];
}

/**
 * Validate and add a custom domain: writes the entry into config and scaffolds
 * its `.documentation/<id>/` folder (+ INDEX/REGISTRY), then refreshes the root
 * indexes so the new domain is listed. Idempotency: refuses an id that is a
 * built-in or already a configured custom domain.
 */
export async function add_domain(input: AddDomainInput): Promise<AddDomainResult> {
  const { repo_root: repo_root, docs_root: docs_root, spec, dry_run = false } = input;
  const config_path = resolve_config_file_path(repo_root);
  const errors: string[] = [];

  // Strict, user-facing validation (the config loader's lenient filter is the
  // last line of defence; this is the first).
  const parsed = custom_domain_schema.safeParse(spec);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    return { ok: false, errors, action: 'rejected', config_path };
  }
  const valid = parsed.data;

  if (is_builtin_domain(valid.id)) {
    errors.push(`"${valid.id}" is a built-in domain; pick a different id.`);
    return { ok: false, errors, action: 'rejected', config_path };
  }

  if (RESERVED_DIR_NAMES.includes(valid.id)) {
    errors.push(
      `"${valid.id}" is a reserved documentation folder (not a domain); pick a different id.`
    );
    return { ok: false, errors, action: 'rejected', config_path };
  }

  const raw_text = await load_raw_config(repo_root);
  const existing = Array.isArray(raw_text.domains)
    ? (raw_text.domains as unknown[])
    : [];
  const already_configured = existing.some(
    (doc) => doc && typeof doc === 'object' && (doc as { id?: unknown }).id === valid.id
  );
  if (already_configured) {
    errors.push(`Custom domain "${valid.id}" already exists in config.`);
    return { ok: false, errors, action: 'rejected', config_path };
  }

  const domain_folder = `${docs_root}/${valid.id}`;

  if (dry_run) {
    return {
      ok: true,
      errors,
      action: 'dry_run',
      spec: valid,
      config_path,
      domain_folder,
    };
  }

  // Persist the config entry, preserving every other key (vault, updatePolicy…).
  raw_text.domains = [...existing, valid];
  await write_raw_config(repo_root, raw_text);

  // Invalidate the cached registry so scaffolding sees the new domain.
  reset_registry();

  // createScaffold creates the (missing) domain folder + initial INDEX/REGISTRY.
  // regenerateIndexes then refreshes the ROOT index so it lists the new domain.
  const scaffold = await create_scaffold({
    root_path: docs_root,
    domains: [valid.id],
    silent: true,
  });
  const regen = await regenerate_indexes({ docs_root: docs_root, silent: true });

  return {
    ok: true,
    errors,
    action: 'added',
    spec: valid,
    config_path,
    domain_folder,
    files_written: [...scaffold.created, ...regen.files_written],
  };
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

export interface RemoveDomainInput {
  repo_root: string;
  docs_root: string;
  id: string;
  dry_run?: boolean;
}

export interface RemoveDomainResult {
  ok: boolean;
  errors: string[];
  action: 'removed' | 'dry_run' | 'rejected';
  config_path: string;
  /** Number of documents left behind in the folder (NOT deleted). */
  orphaned_docs: number;
  domain_folder: string;
}

/**
 * Remove a custom domain from config. NON-DESTRUCTIVE: the
 * `.documentation/<id>/` folder and any docs in it are left on disk — the
 * caller is told how many docs are now orphaned. Refuses to remove a built-in.
 */
export async function remove_domain(
  input: RemoveDomainInput
): Promise<RemoveDomainResult> {
  const { repo_root: repo_root, docs_root: docs_root, id, dry_run = false } = input;
  const config_path = resolve_config_file_path(repo_root);
  const domain_folder = `${docs_root}/${id}`;
  const errors: string[] = [];

  if (is_builtin_domain(id)) {
    errors.push(
      `"${id}" is a built-in domain and cannot be removed (built-ins are part of the compiled contract).`
    );
    return {
      ok: false,
      errors,
      action: 'rejected',
      config_path,
      orphaned_docs: 0,
      domain_folder,
    };
  }

  const raw_text = await load_raw_config(repo_root);
  const existing = Array.isArray(raw_text.domains) ? (raw_text.domains as unknown[]) : [];
  const present = existing.some(
    (doc) => doc && typeof doc === 'object' && (doc as { id?: unknown }).id === id
  );
  if (!present) {
    errors.push(`"${id}" is not a configured custom domain. Nothing to remove.`);
    return {
      ok: false,
      errors,
      action: 'rejected',
      config_path,
      orphaned_docs: 0,
      domain_folder,
    };
  }

  // Count docs that will be orphaned (folder is never deleted).
  const orphaned_docs = (await list_domain_doc_files(docs_root, id)).length;

  if (dry_run) {
    return {
      ok: true,
      errors,
      action: 'dry_run',
      config_path,
      orphaned_docs,
      domain_folder,
    };
  }

  raw_text.domains = existing.filter(
    (doc) => !(doc && typeof doc === 'object' && (doc as { id?: unknown }).id === id)
  );
  await write_raw_config(repo_root, raw_text);
  reset_registry();

  return {
    ok: true,
    errors,
    action: 'removed',
    config_path,
    orphaned_docs,
    domain_folder,
  };
}

/** Re-exported for the CLI's `--category` help text. */
export { DOMAIN_CATEGORY_VALUES };
