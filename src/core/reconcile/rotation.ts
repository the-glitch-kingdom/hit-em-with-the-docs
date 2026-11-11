/**
 * Cold rotation (#97). Stage half: snapshot the live docs working tree into a staging copy
 * that every `reconcile --staged` step then works on (nothing there writes the live tree).
 * Rotation half: `run_promote` swaps the copy in and keeps the old tree as a committed, read-only,
 * dated cold generation; `run_undo` reverses it. Trees are only ever renamed, never deleted, and
 * every step after the first rename has an inverse that runs on any failure.
 */
import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, readlinkSync, statSync } from 'fs';
import { copyFile, cp, mkdir, readFile, rename, rmdir, unlink, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'path';
import { load_plugin_config_sync, load_raw_config, resolve_config_file_path, write_raw_config, type ColdGeneration, type PluginConfig } from '../../utils/config.js';
import { regenerate_indexes } from '../../generators/regenerate.js';
import { scan_file } from './secrets.js';

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

// ---- cold root: every repo-wide scanner leaves it out (a cold generation is never current docs) ----

/** The cold root, repo-relative and posix, or undefined when the config value is unusable (empty, absolute, outside the repo). */
export function get_cold_prefix(repo_root: string): string | undefined {
  const cold_root = format_posix_path(normalize(load_plugin_config_sync(repo_root).reconcile.cold_root)).replace(/\/+$/, '');
  return !cold_root || cold_root === '.' || cold_root.startsWith('..') || isAbsolute(cold_root) ? undefined : cold_root;
}

/** True for a repo-relative path inside `cold_prefix`. */
export const is_in_cold = (repo_path: string, cold_prefix: string | undefined): boolean => !!cold_prefix && (repo_path === cold_prefix || repo_path.startsWith(`${cold_prefix}/`));

/** A git pathspec that excludes the cold root, or none when there is no usable one. */
export const get_cold_pathspec = (repo_root: string): string[] => { const prefix = get_cold_prefix(repo_root); return prefix ? [`:(exclude,literal)${prefix}`] : []; };

// ---- promote / undo ----

export interface RotationPlan {
  generation: string;
  /** repo-relative */
  cold_path: string;
  stage_path: string;
  docs_path: string;
  source_commit: string;
  secrets_findings: string[];
  untracked_files: string[];
}

interface RotationContext { repo_root: string; docs_root: string; config: PluginConfig }
type Rename = (from: string, to: string) => Promise<void>;

// eslint-disable-next-line id-denylist -- child_process option name
const run_git = (repo_root: string, args: string[]) => spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: repo_root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const read_git = (repo_root: string, args: string[]): string => {
  const result = run_git(repo_root, args);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
};
const is_inside = (child: string, parent: string): boolean => { const path_text = relative(parent, child); return path_text === '' || (!path_text.startsWith('..') && !isAbsolute(path_text)); };
const get_device = (path_text: string): number => statSync(find_existing_ancestor(path_text)).dev;

/** Strip (or restore) the write bits of a whole tree; other mode bits are kept, symlinks skipped. */
function set_tree_writable(root_dir: string, writable: boolean): void {
  const apply = (path_text: string): void => { const mode = statSync(path_text).mode & 0o7777; chmodSync(path_text, writable ? mode | 0o200 : mode & ~0o222); };
  const walk = (dir_path: string): void => {
    for (const entry of readdirSync(dir_path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const abs_path = join(dir_path, entry.name);
      if (entry.isDirectory()) walk(abs_path);
      apply(abs_path);
    }
  };
  if (writable) apply(root_dir);
  walk(root_dir);
  if (!writable) apply(root_dir);
}

function list_tree_files(root_dir: string): string[] {
  const found: string[] = [];
  const walk = (dir_path: string): void => {
    for (const entry of readdirSync(dir_path, { withFileTypes: true })) {
      const abs_path = join(dir_path, entry.name);
      if (entry.isDirectory()) walk(abs_path);
      else if (entry.isFile()) found.push(abs_path);
    }
  };
  walk(root_dir);
  return found.sort();
}

/** Secret findings (`path:line`, never values) over every markdown file of a tree, archive/ and gitignored files included. */
async function scan_tree_secrets(root_dir: string, config: PluginConfig): Promise<string[]> {
  const found: string[] = [];
  for (const abs_path of list_tree_files(root_dir)) {
    if (!abs_path.endsWith('.md') || statSync(abs_path).size > 2 * 1024 * 1024) continue;
    const rel_path = format_posix_path(relative(root_dir, abs_path));
    for (const finding of await scan_file(abs_path, rel_path, config.reconcile.secrets)) if (finding.kind === 'secret') found.push(`${rel_path}:${finding.line}`);
  }
  return found;
}

function check_cold_root(context: RotationContext): { cold_prefix: string; cold_dir: string } {
  const { repo_root, docs_root } = context;
  const cold_prefix = get_cold_prefix(repo_root);
  const cold_dir = cold_prefix ? resolve(repo_root, cold_prefix) : '';
  if (!cold_prefix || is_inside(cold_dir, docs_root) || is_inside(docs_root, cold_dir)) {
    throw new Error(`reconcile.cold_root (${context.config.reconcile.cold_root}) must be a repo-relative folder outside the docs tree`);
  }
  if (get_device(cold_dir) !== statSync(docs_root).dev) throw new Error('the cold root is on a different filesystem than the docs tree (the swap must be an atomic rename)');
  if (run_git(repo_root, ['check-ignore', '-q', '--', `${cold_prefix}/probe`]).status === 0) throw new Error(`the cold root ${cold_prefix} is git-ignored; generations must be committed`);
  return { cold_prefix, cold_dir };
}

/** Nothing the rotation commit would sweep up may be uncommitted: the docs, the cold root, the config, the ledger, the index. */
function check_clean(context: RotationContext, cold_prefix: string): void {
  const { repo_root, docs_root, config } = context;
  const paths = [relative(repo_root, docs_root), cold_prefix, relative(repo_root, resolve_config_file_path(repo_root)), config.reconcile.ledger_path].map(format_posix_path);
  const dirty = read_git(repo_root, ['status', '--porcelain', '--', ...paths]).split('\n').filter(Boolean);
  const staged = read_git(repo_root, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  if (dirty.length || staged.length) throw new Error(`uncommitted changes (commit or stash first):\n${[...dirty.map((line) => `  ${line}`), ...staged.map((file) => `  staged: ${file}`)].slice(0, 20).join('\n')}`);
}

function check_git(repo_root: string): void {
  const top = run_git(repo_root, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || resolve(top.stdout.trim()) !== resolve(repo_root)) throw new Error('rotation needs the docs folder to be in a git repo whose top level is the project root');
}

function pick_generation_name(cold_dir: string, taken: string[]): string {
  const base = new Date().toISOString().slice(0, 10);
  for (let suffix = 1; ; suffix++) {
    const name = suffix === 1 ? base : `${base}-${suffix}`;
    if (!existsSync(join(cold_dir, name)) && !taken.includes(name)) return name;
  }
}

/** Every refusal of `--promote`, in order, with nothing changed; returns what the confirmed run would do. */
export async function plan_promote(context: RotationContext & { stage: Stage }): Promise<RotationPlan> {
  const { repo_root, docs_root, stage, config } = context;
  const docs_path = format_posix_path(relative(repo_root, docs_root));
  if (stage.docs_path !== docs_path) throw new Error(`the stage was taken from ${stage.docs_path}, not ${docs_path}`);
  check_git(repo_root);
  const { cold_prefix, cold_dir } = check_cold_root(context);
  if (get_device(stage.docs_root) !== statSync(docs_root).dev) throw new Error('the stage is on a different filesystem than the docs tree');
  if (compute_tree_checksum(docs_root) !== stage.live_checksum) {
    const drifted = new Set([
      ...read_git(repo_root, ['diff', '--name-only', stage.source_commit, '--', docs_path]).split('\n'),
      ...read_git(repo_root, ['ls-files', '--others', '--exclude-standard', '--', docs_path]).split('\n'),
    ].filter(Boolean).map((file) => file.slice(docs_path.length + 1)));
    throw new Error(`the live docs changed since the stage was taken (${stage.source_commit.slice(0, 7)}); stage again.\n${drifted.size ? [...drifted].sort().slice(0, 20).map((file) => `  ${file}`).join('\n') : '  (only gitignored files changed; they are not listed)'}`);
  }
  check_clean(context, cold_prefix);
  const generation = pick_generation_name(cold_dir, config.cold_storage.map((entry) => entry.generation));
  const cold_path = `${cold_prefix}/${generation}`;
  const untracked_files = read_git(repo_root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--', docs_path]).split('\n').filter(Boolean).sort().map((file) => `${cold_path}${file.slice(docs_path.length)}`);
  return { generation, cold_path, stage_path: format_posix_path(relative(repo_root, stage.stage_dir)), docs_path, source_commit: stage.source_commit, secrets_findings: await scan_tree_secrets(docs_root, config), untracked_files };
}

/** Escape a path as an anchored .gitignore line. */
const format_ignore_line = (path_text: string): string => `/${path_text.replace(/[\\*?[\]]/g, '\\$&').replace(/^\/([!#])/, '/\\$1').replace(/ $/, '\\ ')}`;

/** Stage and commit exactly these paths (the index was verified empty); throws with git's message on failure. */
function commit_rotation(repo_root: string, message: string, paths: string[]): string {
  const live = paths.filter((path_text) => run_git(repo_root, ['check-ignore', '-q', '--', path_text]).status !== 0);
  const present = live.filter((path_text) => existsSync(join(repo_root, path_text)));
  if (present.length) read_git(repo_root, ['add', '-A', '--', ...present]);
  const gone = live.filter((path_text) => !present.includes(path_text));
  if (gone.length) read_git(repo_root, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...gone]);
  const committed = run_git(repo_root, ['commit', '-q', '-m', message]);
  if (committed.status !== 0) throw new Error(`git commit failed: ${(committed.stderr || committed.stdout).trim()}`);
  return read_git(repo_root, ['rev-parse', '--short', 'HEAD']).trim();
}

type Inverse = () => Promise<void>;
/** Run the inverses newest first; returns what could not be undone. */
async function run_inverses(inverses: Inverse[]): Promise<string[]> {
  const failures: string[] = [];
  for (const inverse of inverses.reverse()) { try { await inverse(); } catch (error) { failures.push((error as Error).message); } }
  return failures;
}
const fail_with_rollback = (error: unknown, failures: string[], hint: string): Error =>
  new Error(`${(error as Error).message}; rolled back, nothing changed${failures.length ? `. ROLLBACK ALSO FAILED (${failures.join('; ')}): ${hint}` : ''}`);

/** Rewrite (or remove, when empty) a file's text, returning the previous text or null. */
async function replace_text_file(file: string, next_text: string | null): Promise<string | null> {
  const previous = existsSync(file) ? await readFile(file, 'utf-8') : null;
  if (next_text === null) { if (previous !== null) await unlink(file); } else { await mkdir(dirname(file), { recursive: true }); await writeFile(file, next_text, 'utf-8'); }
  return previous;
}

const get_manifest = (raw_config: Record<string, unknown>): unknown[] => (Array.isArray(raw_config.cold_storage) ? raw_config.cold_storage : []);

export async function run_promote(context: RotationContext & { stage: Stage; rename?: Rename }): Promise<RotationPlan & { commit: string }> {
  const plan = await plan_promote(context);
  const { repo_root, docs_root, stage, config } = context;
  const move = context.rename ?? rename;
  const cold_dir = resolve(repo_root, plan.cold_path);
  const cold_root_dir = dirname(cold_dir);
  const generations_dir = join(cold_root_dir, '.generations', plan.generation);
  const ledger_file = resolve(repo_root, config.reconcile.ledger_path);
  const config_file = resolve_config_file_path(repo_root);
  const ignore_file = join(cold_root_dir, '.gitignore');
  const made_dirs: string[] = [];
  const ensure_dir = async (dir_path: string): Promise<void> => { const existing = find_existing_ancestor(dir_path); await mkdir(dir_path, { recursive: true }); for (let current = dir_path; current !== existing; current = dirname(current)) made_dirs.push(current); };
  const inverses: Inverse[] = [];
  try {
    await ensure_dir(cold_root_dir);
    await move(docs_root, cold_dir); inverses.push(() => rename(cold_dir, docs_root));
    await move(stage.docs_root, docs_root); inverses.push(() => rename(docs_root, stage.docs_root));
    set_tree_writable(cold_dir, false); inverses.push(async () => set_tree_writable(cold_dir, true));
    const checksum = compute_tree_checksum(cold_dir);
    if (checksum !== stage.live_checksum) throw new Error('the cold generation does not match the tree that was moved');

    const had_ledger = existsSync(ledger_file);
    if (had_ledger) { await ensure_dir(generations_dir); await copyFile(ledger_file, join(generations_dir, 'ledger.json')); inverses.push(() => unlink(join(generations_dir, 'ledger.json'))); }
    if (existsSync(stage.ledger_file)) {
      await mkdir(dirname(ledger_file), { recursive: true });
      await rename(stage.ledger_file, ledger_file);
      inverses.push(async () => { await rename(ledger_file, stage.ledger_file); if (had_ledger) await copyFile(join(generations_dir, 'ledger.json'), ledger_file); });
    }
    if (plan.untracked_files.length) {
      const previous = await replace_text_file(ignore_file, (existsSync(ignore_file) ? readFileSync(ignore_file, 'utf-8').replace(/\n?$/, '\n') : '') + plan.untracked_files.map((file) => format_ignore_line(relative(cold_root_dir, join(repo_root, file)))).join('\n') + '\n');
      inverses.push(async () => { await replace_text_file(ignore_file, previous); });
    }
    const raw_config = await load_raw_config(repo_root);
    const entry: ColdGeneration = { generation: plan.generation, path: plan.cold_path, source_commit: stage.source_commit, rotated_at: new Date().toISOString(), checksum, secrets_findings: plan.secrets_findings, untracked_files: plan.untracked_files };
    await write_raw_config(repo_root, { ...raw_config, cold_storage: [...get_manifest(raw_config), entry] });
    inverses.push(async () => { await write_raw_config(repo_root, raw_config); });
    await regenerate_indexes({ docs_root, silent: true });
    const commit = commit_rotation(repo_root, `docs(rotate): promote ${plan.stage_path} and keep ${plan.generation} cold`, [plan.docs_path, relative(repo_root, cold_root_dir), relative(repo_root, config_file), config.reconcile.ledger_path].map(format_posix_path));
    return { ...plan, commit };
  } catch (error) {
    inverses.push(async () => { run_git(repo_root, ['reset', '-q']); });
    const failures = await run_inverses(inverses);
    for (const dir_path of made_dirs) { try { await rmdir(dir_path); } catch { /* not empty or already gone: leave it */ } }
    throw fail_with_rollback(error, failures, `the previous tree is at ${plan.cold_path} and the reconciled copy at ${plan.docs_path}; swap them back by hand`);
  }
}

// ---- undo ----

async function load_generation(context: RotationContext, name: string): Promise<ColdGeneration> {
  const entry = context.config.cold_storage.find((candidate) => candidate.generation === name);
  if (!entry) throw new Error(`no cold generation named ${name}; run \`hewtd reconcile --generations\``);
  return entry;
}

function check_generation(context: RotationContext, entry: ColdGeneration): { cold_prefix: string; cold_dir: string } {
  const { repo_root, docs_root } = context;
  check_git(repo_root);
  const cold_dir = resolve(repo_root, entry.path);
  if (!existsSync(cold_dir)) throw new Error(`generation ${entry.generation} is missing from disk (${entry.path})`);
  if (compute_tree_checksum(cold_dir) !== entry.checksum) throw new Error(`generation ${entry.generation} changed since it was rotated (checksum mismatch); refusing to restore it`);
  const cold_prefix = get_cold_prefix(repo_root);
  if (!cold_prefix) throw new Error(`reconcile.cold_root (${context.config.reconcile.cold_root}) must be a repo-relative folder outside the docs tree`);
  if (get_device(join(repo_root, '.hewtd', 'stage')) !== statSync(docs_root).dev) throw new Error('.hewtd is on a different filesystem than the docs tree');
  check_clean(context, cold_prefix);
  return { cold_prefix, cold_dir };
}

/** Refusals of `--undo <gen>`, nothing changed. */
export async function plan_undo(context: RotationContext & { generation: string }): Promise<ColdGeneration> {
  const entry = await load_generation(context, context.generation);
  check_generation(context, entry);
  return entry;
}

export async function run_undo(context: RotationContext & { generation: string }): Promise<{ generation: string; rejected_stage: string; commit: string }> {
  const entry = await plan_undo(context);
  const { repo_root, docs_root, config } = context;
  const cold_dir = resolve(repo_root, entry.path);
  const cold_root_dir = dirname(cold_dir);
  const docs_path = format_posix_path(relative(repo_root, docs_root));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let rejected_dir = join(repo_root, '.hewtd', 'stage', `rejected-${stamp}`);
  for (let suffix = 2; existsSync(rejected_dir); suffix++) rejected_dir = join(repo_root, '.hewtd', 'stage', `rejected-${stamp}-${suffix}`);
  const generations_dir = join(cold_root_dir, '.generations', entry.generation);
  const generation_ledger = join(generations_dir, 'ledger.json');
  const ledger_file = resolve(repo_root, config.reconcile.ledger_path);
  const config_file = resolve_config_file_path(repo_root);
  const ignore_file = join(cold_root_dir, '.gitignore');
  const inverses: Inverse[] = [];
  try {
    set_tree_writable(cold_dir, true); inverses.push(async () => set_tree_writable(cold_dir, false));
    await mkdir(rejected_dir, { recursive: true }); inverses.push(() => rmdir(rejected_dir));
    await rename(docs_root, join(rejected_dir, 'docs')); inverses.push(() => rename(join(rejected_dir, 'docs'), docs_root));
    await rename(cold_dir, docs_root); inverses.push(() => rename(docs_root, cold_dir));
    if (existsSync(ledger_file)) { await rename(ledger_file, join(rejected_dir, 'ledger.json')); inverses.push(() => rename(join(rejected_dir, 'ledger.json'), ledger_file)); }
    if (existsSync(generation_ledger)) { await copyFile(generation_ledger, ledger_file); inverses.push(async () => { await unlink(ledger_file); }); }
    const stage_manifest: StageManifest = { format: 1, docs_path, source_commit: read_git(repo_root, ['rev-parse', 'HEAD']).trim(), staged_at: new Date().toISOString(), live_checksum: entry.checksum };
    await writeFile(join(rejected_dir, 'stage.json'), JSON.stringify(stage_manifest, null, 2) + '\n', 'utf-8'); inverses.push(() => unlink(join(rejected_dir, 'stage.json')));
    if (existsSync(generation_ledger)) {
      const kept = await readFile(generation_ledger);
      await unlink(generation_ledger);
      inverses.push(async () => { await mkdir(generations_dir, { recursive: true }); await writeFile(generation_ledger, kept); });
    }
    for (const dir_path of [generations_dir, dirname(generations_dir), cold_root_dir]) {
      try { await rmdir(dir_path); inverses.push(async () => { await mkdir(dir_path, { recursive: true }); }); } catch { break; } // only empty dirs go; a non-empty one stays
    }
    if (existsSync(ignore_file)) {
      const lines = readFileSync(ignore_file, 'utf-8').split('\n');
      const kept_lines = lines.filter((line) => !line.startsWith(`/${entry.generation}/`));
      if (kept_lines.length !== lines.length) {
        await mkdir(cold_root_dir, { recursive: true });
        const previous = await replace_text_file(ignore_file, kept_lines.join('\n').trim() ? kept_lines.join('\n') : null);
        inverses.push(async () => { await replace_text_file(ignore_file, previous); });
      }
    }
    const raw_config = await load_raw_config(repo_root);
    await write_raw_config(repo_root, { ...raw_config, cold_storage: get_manifest(raw_config).filter((item) => (item as { generation?: unknown })?.generation !== entry.generation) });
    inverses.push(async () => { await write_raw_config(repo_root, raw_config); });
    // no index regeneration: the generation's own INDEX/REGISTRY come back byte for byte
    const commit = commit_rotation(repo_root, `docs(rotate): undo ${entry.generation}`, [docs_path, format_posix_path(relative(repo_root, cold_root_dir)), relative(repo_root, config_file), config.reconcile.ledger_path].map(format_posix_path));
    return { generation: entry.generation, rejected_stage: format_posix_path(relative(repo_root, rejected_dir)), commit };
  } catch (error) {
    inverses.push(async () => { run_git(repo_root, ['reset', '-q']); });
    throw fail_with_rollback(error, await run_inverses(inverses), `generation ${entry.generation} is at ${entry.path} or at ${docs_path}, the rejected tree at ${relative(repo_root, rejected_dir)}/docs`);
  }
}

// ---- generations ----

export interface GenerationRow { generation: string; path: string; rotated_at: string; checksum: string; status: 'ok' | 'CHANGED' | 'MISSING'; secrets_findings: number; untracked_files: number }

/** Each recorded generation with whether its tree still matches its recorded checksum. */
export function list_generations(repo_root: string, cold_storage: ColdGeneration[]): GenerationRow[] {
  return cold_storage.map((entry) => {
    const dir_path = resolve(repo_root, entry.path);
    const status = !existsSync(dir_path) ? 'MISSING' : compute_tree_checksum(dir_path) === entry.checksum ? 'ok' : 'CHANGED';
    return { generation: entry.generation, path: entry.path, rotated_at: entry.rotated_at, checksum: entry.checksum, status, secrets_findings: entry.secrets_findings.length, untracked_files: entry.untracked_files.length };
  });
}
