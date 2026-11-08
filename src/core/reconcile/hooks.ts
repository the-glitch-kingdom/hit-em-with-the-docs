import { readFile, writeFile, unlink, mkdir, chmod, lstat } from 'fs/promises';
import { join, relative, resolve, isAbsolute, dirname } from 'path';
import { spawnSync } from 'child_process';
import { scan_text, type SecretFinding } from './secrets.js';
import type { SecretsConfig } from '../../utils/config.js';

const git = (root: string, args: string[]) => spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Secret findings on lines the staged diff ADDS under `docsPath` (legacy lines are never scanned). Masked only. */
export function scan_staged(root: string, docs_path: string, cfg: SecretsConfig): SecretFinding[] {
  const rel = relative(root, docs_path).split('\\').join('/') || '.';
  const r = git(root, ['diff', '--cached', '-U0', '--no-color', '--diff-filter=ACMR', '--', rel]);
  if (r.status !== 0) throw new Error(`git diff --cached failed: ${r.stderr.trim()}`);
  const out: SecretFinding[] = [];
  let file = '';
  let line = 0;
  // `+++ ` is a header only between `diff --git` and the first `@@`; inside a hunk an added
  // line whose text starts with `++ ` looks the same and must still be scanned.
  let header = false;
  for (const l of r.stdout.split('\n')) {
    if (l.startsWith('diff --git ')) { header = true; file = ''; continue; }
    if (header && l.startsWith('+++ ')) { file = header_path(l.slice(4)); continue; }
    const h = /^@@ -\S+ \+(\d+)/.exec(l);
    if (h) { header = false; line = parseInt(h[1]!, 10); continue; }
    if (header || !file || !l.startsWith('+')) continue;
    for (const f of scan_text(l.slice(1), file, cfg)) if (f.kind === 'secret') out.push({ ...f, line, col: f.col });
    line++;
  }
  return out;
}

/** `b/path`, a C-quoted `"b/pa\\th"`, and a trailing tab git adds after paths with spaces. */
function header_path(raw: string): string {
  let p = raw.replace(/\t$/, '');
  if (p.startsWith('"')) { try { p = JSON.parse(p); } catch { return ''; } }
  return p.startsWith('b/') ? p.slice(2) : '';
}

const START = '# >>> hewtd secrets >>>';
const END = '# <<< hewtd secrets <<<';
const BLOCK = `${START}\nnpx --no-install hewtd secrets --staged || exit 1\n${END}\n`;
const SHEBANG = '#!/bin/sh\n';

function hook_path(root: string): string {
  const cp = git(root, ['config', 'core.hooksPath']).stdout.trim();
  if (cp) return join(isAbsolute(cp) ? cp : resolve(root, cp), 'pre-commit');
  const g = git(root, ['rev-parse', '--git-path', 'hooks']);
  if (g.status !== 0) throw new Error('not a git repository');
  return join(resolve(root, g.stdout.trim()), 'pre-commit');
}

/**
 * Opt-in: add a marked block to pre-commit (created if absent), never overwrite. The block goes right
 * after the shebang, so an `exit 0` / `exec` later in an existing hook cannot skip it. A hook that is
 * a symlink or not a POSIX shell script is refused: the block is shell and must not be written into
 * another language or through a link into someone else's file.
 */
export async function install_hook(root: string): Promise<{ path: string; changed: boolean }> {
  const path = hook_path(root);
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
export async function uninstall_hook(root: string): Promise<{ path: string; changed: boolean }> {
  const path = hook_path(root);
  let cur: string;
  try { cur = await readFile(path, 'utf-8'); } catch { return { path, changed: false }; }
  if (!cur.includes(START)) return { path, changed: false };
  // Exact inverse of install (block inserted verbatim after the shebang or at the top).
  const next = cur.replace(BLOCK, '');
  if (next === `${SHEBANG}\n` || next === '') await unlink(path); // a hook hewtd created
  else await writeFile(path, next);
  return { path, changed: true };
}
