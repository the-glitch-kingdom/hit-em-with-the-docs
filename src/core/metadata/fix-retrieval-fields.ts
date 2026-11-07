/**
 * `hewtd fix-retrieval-fields` (#50): move summary/description into purpose and
 * fold keywords into tags. Touches no other frontmatter key or the body.
 * Dry run unless apply is true.
 */

import { readFile, writeFile } from 'fs/promises';
import { parseFrontmatter, stringifyFrontmatter } from '../../utils/frontmatter.js';
import { glob } from '../../utils/glob.js';
import { dirname } from 'path';
import { loadPluginConfig } from '../../utils/config.js';
import { isWeakPurpose } from '../audit/retrieval.js';

export interface FixRetrievalFieldsResult {
  /** Files rewritten (or that would be, on a dry run). */
  changed: { file: string; actions: string[] }[];
  /** purpose and summary/description both present: left alone. */
  conflicts: string[];
  /** Files that could not be parsed; skipped, the run continues. */
  errors: { file: string; message: string }[];
  /** Filler summary/description values deleted instead of moved into purpose. */
  dropped: number;
  /** Existing `Documentation for <title>` generator purposes removed. */
  cleared: number;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : isStr(v) ? [v] : [];

export async function fixRetrievalFields(opts: {
  docsPath: string;
  apply?: boolean;
}): Promise<FixRetrievalFieldsResult> {
  const result: FixRetrievalFieldsResult = { changed: [], conflicts: [], errors: [], dropped: 0, cleared: 0 };
  const cfg = (await loadPluginConfig(dirname(opts.docsPath))).retrieval;
  const files = (await glob('**/*.md', { cwd: opts.docsPath, absolute: true })).sort();

  for (const file of files) {
    if (/(^|[\\/])(INDEX|REGISTRY)\.md$/.test(file)) continue;
    const raw = await readFile(file, 'utf-8');
    let parsed;
    try {
      parsed = parseFrontmatter(raw);
    } catch (err) {
      result.errors.push({ file, message: (err as Error).message });
      continue;
    }
    const data = parsed.data;
    if (data.generated === true) continue;

    const actions: string[] = [];
    const title = isStr(data.title) ? data.title.trim() : '';
    // Only the exact generator fallback is cleared; any other weak purpose is a person's words.
    if (isStr(data.purpose) && data.purpose.trim().toLowerCase() === `documentation for ${title}`.toLowerCase()) {
      delete data.purpose;
      result.cleared++;
      actions.push('purpose was generator filler, cleared');
    }
    const src = isStr(data.summary) ? 'summary' : isStr(data.description) ? 'description' : null;
    if (src) {
      if (isStr(data.purpose)) {
        result.conflicts.push(file);
      } else if (isWeakPurpose((data[src] as string).trim(), title, cfg)) {
        delete data[src];
        result.dropped++;
        actions.push(`${src} was filler, dropped`);
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
    if (opts.apply) {
      // Replace only the frontmatter block; the body is written back byte for byte.
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
      await writeFile(file, `---\n${stringifyFrontmatter(data)}---\n${body}`, 'utf-8');
    }
  }
  return result;
}
