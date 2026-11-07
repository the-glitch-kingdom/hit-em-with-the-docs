/** Heading anchors (GitHub-style slugs, `{#id}`, `<a id>`) for #59 anchor validation. */

/** Advisory link warning; carries no error `code`, so exit codes and --strict ignore it (like RETRIEVAL_*). */
export const LINK_BROKEN_ANCHOR = 'LINK_BROKEN_ANCHOR';

interface Heading {
  level: number;
  line: number;
  ids: string[];
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // link text only
    .replace(/[`*~]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

function scan(markdown: string): { headings: Heading[]; lines: string[]; extra: string[] } {
  const lines = markdown.split('\n');
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
    const h = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!h) return;
    let text = h[2]!;
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
    headings.push({ level: h[1]!.length, line: i, ids });
  });
  return { headings, lines, extra };
}

export function headingAnchors(markdown: string): Set<string> {
  const { headings, extra } = scan(markdown);
  return new Set([...headings.flatMap((h) => h.ids), ...extra]);
}

/** The heading line through the next heading of the same or higher level; null if no heading has the anchor. */
export function sectionOf(markdown: string, anchor: string): string | null {
  const { headings, lines } = scan(markdown);
  const idx = headings.findIndex((h) => h.ids.includes(anchor));
  if (idx < 0) return null;
  const start = headings[idx]!;
  const next = headings.slice(idx + 1).find((h) => h.level <= start.level);
  return lines.slice(start.line, next ? next.line : lines.length).join('\n');
}

/** Flat sections (heading line to the next heading of any level), for duplicate detection. Body excludes the heading line. */
export function flatSections(markdown: string): { anchor: string; heading: string; text: string }[] {
  const { headings, lines } = scan(markdown);
  return headings.map((h, i) => ({
    anchor: h.ids[0]!,
    heading: lines[h.line]!.replace(/^\s*#+\s*|\s*#*\s*$/g, ''),
    text: lines.slice(h.line + 1, headings[i + 1]?.line ?? lines.length).join('\n'),
  }));
}
