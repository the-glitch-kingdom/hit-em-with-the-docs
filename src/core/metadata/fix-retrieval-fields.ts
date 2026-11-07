/**
 * `hewtd fix-retrieval-fields` (#50): move summary/description into purpose and
 * fold keywords into tags. Touches no other frontmatter key or the body.
 * Dry run unless apply is true.
 */

import { readFile, writeFile } from 'fs/promises';
import matter from 'gray-matter';
import { glob } from '../../utils/glob.js';

export interface FixRetrievalFieldsResult {
  /** Files rewritten (or that would be, on a dry run). */
  changed: { file: string; actions: string[] }[];
  /** purpose and summary/description both present: left alone. */
  conflicts: string[];
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : isStr(v) ? [v] : [];

export async function fixRetrievalFields(opts: {
  docsPath: string;
  apply?: boolean;
}): Promise<FixRetrievalFieldsResult> {
  const result: FixRetrievalFieldsResult = { changed: [], conflicts: [] };
  const files = (await glob('**/*.md', { cwd: opts.docsPath, absolute: true })).sort();

  for (const file of files) {
    if (/(^|[\\/])(INDEX|REGISTRY)\.md$/.test(file)) continue;
    const raw = await readFile(file, 'utf-8');
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    if (data.generated === true) continue;

    const actions: string[] = [];
    const src = isStr(data.summary) ? 'summary' : isStr(data.description) ? 'description' : null;
    if (src) {
      if (isStr(data.purpose)) {
        result.conflicts.push(file);
      } else {
        data.purpose = (data[src] as string).trim();
        delete data[src];
        actions.push(`${src} -> purpose`);
      }
    }
    if (data.keywords !== undefined) {
      const merged = [...new Set([...asList(data.tags), ...asList(data.keywords)])];
      data.tags = merged;
      delete data.keywords;
      actions.push('keywords -> tags');
    }
    if (actions.length === 0) continue;

    result.changed.push({ file, actions });
    if (opts.apply) await writeFile(file, matter.stringify(parsed.content, data), 'utf-8');
  }
  return result;
}
