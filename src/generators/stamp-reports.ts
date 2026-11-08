import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { resolve_reports_dir } from '../utils/config.js';

/** File names the report generators write (timestamped markdown only). */
const REPORT_NAME = /^(maintenance|health|audit|links)-.+\.md$/;

/** `generated: true` inserted into the frontmatter block (one is added if missing). */
export function with_generated_stamp(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) return `---\ngenerated: true\n---\n\n${content}`;
  if (/^generated\s*:/m.test(match[1]!)) return null;
  const nl = content.includes('\r\n') ? '\r\n' : '\n';
  return `---${nl}${match[1]}${nl}generated: true${nl}${content.slice(match[0].length - match[2]!.length - 3)}`;
}

/** Stamp unstamped generator-named reports in the reports dir; returns the files touched. */
export async function write_report_stamps(docs_root: string, dry_run = false): Promise<string[]> {
  const dir_path = await resolve_reports_dir(docs_root);
  let names: string[];
  try {
    names = (await readdir(dir_path)).filter((file_name) => REPORT_NAME.test(file_name)).sort();
  } catch {
    return [];
  }
  const touched: string[] = [];
  for (const name of names) {
    const file = join(dir_path, name);
    const next = with_generated_stamp(await readFile(file, 'utf-8'));
    if (next === null) continue;
    if (!dry_run) await writeFile(file, next, 'utf-8');
    touched.push(file);
  }
  return touched;
}
