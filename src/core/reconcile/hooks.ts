import { readFile, writeFile, unlink, mkdir, chmod, lstat } from 'fs/promises';
import { join, relative, resolve, isAbsolute, dirname } from 'path';
import { spawnSync } from 'child_process';
import { scan_text, type SecretFinding } from './secrets.js';
import type { SecretsConfig } from '../../utils/config.js';

// eslint-disable-next-line id-denylist -- child_process option name
const run_git = (repo_root: string, args: string[]) => spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: repo_root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Secret findings on lines the staged diff ADDS under `docs_root` (legacy lines are never scanned). Masked only. */
export function scan_staged(repo_root: string, docs_root: string, config: SecretsConfig): SecretFinding[] {
  const doc_path = relative(repo_root, docs_root).split('\\').join('/') || '.';
  const result = run_git(repo_root, ['diff', '--cached', '-U0', '--no-color', '--diff-filter=ACMR', '--', doc_path]);
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

const START = '# >>> hewtd secrets >>>';
const END = '# <<< hewtd secrets <<<';
const BLOCK = `${START}\nnpx --no-install hewtd secrets --staged || exit 1\n${END}\n`;
const SHEBANG = '#!/bin/sh\n';

function resolve_hook_path(repo_root: string): string {
  const hooks_path = run_git(repo_root, ['config', 'core.hooksPath']).stdout.trim();
  if (hooks_path) return join(isAbsolute(hooks_path) ? hooks_path : resolve(repo_root, hooks_path), 'pre-commit');
  const git_path_result = run_git(repo_root, ['rev-parse', '--git-path', 'hooks']);
  if (git_path_result.status !== 0) throw new Error('not a git repository');
  return join(resolve(repo_root, git_path_result.stdout.trim()), 'pre-commit');
}

/**
 * Opt-in: add a marked block to pre-commit (created if absent), never overwrite. The block goes right
 * after the shebang, so an `exit 0` / `exec` later in an existing hook cannot skip it. A hook that is
 * a symlink or not a POSIX shell script is refused: the block is shell and must not be written into
 * another language or through a link into someone else's file.
 */
export async function install_hook(repo_root: string): Promise<{ path: string; changed: boolean }> {
  const path = resolve_hook_path(repo_root);
  let cur: string | null = null;
  try { cur = await readFile(path, 'utf-8'); } catch { /* absent */ }
  if (cur?.includes(START)) return { path, changed: false };
  if (cur !== null) {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`${path} is a symlink; add this line to the hook it points at yourself: npx --no-install hewtd secrets --staged || exit 1`);
    const shebang = /^#!.*$/m.exec(cur.split('\n')[0] ?? '')?.[0];
    if (shebang && !/\b(sh|bash|dash|zsh|ksh)\b/.test(shebang)) throw new Error(`${path} is not a shell script (${shebang}); call \`hewtd secrets --staged\` from it yourself`);
  }
  await mkdir(dirname(path), { recursive: true });
  let next: string;
  if (cur === null) next = `${SHEBANG}\n${BLOCK}`;
  else if (cur.startsWith('#!')) { const nl = cur.indexOf('\n'); next = nl < 0 ? `${cur}\n${BLOCK}` : `${cur.slice(0, nl + 1)}${BLOCK}${cur.slice(nl + 1)}`; }
  else next = `${BLOCK}${cur}`;
  await writeFile(path, next);
  await chmod(path, 0o755);
  return { path, changed: true };
}

/** Removes only the block (byte-exact restore); deletes a hook file that hewtd created. */
export async function uninstall_hook(repo_root: string): Promise<{ path: string; changed: boolean }> {
  const path = resolve_hook_path(repo_root);
  let cur: string;
  try { cur = await readFile(path, 'utf-8'); } catch { return { path, changed: false }; }
  if (!cur.includes(START)) return { path, changed: false };
  // Exact inverse of install (block inserted verbatim after the shebang or at the top).
  const next = cur.replace(BLOCK, '');
  if (next === `${SHEBANG}\n` || next === '') await unlink(path); // a hook hewtd created
  else await writeFile(path, next);
  return { path, changed: true };
}
