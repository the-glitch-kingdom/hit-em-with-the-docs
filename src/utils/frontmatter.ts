import matter from 'gray-matter';
import yaml, { Scalar, isMap, isScalar } from 'yaml';

/**
 * A `YYYY-MM-DD` value, optionally carrying a time part.
 *
 * Under YAML 1.1 — js-yaml's default schema, which is what gray-matter reads
 * with out of the box — an unquoted value of this shape is a **timestamp**, and
 * parses to a `Date`. Under the YAML 1.2 core schema it is a plain string.
 * Frontmatter dates therefore have to be handled deliberately in both
 * directions; see `FRONTMATTER_ENGINES` and `stringifyFrontmatter`.
 */
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Read frontmatter with the SAME YAML implementation used to write it.
 *
 * gray-matter defaults to js-yaml's default schema, which includes the YAML 1.1
 * timestamp type; `stringifyFrontmatter` writes with the `yaml` package, whose
 * core schema does not. The two disagreed, so frontmatter did not round-trip:
 * a quoted `last_updated: '2026-08-22'` was read as a string, written back
 * unquoted, and then re-read as a `Date` — which the schema rejects, because it
 * requires a string. `maintain --fix` therefore turned a passing docset into a
 * failing one, deterministically, on every file it touched (#28).
 *
 * Parsing with the `yaml` package makes the two ends the same implementation,
 * so a `Date` can no longer materialize out of frontmatter at all — and an
 * already-damaged file, carrying a bare date, now reads back as the string it
 * was meant to be.
 */
const FRONTMATTER_ENGINES = {
  yaml: {
    parse: (str: string): object => yaml.parse(str) as object,
    stringify: (data: object): string => stringify_frontmatter(data as Record<string, unknown>),
  },
};

export interface FrontmatterResult<T = Record<string, unknown>> {
  data: T;
  content: string;
  isEmpty: boolean;
  excerpt?: string;
}

/**
 * Parse frontmatter from markdown content
 */
export function parse_frontmatter<T = Record<string, unknown>>(
  content: string
): FrontmatterResult<T> {
  const result = matter(content, { engines: FRONTMATTER_ENGINES });
  const parsed: FrontmatterResult<T> = {
    data: result.data as T,
    content: result.content,
    isEmpty: Object.keys(result.data).length === 0,
  };
  if (result.excerpt) {
    parsed.excerpt = result.excerpt;
  }
  return parsed;
}

/**
 * Check if content has frontmatter
 */
export function has_frontmatter(content: string): boolean {
  return content.trimStart().startsWith('---');
}

/**
 * Extract frontmatter string from content
 */
export function extract_frontmatter_string(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] ?? null : null;
}

/**
 * Whether the first top-level block sequence in `text` is indented (`key:\n  - x`).
 * Undefined when there is none to judge by. `text` is a whole file or just its frontmatter.
 */
function detect_indent_seq(text: string | undefined): boolean | undefined {
  const m = text?.match(/^[\w-]+:[ \t]*\r?\n([ \t]*)- /m);
  return m ? m[1]!.length > 0 : undefined;
}

/**
 * Stringify frontmatter data to YAML. Pass the file's original text (full file or
 * frontmatter only) to keep its list style; without it, lists are indented.
 */
export function stringify_frontmatter(data: Record<string, unknown>, original?: string): string {
  // Use yaml library for better formatting control
  return yaml.stringify(quote_date_like(data), {
    indent: 2,
    indentSeq: detect_indent_seq(original) ?? true,
    lineWidth: 80,
    singleQuote: true,
  });
}

/**
 * Force quotes around date-shaped strings, at any depth.
 *
 * Reading is now internally consistent (see `FRONTMATTER_ENGINES`), so hewtd
 * alone would round-trip a bare date correctly. But frontmatter is a shared
 * contract: editors, CI, and sister tooling read the same files, and most YAML
 * readers still default to YAML 1.1, where a bare `2026-08-22` is a timestamp.
 * Emitting it unquoted hands every other consumer the bug this fixes.
 *
 * Returns a copy — the caller's object is never mutated.
 */
