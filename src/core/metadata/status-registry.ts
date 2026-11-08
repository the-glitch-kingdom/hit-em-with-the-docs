/**
 * Runtime status-vocabulary registry.
 *
 * The `status` frontmatter field used to be validated against a hardcoded
 * four-value enum. As of the configurable-status feature it is resolved at
 * runtime: hewtd's four built-ins merged with any extra values declared in
 * `.claude/hit-em-with-the-docs.json` (`status: [...]`).
 *
 * Deliberately ADDITIVE — config extends the vocabulary, it cannot replace it.
 * The built-ins are load-bearing, not stylistic: `archive` writes
 * `status: archived`, `unarchive` writes `status: active`, the deprecation
 * nudge keys on `status: deprecated`, and every generated INDEX/REGISTRY is
 * emitted with `status: active`. A replace-mode config would let a project
 * invalidate hewtd's own output with its own settings.
 *
 * Mirrors `core/domains/registry.ts`: a cached singleton, because the CLI is a
 * short-lived per-invocation process, so reading config once keeps the
 * consumer surface synchronous. Tests must call `resetStatusRegistry()`
 * between cases that change config.
 */

import { load_plugin_config_sync } from '../../utils/config.js';

/**
 * The four statuses hewtd itself reads and writes. Always valid, in every
 * project, regardless of config.
 */
export const DOC_STATUS_VALUES = ['draft', 'active', 'deprecated', 'archived'] as const;

export type BuiltinDocStatus = (typeof DOC_STATUS_VALUES)[number];

/** A status value: a built-in, or any project-declared extra. */
// `string & {}` keeps built-in autocomplete while accepting project values.
// eslint-disable-next-line @typescript-eslint/ban-types
export type DocStatus = BuiltinDocStatus | (string & {});

let cached: string[] | null = null;

/**
 * Build the active vocabulary from disk config (no caching). Built-ins first
 * in declared order, then config extras in config order, de-duplicated.
 */
export function build_status_vocabulary(project_root?: string): string[] {
  const config = load_plugin_config_sync(project_root);
  const seen = new Set<string>(DOC_STATUS_VALUES);
  const values: string[] = [...DOC_STATUS_VALUES];

  for (const extra of config.status ?? []) {
    if (seen.has(extra)) continue;
    seen.add(extra);
    values.push(extra);
  }

  return values;
}

/**
 * The cached active vocabulary. Built lazily on first access from the config
 * at `process.cwd()` (or `projectRoot` if passed on the first call).
 */
export function get_status_values(project_root?: string): string[] {
  if (!cached) {
    cached = build_status_vocabulary(project_root);
  }
  return [...cached];
}

/** Clear the cached vocabulary. Call this in test setup after mutating config. */
export function reset_status_registry(): void {
  cached = null;
}

/** True if `value` is a recognized status (built-in OR project-declared). */
export function is_valid_status(value: string): value is DocStatus {
  if (!cached) {
    cached = build_status_vocabulary();
  }
  return cached.includes(value);
}
