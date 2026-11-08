/**
 * Deterministic markdown table formatter (2.3.0).
 *
 * Pads columns to the max width per column so diffs stay clean as rows
 * are added/removed. Uses `\n` line endings explicitly.
 */

export function format_markdown_table(
  headers: string[],
  rows: string[][]
): string {
  const widths = headers.map((h, i) => {
    let max = h.length;
    for (const row of rows) {
      const cell = row[i] ?? '';
      if (cell.length > max) max = cell.length;
    }
    return max;
  });

  const pad = (cell: string, width: number): string => cell.padEnd(width, ' ');

  const header_line = `| ${headers.map((h, i) => pad(h, widths[i]!)).join(' | ')} |`;
  const sep_line = `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`;
  const body_lines = rows.map(
    (row) =>
      `| ${row.map((cell, i) => pad(cell ?? '', widths[i]!)).join(' | ')} |`
  );

  return [header_line, sep_line, ...body_lines].join('\n');
}
