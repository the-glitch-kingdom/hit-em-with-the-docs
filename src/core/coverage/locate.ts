/**
 * Locate facets in tracked code (#113): which files and lines hold the fact a facet names, so a draft can cite
 * them. One pass over `git ls-files`: each file is read once and every facet is tested per line (no spawn per
 * facet per file). Docs, archive, the cold root, reports and agent instruction files are not code; instruction
 * files are scanned apart, so a fact that lives only there can be reported as unreachable by search.
 * Only file and line come back, never the line text: a value must not leave the located file.
 */
import { execFileSync } from 'child_process';
import { readFile, stat } from 'fs/promises';
import { join, relative } from 'path';
import { compile_facet, test_facet } from './facets.js';

export interface FacetHit { file: string; line: number }
export interface LocateResult {
  /** Per facet (as given): hits in tracked code. Facets that do not compile are absent. */
  code: Map<string, FacetHit[]>;
  /** Per facet: hits in agent instruction files only. */
  instructions: Map<string, FacetHit[]>;
}

/** Hits kept per facet: a draft cites a few lines; a facet matching hundreds is too generic to ground anything. */
export const MAX_HITS_PER_FACET = 20;
/** Larger files are generated or vendored, not hand-written code. */
const MAX_FILE_BYTES = 512 * 1024;
const NOT_CODE = /(^|\/)(node_modules|\.git|\.hewtd|\.planning|\.claude|reports|archive|dist|build|coverage)\/|\.(md|mdx|txt|rst|lock|map|min\.js|png|jpe?g|gif|ico|pdf|woff2?|zip|gz|svg)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const INSTRUCTION = /(^|\/)(CLAUDE|AGENTS|GEMINI)\.md$|(^|\/)\.claude\/rules\/.+\.md$/;

export const is_instruction_file = (repo_path: string): boolean => INSTRUCTION.test(repo_path);

function list_tracked_files(repo_root: string): string[] {
  try {
    // eslint-disable-next-line id-denylist -- child_process option names
    return execFileSync('git', ['ls-files', '-z'], { cwd: repo_root, encoding: 'utf-8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    return []; // not a git repo: nothing is tracked, so nothing is located
  }
}

export async function locate_facets(options: { repo_root: string; docs_root: string; cold_root?: string; facets: string[] }): Promise<LocateResult> {
  const { repo_root, docs_root } = options;
  const compiled = options.facets.map((facet) => ({ facet, regex: compile_facet(facet).regex })).filter((item): item is { facet: string; regex: RegExp } => !!item.regex);
  const result: LocateResult = { code: new Map(compiled.map((item) => [item.facet, []])), instructions: new Map(compiled.map((item) => [item.facet, []])) };
  if (!compiled.length) return result;
  const docs_prefix = relative(repo_root, docs_root).split('\\').join('/') + '/';
  const cold_prefix = options.cold_root ? options.cold_root.replace(/^\.\//, '').replace(/\/?$/, '/') : undefined;
  for (const file of list_tracked_files(repo_root)) {
    if (file.startsWith(docs_prefix) || (cold_prefix && file.startsWith(cold_prefix))) continue;
    const instruction = is_instruction_file(file);
    if (!instruction && NOT_CODE.test(file)) continue;
    let text: string;
    try {
      const abs_path = join(repo_root, file);
      if ((await stat(abs_path)).size > MAX_FILE_BYTES) continue;
      text = await readFile(abs_path, 'utf-8');
    } catch {
      continue; // tracked but deleted in the working tree
    }
    if (text.slice(0, 8000).includes('\0')) continue; // binary
    const into = instruction ? result.instructions : result.code;
    text.split('\n').forEach((line, i) => {
      for (const { facet, regex } of compiled) {
        const found = into.get(facet)!;
        if (found.length < MAX_HITS_PER_FACET && test_facet(regex, line)) found.push({ file, line: i + 1 });
      }
    });
  }
  return result;
}
