import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { resolve_reports_dir } from '../utils/config.js';

/** File names the report generators write (timestamped markdown only). */
const REPORT_NAME = /^(maintenance|health|audit|links)-.+\.md$/;

/** `generated: true` inserted into the frontmatter block (one is added if missing). */
export function stamp_generated(content: string): string | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!m) return `---\ngenerated: true\n---\n\n${content}`;
  if (/^generated\s*:/m.test(m[1]!)) return null;
  const nl = content.includes('\r\n') ? '\r\n' : '\n';
  return `---${nl}${m[1]}${nl}generated: true${nl}${content.slice(m[0].length - m[2]!.length - 3)}`;
}

/** Stamp unstamped generator-named reports in the reports dir; returns the files touched. */
export async function stamp_reports(docs_path: string, dry_run = false): Promise<string[]> {
  const dir = await resolve_reports_dir(docs_path);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => REPORT_NAME.test(n)).sort();
  } catch {
    return [];
  }
  const touched: string[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const next = stamp_generated(await readFile(file, 'utf-8'));
    if (next === null) continue;
    if (!dry_run) await writeFile(file, next, 'utf-8');
    touched.push(file);
  }
  return touched;
}
