import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';

/**
 * Where the docs tree is when `-p` was left at its default. If `<cwd>/<name>`
 * is missing, use the nearest ancestor that has it, stopping at the git root
 * (a dir with `.git`) or the filesystem root; otherwise fall back to cwd.
 * An explicit `-p` is always taken as given.
 */
export function resolve_docs_path(working_dir: string, opt_path: string, explicit: boolean): string {
  const direct = resolve(working_dir, opt_path);
  if (explicit || existsSync(direct)) return direct;
  let dir_path = working_dir;
  for (;;) {
    const candidate = join(dir_path, opt_path);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir_path);
    if (existsSync(join(dir_path, '.git')) || parent === dir_path) return direct;
    dir_path = parent;
  }
}
