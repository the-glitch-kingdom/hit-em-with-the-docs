/**
 * Cold-root allowlists for secret scanners (#101). A committed cold generation re-adds the old docs tree under a new path,
 * so every baselined finding comes back as new in a PR scan. These are pure text edits: each returns the new file text,
 * or null when nothing should change (already allowlisted, unreadable, unknown format).
 */

/** Anchored regex for everything under the cold root (gitleaks `paths`, detect-secrets `should_exclude_file`). */
export const get_cold_regex = (cold_prefix: string): string => `^${cold_prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`;

/** JSON text in the style of `original` (indent kept, one line stays one line, trailing newline as it was). */
export function serialize_like(original: string | null, data: unknown): string {
  if (original === null) return JSON.stringify(data, null, 2) + '\n';
  const indent = /^[ \t]+(?=")/m.exec(original)?.[0];
  return JSON.stringify(data, null, indent) + (original.endsWith('\n') ? '\n' : '');
}

/**
 * `.gitleaks.toml`: a new file extends the default rules (a config without `[extend] useDefault = true` REPLACES them);
 * an existing one gets the path in its `[allowlist] paths`, a new `[allowlist]`, or a `[[allowlists]]` block when it uses that form.
 */
export function add_gitleaks_allowlist(before: string | null, cold_regex: string): string | null {
  const entry = `'''${cold_regex}'''`;
  if (before === null) return `[extend]\nuseDefault = true\n\n[allowlist]\npaths = [${entry}]\n`;
  if (before.includes(entry)) return null;
  const header = /^\[allowlist\][ \t]*(?:#.*)?$/m.exec(before);
  if (header) {
    const start = header.index + header[0].length;
    const next = /^\[/m.exec(before.slice(start));
    const section = before.slice(start, next ? start + next.index : before.length);
    const paths = /^[ \t]*paths[ \t]*=[ \t]*\[/m.exec(section);
    if (paths) { const at = start + paths.index + paths[0].length; return `${before.slice(0, at)}${entry}, ${before.slice(at)}`; }
    return `${before.slice(0, start)}\npaths = [${entry}]${before.slice(start)}`;
  }
  const table = /^\[\[allowlists\]\]/m.test(before) ? '[[allowlists]]' : '[allowlist]';
  return `${before}${before.endsWith('\n') ? '' : '\n'}\n${table}\npaths = [${entry}]\n`;
}

/** `.secrets.baseline` (detect-secrets): the `should_exclude_file` filter's patterns (1.x), or `exclude.files` (0.13). */
export function add_baseline_exclude(before: string, cold_regex: string): string | null {
  let data: Record<string, unknown>;
  try { data = JSON.parse(before); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const filters = data.filters_used;
  const exclude = data.exclude as { files?: unknown } | undefined;
  if (Array.isArray(filters)) {
    const filter = filters.find((item) => typeof item?.path === 'string' && item.path.endsWith('.should_exclude_file'));
    if (!filter) filters.push({ path: 'detect_secrets.filters.regex.should_exclude_file', pattern: [cold_regex] });
    else {
      const patterns: unknown[] = Array.isArray(filter.pattern) ? filter.pattern : filter.pattern ? [filter.pattern] : [];
      if (patterns.includes(cold_regex)) return null;
      filter.pattern = [...patterns, cold_regex];
    }
  } else if (exclude && typeof exclude === 'object') {
    if (typeof exclude.files === 'string' && exclude.files.split('|').includes(cold_regex)) return null;
    exclude.files = typeof exclude.files === 'string' && exclude.files ? `${exclude.files}|${cold_regex}` : cold_regex;
  } else return null;
  return serialize_like(before, data);
}
