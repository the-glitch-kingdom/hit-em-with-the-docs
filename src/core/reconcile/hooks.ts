import { readFile, writeFile, unlink, mkdir, chmod, lstat } from 'fs/promises';
import { join, relative, resolve, isAbsolute, dirname } from 'path';
import { spawnSync } from 'child_process';
import { scan_text, type SecretFinding } from './secrets.js';
import type { SecretsConfig } from '../../utils/config.js';
import { get_cold_pathspec } from './rotation.js';

// eslint-disable-next-line id-denylist -- child_process option name
const run_git = (repo_root: string, args: string[]) => spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: repo_root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Secret findings on lines the staged diff ADDS under `docs_root` (legacy lines are never scanned). Masked only. */
export function scan_staged(repo_root: string, docs_root: string, config: SecretsConfig): SecretFinding[] {
  const doc_path = relative(repo_root, docs_root).split('\\').join('/') || '.';
  const result = run_git(repo_root, ['diff', '--cached', '-U0', '--no-color', '--diff-filter=ACMR', '--', doc_path, ...get_cold_pathspec(repo_root)]); // cold generations hold historical values, recorded in the manifest
  if (result.status !== 0) throw new Error(`git diff --cached failed: ${result.stderr.trim()}`);
  const found: SecretFinding[] = [];
  let file = '';
  let line = 0;
  // `+++ ` is a header only between `diff --git` and the first `@@`; inside a hunk an added
  // line whose text starts with `++ ` looks the same and must still be scanned.
  let header = false;
  for (const diff_line of result.stdout.split('\n')) {
    if (diff_line.startsWith('diff --git ')) { header = true; file = ''; continue; }
    if (header && diff_line.startsWith('+++ ')) { file = resolve_header_path(diff_line.slice(4)); continue; }
    const hunk_header = /^@@ -\S+ \+(\d+)/.exec(diff_line);
    if (hunk_header) { header = false; line = parseInt(hunk_header[1]!, 10); continue; }
    if (header || !file || !diff_line.startsWith('+')) continue;
    for (const finding of scan_text(diff_line.slice(1), file, config)) if (finding.kind === 'secret') found.push({ ...finding, line, col: finding.col });
    line++;
  }
  return found;
}

/** `b/path`, a C-quoted `"b/pa\\th"`, and a trailing tab git adds after paths with spaces. */
function resolve_header_path(header_text: string): string {
  let header_path = header_text.replace(/\t$/, '');
  if (header_path.startsWith('"')) { try { header_path = JSON.parse(header_path); } catch { return ''; } }
  return header_path.startsWith('b/') ? header_path.slice(2) : '';
}

export const START = '# >>> hewtd secrets >>>';
const END = '# <<< hewtd secrets <<<';
export const BLOCK = `${START}\nnpx --no-install hewtd secrets --staged || exit 1\nnpx --no-install hewtd reconcile --changed --check --cached || exit 1\n${END}\n`;
export const GRAPH_START = '# >>> hewtd graph >>>';
const GRAPH_END = '# <<< hewtd graph <<<';
/**
 * Refreshes .hewtd/graph.json after a pull or a branch switch (#106), in the background so git returns at once (#108);
 * never fails the git command. `$3` is 0 for a single-file checkout, unset for post-merge. `hewtd graph` locks itself.
 * The redirects are on the subshell: if it kept git's stdout/stderr open, git would wait for it anyway.
 */
export const GRAPH_BLOCK = `${GRAPH_START}\nif [ "\${3:-1}" != "0" ]; then (npx --no-install hewtd graph --quiet || true) >/dev/null 2>&1 </dev/null & fi\n${GRAPH_END}\n`;
/** Blocks earlier releases wrote: only these are upgraded in place; any other text between the markers is the user's. */
const OLD_GRAPH_BLOCKS = [`${GRAPH_START}\nif [ "\${3:-1}" != "0" ]; then npx --no-install hewtd graph --quiet || true; fi\n${GRAPH_END}\n`]; // 3.3.0, foreground

