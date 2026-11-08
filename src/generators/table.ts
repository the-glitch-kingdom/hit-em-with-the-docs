/**
 * Deterministic markdown table formatter (2.3.0).
 *
 * Pads columns to the max width per column so diffs stay clean as rows
 * are added/removed. Uses `\n` line endings explicitly.
 */

export function render_markdown_table(
  headers: string[],
  rows: string[][]
): string {
  const widths = headers.map((header, i) => {
    let max = header.length;
    for (const row of rows) {
      const cell = row[i] ?? '';
      if (cell.length > max) max = cell.length;
    }
    return max;
  });

  const format_padded = (cell: string, width: number): string => cell.padEnd(width, ' ');

  const header_line = `| ${headers.map((header, i) => format_padded(header, widths[i]!)).join(' | ')} |`;
  const sep_line = `|${widths.map((width) => '-'.repeat(width + 2)).join('|')}|`;
  const body_lines = rows.map(
    (row) =>
      `| ${row.map((cell, i) => format_padded(cell ?? '', widths[i]!)).join(' | ')} |`
  );

  return [header_line, sep_line, ...body_lines].join('\n');
}
