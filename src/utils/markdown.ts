/**
 * Markdown utilities for parsing and generating markdown content
 */

export interface MarkdownLink {
  text: string;
  url: string;
  title?: string;
  is_internal: boolean;
  line_number: number;
  start_index: number;
  end_index: number;
}

export interface MarkdownHeading {
  level: number;
  text: string;
  line_number: number;
}

/**
 * Extract all links from markdown content
 */
/** A tab counts as four columns when measuring block indentation. */
function indent_width(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
}

/** `- item`, `* item`, `+ item`, `1. item`, `2) item`. */
function is_list_item(line: string): boolean {
  return /^\s*(?:[-*+]|\d+[.)])\s+/.test(line);
}

interface Fence {
  marker: '`' | '~';
  length: number;
}

/**
 * A fence opener: three or more backticks or tildes, indented at most three
 * columns. At four it is indented code, not a fence.
 */
function opening_fence(line: string): Fence | null {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  const run = m?.[1];
  if (!run) return null;
  const marker = run[0] as '`' | '~';
  return { marker, length: run.length };
}

/**
 * A fence closes only on the same marker, at least as long as the opener, with
 * nothing after it. `````` inside a ``` block is content, not a close.
 */
function closes_fence(line: string, fence: Fence): boolean {
  return new RegExp(`^ {0,3}\\${fence.marker}{${fence.length},}\\s*$`).test(line);
}

export function extract_links(content: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  const lines = content.split('\n');

  // Match markdown links: [text](url) or [text](url "title")
  const link_regex = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;

  // Link-shaped text inside code is an EXAMPLE, not a link. Reporting it as broken
  // trains people to ignore the broken-link count (#20). Three shapes of code:
  // fenced blocks, inline spans, and indented blocks.
  //
  // Spans are blanked with spaces rather than removed, so `startIndex` and
  // `lineNumber` stay accurate for every real link sharing the line.
  let fence: Fence | null = null;
  let in_indented_code = false;
  let in_list = false;
  let prev_blank = true; // start of document counts as a blank line

  lines.forEach((raw_line, line_index) => {
    if (fence) {
      if (closes_fence(raw_line, fence)) fence = null;
      return; // fence body and its delimiters hold no links
    }

    const opener = opening_fence(raw_line);
    if (opener) {
      fence = opener;
      in_indented_code = false;
      return;
    }

    const blank = raw_line.trim() === '';
    if (blank) {
      prev_blank = true;
      return; // a blank line neither opens nor closes a list
    }

    const indent = indent_width(raw_line);
    const list_item = is_list_item(raw_line);

    // An indented code block needs four columns AND a preceding blank line — it
    // cannot interrupt a paragraph. Once open it runs until a line dedents.
    //
    // The list check is what keeps this from eating real links. Inside a list,
    // four columns is ordinary continuation content — a nested item, or a second
    // paragraph of the parent item — and treating it as code silently drops
    // every link in it. That failure is worse than the one being fixed: #20
    // reported links that were not broken, this would hide links that are.
    if (indent >= 4 && !list_item && !in_list && (prev_blank || in_indented_code)) {
      in_indented_code = true;
      prev_blank = false;
      return;
    }

    if (indent < 4) {
      in_indented_code = false;
      // A flush-left line that is not a list item ends the list block.
      in_list = list_item;
    } else if (list_item) {
      in_list = true;
    }
    prev_blank = false;

    // Blank out inline code spans (`...`, ``...``), preserving offsets.
    const line = raw_line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, (m) => ' '.repeat(m.length));

    link_regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = link_regex.exec(line)) !== null) {
      const [full_match, text, url, title] = match;
      const url_str = url ?? '';
      const is_internal = !url_str.startsWith('http://') &&
                        !url_str.startsWith('https://') &&
                        !url_str.startsWith('mailto:') &&
                        !url_str.startsWith('#');

      const link: MarkdownLink = {
        text: text ?? '',
        url: url_str,
        is_internal,
        line_number: line_index + 1,
        start_index: match.index,
        end_index: match.index + (full_match?.length ?? 0),
      };
      if (title) {
        link.title = title;
      }
      links.push(link);
    }
    link_regex.lastIndex = 0;
  });

  return links;
}

