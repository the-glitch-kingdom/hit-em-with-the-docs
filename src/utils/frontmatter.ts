import matter from 'gray-matter';
import yaml, { Scalar } from 'yaml';

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
    stringify: (data: object): string => stringifyFrontmatter(data as Record<string, unknown>),
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
export function parseFrontmatter<T = Record<string, unknown>>(
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
export function hasFrontmatter(content: string): boolean {
  return content.trimStart().startsWith('---');
}

/**
 * Extract frontmatter string from content
 */
export function extractFrontmatterString(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] ?? null : null;
}

/**
 * Whether the first top-level block sequence in `text` is indented (`key:\n  - x`).
 * Undefined when there is none to judge by. `text` is a whole file or just its frontmatter.
 */
function detectIndentSeq(text: string | undefined): boolean | undefined {
  const m = text?.match(/^[\w-]+:[ \t]*\r?\n([ \t]*)- /m);
  return m ? m[1]!.length > 0 : undefined;
}

/**
 * Stringify frontmatter data to YAML. Pass the file's original text (full file or
 * frontmatter only) to keep its list style; without it, lists are indented.
 */
export function stringifyFrontmatter(data: Record<string, unknown>, original?: string): string {
  // Use yaml library for better formatting control
  return yaml.stringify(quoteDateLike(data), {
    indent: 2,
    indentSeq: detectIndentSeq(original) ?? true,
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
function quoteDateLike(value: unknown): unknown {
  if (typeof value === 'string' && DATE_LIKE.test(value)) {
    const scalar = new Scalar(value);
    scalar.type = Scalar.QUOTE_SINGLE;
    return scalar;
  }

  if (Array.isArray(value)) return value.map(quoteDateLike);

  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, quoteDateLike(v)])
    );
  }

  return value;
}

/**
 * Add or update frontmatter in content. List style follows `original`, which
 * defaults to `content`; pass the raw file when `content` is already the bare body.
 */
export function setFrontmatter(
  content: string,
  data: Record<string, unknown>,
  original: string = content
): string {
  const { content: body } = parseFrontmatter(content);
  const frontmatter = stringifyFrontmatter(data, original);
  return `---\n${frontmatter}---\n\n${body.trimStart()}`;
}

/**
 * Merge frontmatter data with existing
 */
export function mergeFrontmatter(
  content: string,
  newData: Record<string, unknown>
): string {
  const { data: existingData, content: body } = parseFrontmatter(content);
  const mergedData = { ...existingData, ...newData };
  const frontmatter = stringifyFrontmatter(mergedData, content);
  return `---\n${frontmatter}---\n\n${body.trimStart()}`;
}

/**
 * Remove frontmatter from content
 */
export function removeFrontmatter(content: string): string {
  const { content: body } = parseFrontmatter(content);
  return body.trimStart();
}

/**
 * Get specific frontmatter field
 */
export function getFrontmatterField<T>(
  content: string,
  field: string
): T | undefined {
  const { data } = parseFrontmatter(content);
  return data[field] as T | undefined;
}

/**
 * Set specific frontmatter field
 */
export function setFrontmatterField(
  content: string,
  field: string,
  value: unknown
): string {
  const { data, content: body } = parseFrontmatter(content);
  data[field] = value;
  const frontmatter = stringifyFrontmatter(data, content);
  return `---\n${frontmatter}---\n\n${body.trimStart()}`;
}

/**
 * Validate frontmatter structure
 */
export function validateFrontmatter(
  content: string,
  requiredFields: string[]
): { valid: boolean; missingFields: string[] } {
  const { data } = parseFrontmatter(content);
  const missingFields = requiredFields.filter(
    (field) => !(field in data) || data[field] === undefined || data[field] === null
  );
  return {
    valid: missingFields.length === 0,
    missingFields,
  };
}
