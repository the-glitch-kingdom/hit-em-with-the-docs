import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

/**
 * Where the docs tree is when `-p` was left at its default. If `<cwd>/<name>`
 * is missing, use the nearest ancestor that has it, stopping at the git root
 * (a dir with `.git`) or the filesystem root; otherwise fall back to cwd.
 * An explicit `-p` is always taken as given.
 */
export function resolve_docs_path(cwd: string, opt_path: string, explicit: boolean): string {
  const direct = resolve(cwd, opt_path);
  if (explicit || existsSync(direct)) return direct;
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, opt_path);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (existsSync(join(dir, '.git')) || parent === dir) return direct;
    dir = parent;
  }
}
