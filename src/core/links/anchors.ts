/** Heading anchors (GitHub-style slugs, `{#id}`, `<a id>`) for #59 anchor validation. */

/** Advisory link warning; carries no error `code`, so exit codes and --strict ignore it (like RETRIEVAL_*). */
export const LINK_BROKEN_ANCHOR = 'LINK_BROKEN_ANCHOR';

interface Heading {
  level: number;
  line: number;
  ids: string[];
  /** setext headings span two lines (text + underline) */
  span: number;
}

function format_slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // link text only
    .replace(/[`*~]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '') // GitHub keeps combining marks
    .trim()
    .replace(/\s/g, '-');
}

function parse_headings(markdown: string): { headings: Heading[]; lines: string[]; extra: string[] } {
  const lines = markdown.split('\n');
  // Frontmatter is not content: blank it (keeping line numbers) so a YAML `# comment` is no heading.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (end > 0) for (let i = 0; i <= end; i++) lines[i] = '';
  }
  const headings: Heading[] = [];
  const extra: string[] = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;

  lines.forEach((line, i) => {
    const file = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (file) {
      if (!fence) fence = file[1]![0]!;
      else if (file[1]![0] === fence) fence = null;
      return;
    }
    if (fence) return;
    for (const match of line.matchAll(/<a\s[^>]*?\b(?:id|name)=["']([^"']+)["']/gi)) extra.push(match[1]!);
    // ATX headings, also inside blockquotes (`> ## x`); setext headings (text underlined with === / ---).
    const heading = line.match(/^(?: {0,3}>\s?)* {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    const under = lines[i + 1]?.match(/^ {0,3}(=+|-+)\s*$/);
    const setext = !heading && under && line.trim() !== '' && !/^ {0,3}([-*+>|#]|\d+[.)])(\s|$)/.test(line) && (i === 0 || lines[i - 1]!.trim() === '' || /^ {0,3}#/.test(lines[i - 1]!));
    if (!heading && !setext) return;
    const level = heading ? heading[1]!.length : under![1]![0] === '=' ? 1 : 2;
    let text = heading ? heading[2]! : line.trim();
    const ids: string[] = [];
    const custom = text.match(/\s*\{#([^}\s]+)\}\s*$/);
    if (custom) {
      ids.push(custom[1]!);
      text = text.slice(0, custom.index);
    }
    const base = format_slug(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    ids.push(count === 0 ? base : `${base}-${count}`);
    headings.push({ level, line: i, ids, span: heading ? 1 : 2 });
  });
  return { headings, lines, extra };
}

export function extract_heading_anchors(markdown: string): Set<string> {
  const { headings, extra } = parse_headings(markdown);
  return new Set([...headings.flatMap((heading) => heading.ids), ...extra]);
}

/** The heading line through the next heading of the same or higher level; null if no heading has the anchor. */
export function find_section(markdown: string, anchor: string): string | null {
  const { headings, lines } = parse_headings(markdown);
  const index = headings.findIndex((heading) => heading.ids.includes(anchor));
  if (index < 0) return null;
  const start = headings[index]!;
  const next = headings.slice(index + 1).find((heading) => heading.level <= start.level);
  return lines.slice(start.line, next ? next.line : lines.length).join('\n');
}

/** Flat sections (heading line to the next heading of any level), for duplicate detection. Body excludes the heading line. */
export function build_flat_sections(markdown: string): { anchor: string; heading: string; text: string }[] {
  const { headings, lines } = parse_headings(markdown);
  return headings.map((heading, i) => ({
    anchor: heading.ids[0]!,
    heading: lines[heading.line]!.replace(/^(?:\s*>)*\s*#+\s*|\s*#*\s*$/g, ''),
    text: lines.slice(heading.line + heading.span, headings[i + 1]?.line ?? lines.length).join('\n'),
  }));
}