/** How a hook's graph block stands: hewtd's current one, an older one hewtd wrote, or the user's own (backgrounded or not). */
export function get_graph_block_state(hook_text: string): 'current' | 'old' | 'custom-background' | 'custom-foreground' | 'absent' {
  const found = new RegExp(`${GRAPH_START}[\\s\\S]*?${GRAPH_END}(?:\\n|$)`).exec(hook_text)?.[0];
  if (!found) return 'absent';
  const block = found.endsWith('\n') ? found : `${found}\n`;
  if (block === GRAPH_BLOCK) return 'current';
  if (OLD_GRAPH_BLOCKS.includes(block)) return 'old';
  return /&\s*(?:fi\s*)?(?:#.*)?$/m.test(block) || /\bnohup\b|\bsetsid\b/.test(block) ? 'custom-background' : 'custom-foreground';
}
export const GRAPH_HOOKS = ['post-merge', 'post-checkout'] as const;
const SHEBANG = '#!/bin/sh\n';

interface HookBlock { name: string; start: string; end: string; block: string; line: string }
const PRE_COMMIT: HookBlock = { name: 'pre-commit', start: START, end: END, block: BLOCK, line: 'npx --no-install hewtd secrets --staged || exit 1' };
const graph_hook = (name: string): HookBlock => ({ name, start: GRAPH_START, end: GRAPH_END, block: GRAPH_BLOCK, line: GRAPH_BLOCK.split('\n')[1]! });
const block_regex = (hook: HookBlock): RegExp => new RegExp(`${hook.start}[\\s\\S]*?${hook.end}(?:\\n|$)`); // an editor may strip the last newline

export function resolve_hook_path(repo_root: string, name = 'pre-commit'): string {
  const hooks_path = run_git(repo_root, ['config', '--type=path', 'core.hooksPath']).stdout.trim(); // --type=path expands ~ as git does
  if (hooks_path) return join(isAbsolute(hooks_path) ? hooks_path : resolve(repo_root, hooks_path), name);
  const git_path_result = run_git(repo_root, ['rev-parse', '--git-path', 'hooks']);
  if (git_path_result.status !== 0) throw new Error('not a git repository');
  return join(resolve(repo_root, git_path_result.stdout.trim()), name);
}

/**
 * Opt-in: add a marked block to a hook (created if absent), never overwrite. The block goes right
 * after the shebang, so an `exit 0` / `exec` later in an existing hook cannot skip it. A hook that is
 * a symlink or not a POSIX shell script is refused: the block is shell and must not be written into
 * another language or through a link into someone else's file.
 */
async function install_block(repo_root: string, hook: HookBlock): Promise<{ path: string; changed: boolean }> {
  const path = resolve_hook_path(repo_root, hook.name);
  let cur: string | null = null;
  try { cur = await readFile(path, 'utf-8'); } catch { /* absent */ }
  if (cur?.includes(hook.start)) {
    if (cur.includes(hook.block)) return { path, changed: false };
    // graph blocks: only one hewtd wrote is upgraded; a block the user edited (backgrounded, other flags) stays theirs (#108)
    if (hook.start === GRAPH_START && get_graph_block_state(cur) !== 'old') return { path, changed: false };
    await writeFile(path, cur.replace(block_regex(hook), hook.block)); // our own block from an older version
    return { path, changed: true };
  }
  if (cur !== null) {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`${path} is a symlink; add this line to the hook it points at yourself: ${hook.line}`);
    const shebang = /^#!.*$/m.exec(cur.split('\n')[0] ?? '')?.[0];
    if (shebang && !/\b(sh|bash|dash|zsh|ksh)\b/.test(shebang)) throw new Error(`${path} is not a shell script (${shebang}); add this line to it yourself: ${hook.line}`);
  }
  await mkdir(dirname(path), { recursive: true });
  let next: string;
  if (cur === null) next = `${SHEBANG}\n${hook.block}`;
  else if (cur.startsWith('#!')) { const nl = cur.indexOf('\n'); next = nl < 0 ? `${cur}\n${hook.block}` : `${cur.slice(0, nl + 1)}${hook.block}${cur.slice(nl + 1)}`; }
  else next = `${hook.block}${cur}`;
  await writeFile(path, next);
  await chmod(path, 0o755);
  return { path, changed: true };
}

/** Removes only the block (byte-exact restore); deletes a hook file that hewtd created. */
async function uninstall_block(repo_root: string, hook: HookBlock): Promise<{ path: string; changed: boolean }> {
  const path = resolve_hook_path(repo_root, hook.name);
  let cur: string;
  try { cur = await readFile(path, 'utf-8'); } catch { return { path, changed: false }; }
  if (!cur.includes(hook.start)) return { path, changed: false };
  // Exact inverse of install (block inserted verbatim after the shebang or at the top).
  const next = cur.replace(block_regex(hook), '');
  if (next === `${SHEBANG}\n` || next === '') await unlink(path); // a hook hewtd created
  else await writeFile(path, next);
  return { path, changed: true };
}

export const install_hook = (repo_root: string) => install_block(repo_root, PRE_COMMIT);
export const uninstall_hook = (repo_root: string) => uninstall_block(repo_root, PRE_COMMIT);
/** The graph refresh block in `post-merge` or `post-checkout` (#106). */
export const install_graph_hook = (repo_root: string, name: (typeof GRAPH_HOOKS)[number]) => install_block(repo_root, graph_hook(name));
export const uninstall_graph_hook = (repo_root: string, name: (typeof GRAPH_HOOKS)[number]) => uninstall_block(repo_root, graph_hook(name));

/** Docs (docs-relative posix paths) staged as added or modified under `docs_root`, for the review check in the pre-commit hook (#98). */
export function list_staged_docs(repo_root: string, docs_root: string): string[] {
  const docs_rel = relative(repo_root, docs_root).split('\\').join('/');
  const result = run_git(repo_root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', '--', docs_rel || '.']);
  if (result.status !== 0) throw new Error(`git diff --cached failed: ${result.stderr.trim()}`);
  return result.stdout.split('\0').filter((file) => /\.md$/.test(file) && !/(^|\/)(INDEX|REGISTRY)\.md$/.test(file) && !/\/archive\//.test(`/${file}`))
    .map((file) => (docs_rel ? file.slice(docs_rel.length + 1) : file));
}