function quote_date_like(value: unknown): unknown {
  if (typeof value === 'string' && DATE_LIKE.test(value)) {
    const scalar = new Scalar(value);
    scalar.type = Scalar.QUOTE_SINGLE;
    return scalar;
  }

  if (Array.isArray(value)) return value.map(quote_date_like);

  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, quote_date_like(v)])
    );
  }

  return value;
}

/**
 * Add or update frontmatter in content. List style follows `original`, which
 * defaults to `content`; pass the raw file when `content` is already the bare body.
 */
export function set_frontmatter(
  content: string,
  data: Record<string, unknown>,
  original: string = content
): string {
  const { content: body } = parse_frontmatter(content);
  const frontmatter = stringify_frontmatter(data, original);
  return `---\n${frontmatter}---\n\n${body.trimStart()}`;
}

/**
 * Change only the given top-level keys: each one's source range (key start to value end) is replaced
 * by the key re-rendered, new keys are appended, every other byte of the file stays. Falls back to
 * `setFrontmatter` when the frontmatter is not one YAML map, so a file is never corrupted.
 */
export function set_frontmatter_keys(raw: string, changes: Record<string, unknown>): string {
  const fallback = (): string => set_frontmatter(raw, { ...parse_frontmatter(raw).data, ...changes }, raw);
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return fallback();
  const fm = m[1]!;
  const start = raw.indexOf('\n') + 1;
  const doc = yaml.parseDocument(fm);
  if (doc.errors.length || !isMap(doc.contents)) return fallback();
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const render = (k: string): string => stringify_frontmatter({ [k]: changes[k] }, raw).replace(/\n$/, '').replace(/\n/g, eol);
  const edits: Array<[number, number, string]> = [];
  let appended = '';
  for (const k of Object.keys(changes)) {
    const pair = doc.contents.items.find((p) => isScalar(p.key) && p.key.value === k);
    if (!pair) { appended += eol + render(k); continue; }
    const kr = (pair.key as Scalar).range!;
    // A key with no value (`k:`) has no value range; end after its colon.
    const end = pair.value && (pair.value as Scalar).range ? (pair.value as Scalar).range![1] : fm.indexOf(':', kr[1]) + 1;
    // A block value's range includes its trailing line break, which belongs to the next line.
    edits.push([kr[0], fm.slice(0, end).trimEnd().length, render(k)]);
  }
  let out = fm;
  for (const [a, b, text] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + text + out.slice(b);
  return raw.slice(0, start) + out + appended + raw.slice(start + fm.length);
}

/**
 * Merge frontmatter data with existing
 */
export function merge_frontmatter(
  content: string,
  new_data: Record<string, unknown>
): string {
  const { data: existing_data, content: body } = parse_frontmatter(content);
  const merged_data = { ...existing_data, ...new_data };
  const frontmatter = stringify_frontmatter(merged_data, content);
  return `---\n${frontmatter}---\n\n${body.trimStart()}`;
}

/**
 * Remove frontmatter from content
 */
export function remove_frontmatter(content: string): string {
  const { content: body } = parse_frontmatter(content);
  return body.trimStart();
}

/**
 * Get specific frontmatter field
 */
export function get_frontmatter_field<T>(
  content: string,
  field: string
): T | undefined {
  const { data } = parse_frontmatter(content);
  return data[field] as T | undefined;
}

/**
 * Set specific frontmatter field
 */
export function set_frontmatter_field(
  content: string,
  field: string,
  value: unknown
): string {
  const { data, content: body } = parse_frontmatter(content);
  data[field] = value;
  const frontmatter = stringify_frontmatter(data, content);
  return `---\n${frontmatter}---\n\n${body.trimStart()}`;
}

/**
 * Validate frontmatter structure
 */
export function validate_frontmatter(
  content: string,
  required_fields: string[]
): { valid: boolean; missingFields: string[] } {
  const { data } = parse_frontmatter(content);
  const missing_fields = required_fields.filter(
    (field) => !(field in data) || data[field] === undefined || data[field] === null
  );
  return {
    valid: missing_fields.length === 0,
    missingFields: missing_fields,
  };
}