/**
 * Extract only internal links
 */
export function extract_internal_links(content: string): MarkdownLink[] {
  return extract_links(content).filter((link) => link.is_internal);
}

/**
 * Extract all headings from markdown content
 */
export function extract_headings(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const lines = content.split('\n');

  // Match ATX headings: # Heading
  const heading_regex = /^(#{1,6})\s+(.+)$/;

  lines.forEach((line, line_index) => {
    const match = line.match(heading_regex);
    if (match) {
      headings.push({
        level: match[1]?.length ?? 1,
        text: (match[2] ?? '').trim(),
        line_number: line_index + 1,
      });
    }
  });

  return headings;
}

/**
 * Get the title (first h1) from markdown content
 */
export function extract_title(content: string): string | null {
  const headings = extract_headings(content);
  const h1 = headings.find((h) => h.level === 1);
  return h1?.text ?? null;
}

/**
 * Count words in markdown content (excluding code blocks and frontmatter)
 */
export function count_words(content: string): number {
  // Remove frontmatter
  let text = content.replace(/^---[\s\S]*?---\n*/m, '');

  // Remove code blocks
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/`[^`]+`/g, '');

  // Remove markdown syntax
  text = text.replace(/[#*_~[\]()]/g, ' ');

  // Count words
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  return words.length;
}

/**
 * Calculate estimated read time in minutes
 */
export function calculate_read_time(content: string, words_per_minute: number = 200): number {
  const word_count = count_words(content);
  return Math.ceil(word_count / words_per_minute);
}

/**
 * Format read time as string
 */
export function format_read_time(content: string): string {
  const minutes = calculate_read_time(content);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * Generate a markdown link
 */
export function create_link(text: string, url: string, title?: string): string {
  if (title) {
    return `[${text}](${url} "${title}")`;
  }
  return `[${text}](${url})`;
}

/**
 * Generate a markdown heading
 */
export function create_heading(text: string, level: number = 1): string {
  const hashes = '#'.repeat(Math.min(Math.max(level, 1), 6));
  return `${hashes} ${text}`;
}

/**
 * Generate a markdown table
 */
export function create_table(headers: string[], rows: string[][]): string {
  const header_row = `| ${headers.join(' | ')} |`;
  const separator_row = `| ${headers.map(() => '---').join(' | ')} |`;
  const data_rows = rows.map((row) => `| ${row.join(' | ')} |`);

  return [header_row, separator_row, ...data_rows].join('\n');
}

/**
 * Generate a markdown list
 */
export function create_list(items: string[], ordered: boolean = false): string {
  return items
    .map((item, index) => (ordered ? `${index + 1}. ${item}` : `- ${item}`))
    .join('\n');
}

/**
 * Generate a markdown checkbox list
 */
export function create_checkbox_list(
  items: { text: string; checked: boolean }[]
): string {
  return items
    .map((item) => `- [${item.checked ? 'x' : ' '}] ${item.text}`)
    .join('\n');
}

/**
 * Wrap text in a code block
 */
export function create_code_block(code: string, language: string = ''): string {
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

/**
 * Create an inline code span
 */
export function create_inline_code(code: string): string {
  return `\`${code}\``;
}

/**
 * Create a blockquote
 */
export function create_blockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * Slugify text for use in URLs/anchors
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

/**
 * Extract first paragraph as excerpt
 */
export function extract_excerpt(content: string, max_length: number = 200): string {
  // Remove frontmatter
  let text = content.replace(/^---[\s\S]*?---\n*/m, '');

  // Remove headings
  text = text.replace(/^#+\s+.*$/gm, '');

  // Get first paragraph
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
  const first_paragraph = paragraphs[0] ?? '';

  // Truncate if needed
  if (first_paragraph.length <= max_length) {
    return first_paragraph.trim();
  }

  return first_paragraph.slice(0, max_length).trim() + '...';
}
