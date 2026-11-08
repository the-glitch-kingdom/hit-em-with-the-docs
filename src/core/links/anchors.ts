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

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // link text only
    .replace(/[`*~]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '') // GitHub keeps combining marks
    .trim()
    .replace(/\s/g, '-');
}

function scan(markdown: string): { headings: Heading[]; lines: string[]; extra: string[] } {
  const lines = markdown.split('\n');
  // Frontmatter is not content: blank it (keeping line numbers) so a YAML `# comment` is no heading.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) for (let i = 0; i <= end; i++) lines[i] = '';
  }
  const headings: Heading[] = [];
  const extra: string[] = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;

  lines.forEach((line, i) => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      return;
    }
    if (fence) return;
    for (const m of line.matchAll(/<a\s[^>]*?\b(?:id|name)=["']([^"']+)["']/gi)) extra.push(m[1]!);
    // ATX headings, also inside blockquotes (`> ## x`); setext headings (text underlined with === / ---).
    const h = line.match(/^(?: {0,3}>\s?)* {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    const under = lines[i + 1]?.match(/^ {0,3}(=+|-+)\s*$/);
    const setext = !h && under && line.trim() !== '' && !/^ {0,3}([-*+>|#]|\d+[.)])(\s|$)/.test(line) && (i === 0 || lines[i - 1]!.trim() === '' || /^ {0,3}#/.test(lines[i - 1]!));
    if (!h && !setext) return;
    const level = h ? h[1]!.length : under![1]![0] === '=' ? 1 : 2;
    let text = h ? h[2]! : line.trim();
    const ids: string[] = [];
    const custom = text.match(/\s*\{#([^}\s]+)\}\s*$/);
    if (custom) {
      ids.push(custom[1]!);
      text = text.slice(0, custom.index);
    }
    const base = slugify(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    ids.push(n === 0 ? base : `${base}-${n}`);
    headings.push({ level, line: i, ids, span: h ? 1 : 2 });
  });
  return { headings, lines, extra };
}

export function heading_anchors(markdown: string): Set<string> {
  const { headings, extra } = scan(markdown);
  return new Set([...headings.flatMap((h) => h.ids), ...extra]);
}

/** The heading line through the next heading of the same or higher level; null if no heading has the anchor. */
export function section_of(markdown: string, anchor: string): string | null {
  const { headings, lines } = scan(markdown);
  const idx = headings.findIndex((h) => h.ids.includes(anchor));
  if (idx < 0) return null;
  const start = headings[idx]!;
  const next = headings.slice(idx + 1).find((h) => h.level <= start.level);
  return lines.slice(start.line, next ? next.line : lines.length).join('\n');
}

/** Flat sections (heading line to the next heading of any level), for duplicate detection. Body excludes the heading line. */
export function flat_sections(markdown: string): { anchor: string; heading: string; text: string }[] {
  const { headings, lines } = scan(markdown);
  return headings.map((h, i) => ({
    anchor: h.ids[0]!,
    heading: lines[h.line]!.replace(/^(?:\s*>)*\s*#+\s*|\s*#*\s*$/g, ''),
    text: lines.slice(h.line + h.span, headings[i + 1]?.line ?? lines.length).join('\n'),
  }));
}
