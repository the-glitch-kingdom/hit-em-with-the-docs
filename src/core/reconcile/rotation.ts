/**
 * Cold rotation (#97), stage half: snapshot the live docs working tree into a staging
 * copy that every `reconcile --staged` step then works on. Nothing here writes the live tree.
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from 'fs';
import { cp, mkdir, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';

export interface StageManifest {
  format: 1;
  /** docs folder, relative to the repo root */
  docs_path: string;
  source_commit: string;
  staged_at: string;
  live_checksum: string;
}

export interface Stage extends StageManifest {
  stage_dir: string;
  docs_root: string;
  ledger_file: string;
  review_dir: string;
}

const format_posix_path = (path_text: string): string => path_text.split('\\').join('/');
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** sha256 over sorted `relative-path NUL file-sha256` lines: regular files, symlinks by target, empty dirs ignored. */
export function compute_tree_checksum(root_dir: string): string {
  const lines: string[] = [];
  const walk = (dir_path: string): void => {
    for (const entry of readdirSync(dir_path, { withFileTypes: true })) {
      const abs_path = join(dir_path, entry.name);
      const rel_path = format_posix_path(relative(root_dir, abs_path));
      if (entry.isSymbolicLink()) lines.push(`${rel_path}\0link:${sha256(readlinkSync(abs_path))}`);
      else if (entry.isDirectory()) walk(abs_path);
      else if (entry.isFile()) lines.push(`${rel_path}\0${sha256(readFileSync(abs_path))}`);
    }
  };
  walk(root_dir);
  return sha256(lines.sort().join('\n'));
}

/** The nearest ancestor of `path_text` that exists (the path itself when it does). */
function find_existing_ancestor(path_text: string): string {
  let current = path_text;
  while (!existsSync(current)) current = dirname(current);
  return current;
}

/** Snapshot `docs_root` (working tree, `.git` skipped) to `<stage_dir>/docs`; refuses with nothing written. */
export async function create_stage(options: { repo_root: string; docs_root: string; stage_dir: string }): Promise<Stage> {
  const { repo_root, docs_root, stage_dir } = options;
  const is_inside = (child: string, parent: string): boolean => { const path_text = relative(parent, child); return path_text === '' || (!path_text.startsWith('..') && !isAbsolute(path_text)); };
  if (!existsSync(docs_root) || !statSync(docs_root).isDirectory()) throw new Error(`docs folder not found: ${docs_root}`);
  if (is_inside(stage_dir, docs_root)) throw new Error('the stage directory must be outside the docs tree');
  if (is_inside(docs_root, stage_dir)) throw new Error('the stage directory must not contain the docs tree');
  if (!is_inside(stage_dir, repo_root)) throw new Error('the stage directory must be inside the repo (recommended: .hewtd/<name>, which is git-ignored)');
  if (existsSync(stage_dir) && (!statSync(stage_dir).isDirectory() || readdirSync(stage_dir).length)) throw new Error(`the stage directory exists and is not empty: ${stage_dir}`);
  // rename must stay atomic when the stage is swapped in later: same filesystem as the docs tree
  if (statSync(find_existing_ancestor(stage_dir)).dev !== statSync(docs_root).dev) throw new Error('the stage directory is on a different filesystem than the docs tree');
  let source_commit: string;
  // eslint-disable-next-line id-denylist -- child_process option name
  try { source_commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo_root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { throw new Error('staging needs a git repo with at least one commit'); }

  const live_checksum = compute_tree_checksum(docs_root);
  await mkdir(stage_dir, { recursive: true });
  await cp(docs_root, join(stage_dir, 'docs'), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, filter: (source) => basename(source) !== '.git' });
  const manifest: StageManifest = { format: 1, docs_path: format_posix_path(relative(repo_root, docs_root)), source_commit, staged_at: new Date().toISOString(), live_checksum };
  await writeFile(join(stage_dir, 'stage.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return load_stage(stage_dir);
}

/** Read `<stage_dir>/stage.json`; throws when this is not a stage. */
export function load_stage(stage_dir: string): Stage {
  const manifest_file = join(stage_dir, 'stage.json');
  let manifest: StageManifest;
  try { manifest = JSON.parse(readFileSync(manifest_file, 'utf-8')); } catch { throw new Error(`not a stage (no readable stage.json): ${stage_dir}`); }
  if (manifest.format !== 1 || typeof manifest.docs_path !== 'string') throw new Error(`unsupported stage.json in ${stage_dir}`);
  if (!existsSync(join(stage_dir, 'docs'))) throw new Error(`the staged docs folder is missing: ${join(stage_dir, 'docs')}`);
  const dir = resolve(stage_dir);
  return { ...manifest, stage_dir: dir, docs_root: join(dir, 'docs'), ledger_file: join(dir, 'ledger.json'), review_dir: join(dir, 'reconcile') };
}
