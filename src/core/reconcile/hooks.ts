import { readFile, writeFile, unlink, mkdir, chmod } from 'fs/promises';
import { join, relative, resolve, isAbsolute, dirname } from 'path';
import { spawnSync } from 'child_process';
import { scanText, type SecretFinding } from './secrets.js';
import type { SecretsConfig } from '../../utils/config.js';

const git = (root: string, args: string[]) => spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Secret findings on lines the staged diff ADDS under `docsPath` (legacy lines are never scanned). Masked only. */
export function scanStaged(root: string, docsPath: string, cfg: SecretsConfig): SecretFinding[] {
  const rel = relative(root, docsPath).split('\\').join('/') || '.';
  const r = git(root, ['diff', '--cached', '-U0', '--no-color', '--diff-filter=ACMR', '--', rel]);
  if (r.status !== 0) throw new Error(`git diff --cached failed: ${r.stderr.trim()}`);
  const out: SecretFinding[] = [];
  let file = '';
  let line = 0;
  for (const l of r.stdout.split('\n')) {
    if (l.startsWith('+++ ')) { file = l.startsWith('+++ b/') ? l.slice(6) : ''; continue; }
    const h = /^@@ -\S+ \+(\d+)/.exec(l);
    if (h) { line = parseInt(h[1]!, 10); continue; }
    if (!file || !l.startsWith('+')) continue;
    for (const f of scanText(l.slice(1), file, cfg)) if (f.kind === 'secret') out.push({ ...f, line, col: f.col });
    line++;
  }
  return out;
}

const START = '# >>> hewtd secrets >>>';
const END = '# <<< hewtd secrets <<<';
const BLOCK = `${START}\nnpx --no-install hewtd secrets --staged || exit 1\n${END}\n`;
const SHEBANG = '#!/bin/sh\n';

function hookPath(root: string): string {
  const cp = git(root, ['config', 'core.hooksPath']).stdout.trim();
  if (cp) return join(isAbsolute(cp) ? cp : resolve(root, cp), 'pre-commit');
  const g = git(root, ['rev-parse', '--git-path', 'hooks']);
  if (g.status !== 0) throw new Error('not a git repository');
  return join(resolve(root, g.stdout.trim()), 'pre-commit');
}

/** Opt-in: append a marked block to pre-commit (created if absent), never overwrite. Returns the hook path. */
export async function installHook(root: string): Promise<{ path: string; changed: boolean }> {
  const path = hookPath(root);
  let cur: string | null = null;
  try { cur = await readFile(path, 'utf-8'); } catch { /* absent */ }
  if (cur?.includes(START)) return { path, changed: false };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, cur === null ? `${SHEBANG}\n${BLOCK}` : `${cur}\n${BLOCK}`);
  await chmod(path, 0o755);
  return { path, changed: true };
}

/** Removes only the block (byte-exact restore); deletes a hook file that hewtd created. */
export async function uninstallHook(root: string): Promise<{ path: string; changed: boolean }> {
  const path = hookPath(root);
  let cur: string;
  try { cur = await readFile(path, 'utf-8'); } catch { return { path, changed: false }; }
  if (!cur.includes(START)) return { path, changed: false };
  const next = cur.includes(`\n${BLOCK}`) ? cur.replace(`\n${BLOCK}`, '') : cur.replace(BLOCK, '');
  if (next === SHEBANG || next === '') await unlink(path);
  else await writeFile(path, next);
  return { path, changed: true };
}
