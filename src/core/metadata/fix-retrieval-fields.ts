/**
 * `hewtd fix-retrieval-fields` (#50): move summary/description into purpose and
 * fold keywords into tags. Touches no other frontmatter key or the body.
 * Dry run unless apply is true.
 */

import { readFile, writeFile } from 'fs/promises';
import { parse_frontmatter, render_frontmatter } from '../../utils/frontmatter.js';
import { list_glob_matches } from '../../utils/glob.js';
import { dirname } from 'path';
import { load_plugin_config } from '../../utils/config.js';
import { is_weak_purpose } from '../audit/retrieval.js';

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

const is_string = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const normalize_list = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : is_string(value) ? [value] : [];

export async function fix_retrieval_fields(options: {
  docs_root: string;
  apply?: boolean;
}): Promise<FixRetrievalFieldsResult> {
  const result: FixRetrievalFieldsResult = { changed: [], conflicts: [], errors: [], dropped: 0, cleared: 0 };
  const config = (await load_plugin_config(dirname(options.docs_root))).retrieval;
  // eslint-disable-next-line id-denylist -- child_process/glob option name
  const files = (await list_glob_matches('**/*.md', { cwd: options.docs_root, absolute: true })).sort();

  for (const file of files) {
    if (/(^|[\\/])(INDEX|REGISTRY)\.md$/.test(file)) continue;
    const raw_text = await readFile(file, 'utf-8');
    let parsed;
    try {
      parsed = parse_frontmatter(raw_text);
    } catch (error) {
      result.errors.push({ file, message: (error as Error).message });
      continue;
    }
    const data = parsed.data;
    if (data.generated === true) continue;

    const actions: string[] = [];
    const title = is_string(data.title) ? data.title.trim() : '';
    // Only the exact generator fallback is cleared; any other weak purpose is a person's words.
    if (is_string(data.purpose) && data.purpose.trim().toLowerCase() === `documentation for ${title}`.toLowerCase()) {
      delete data.purpose;
      result.cleared++;
      actions.push('purpose was generator filler, cleared');
    }
    // summary first, then description: a dropped filler summary falls through to description.
    for (const source of ['summary', 'description'] as const) {
      if (!is_string(data[source])) continue;
      if (is_string(data.purpose)) {
        result.conflicts.push(file);
        break;
      }
      if (is_weak_purpose((data[source] as string).trim(), title, config)) {
        delete data[source];
        result.dropped++;
        actions.push(`${source} was filler, dropped`);
      } else {
        data.purpose = (data[source] as string).trim();
        delete data[source];
        actions.push(`${source} -> purpose`);
      }
    }
    if (data.keywords !== undefined) {
      const merged = [...new Set([...normalize_list(data.tags), ...normalize_list(data.keywords)])];
      data.tags = merged;
      delete data.keywords;
      actions.push('keywords -> tags');
    }
    if (actions.length === 0) continue;

    result.changed.push({ file, actions });
    if (options.apply) {
      // Replace only the frontmatter block; the body is written back byte for byte.
      const body = raw_text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
      await writeFile(file, `---\n${render_frontmatter(data, raw_text)}---\n${body}`, 'utf-8');
    }
  }
  return result;
}
