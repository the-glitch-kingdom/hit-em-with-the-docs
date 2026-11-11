/**
 * `reconcile --finish` (#106): inventory what a reconcile leaves behind and clean up the safe part.
 * Read-only unless asked. Values from `.env.hewtd` are held in memory only; output carries names, paths and sizes.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { spawnSync } from 'child_process';
import { load_plugin_config, resolve_config_file_path, write_raw_config, type PluginConfig } from '../../utils/config.js';
import { BASELINE_PATH } from './secrets.js';

const ENV = '.env.hewtd';
const MIN_VALUE_LENGTH = 8; // shorter values are ordinary words; redacting them would damage the review text

export interface FinishKey { name: string; rotated: boolean; rotated_on?: string }
export interface FinishStage { path: string; size: number; kind: 'rejected' | 'promoted' | 'open'; source_commit: string | null }
export interface FinishReport {
  credentials: { exists: boolean; size: number; mode: string; tracked: boolean; keys: FinishKey[]; not_rotated: string[] };
  stages: FinishStage[];
  review_files: { count: number; size: number; with_secrets: string[] };
  secrets_reports: { count: number; size: number };
  graph: Array<{ path: string; size: number; removable: boolean }>;
  git: { unignored: string[]; add_lines: string[] };
  actions: string[];
}

// eslint-disable-next-line id-denylist -- child_process option name
const run_git = (repo_root: string, args: string[]) => spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: repo_root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const format_posix_path = (path_text: string): string => path_text.split('\\').join('/');

function get_size(path: string): number {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory()) return info.size;
    return readdirSync(path).reduce((sum, name) => sum + get_size(join(path, name)), 0);
  } catch { return 0; }
}

export function format_size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function load_environment(repo_root: string): Map<string, string> {
  const found = new Map<string, string>();
  let text: string;
  try { text = readFileSync(join(repo_root, ENV), 'utf-8'); } catch { return found; }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { /* keep raw */ } }
    else if (/^'.*'$/.test(value)) value = value.slice(1, -1);
    found.set(match[1]!, value);
  }
  return found;
}

/** A real directory, not a symlink to one: --finish never reads, rewrites or removes through a link (it may lead outside the repo). */
function is_real_dir(path: string): boolean {
  try { const info = lstatSync(path); return info.isDirectory() && !info.isSymbolicLink(); } catch { return false; }
}
const is_tracked = (repo_root: string, file: string): boolean => run_git(repo_root, ['ls-files', '--', format_posix_path(file)]).stdout.trim() !== '';

/** A hewtd stage manifest (what `--stage` writes and `load_stage` accepts): its source commit, or undefined when it is not one. */
function read_stage_manifest(dir: string): { source_commit: string | null } | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'stage.json'), 'utf-8')) as { format?: unknown; docs_path?: unknown; source_commit?: unknown };
    if (manifest.format !== 1 || typeof manifest.docs_path !== 'string') return undefined;
    return { source_commit: typeof manifest.source_commit === 'string' ? manifest.source_commit : null };
  } catch { return undefined; }
}

/**
 * Stages hewtd made: directories under `.hewtd/` (two levels: `.hewtd/<name>`, `.hewtd/stage/<name>`) holding a valid stage
 * manifest and no git-tracked file. Never the repo root, never anything elsewhere: --confirm deletes what this returns.
 */
function list_stage_dirs(repo_root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: import('fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue; // a symlink is not a directory entry here: never followed
      const child = join(dir, entry.name);
      if (read_stage_manifest(child)) { if (!is_tracked(repo_root, relative(repo_root, child))) found.push(child); }
      else if (depth < 1) walk(child, depth + 1);
    }
  };
  if (is_real_dir(join(repo_root, '.hewtd'))) walk(join(repo_root, '.hewtd'), 0);
  return found;
}

/** rejected (made by --undo), promoted (its docs are live now) or open: in progress, or abandoned, which hewtd cannot tell apart, so never removed. */
function classify_stage(dir: string): FinishStage['kind'] {
  if (/^rejected-/.test(dir.split(/[\\/]/).pop()!)) return 'rejected';
  return existsSync(join(dir, 'docs')) ? 'open' : 'promoted';
}

/** Review files hewtd wrote: `.hewtd/reconcile/review-*.md` and each stage's `reconcile/review-*.md` (repo-relative). */
function list_review_files(repo_root: string, stage_dirs: string[]): string[] {
  return [...(is_real_dir(join(repo_root, '.hewtd')) ? [join(repo_root, '.hewtd', 'reconcile')] : []), ...stage_dirs.map((dir) => join(dir, 'reconcile'))]
    .flatMap((dir) => (is_real_dir(dir) ? readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && /^review-.*\.md$/.test(entry.name)).map((entry) => format_posix_path(relative(repo_root, join(dir, entry.name)))) : [])); // regular files only: a symlink is never read through
}


export async function build_finish_report(options: { repo_root: string; config?: PluginConfig }): Promise<FinishReport> {
  const { repo_root } = options;
  const config = options.config ?? await load_plugin_config(repo_root);
  const rotated = new Map((config.reconcile.secrets.rotated ?? []).map((item) => [item.env, item.rotated_on]));
  const environment = load_environment(repo_root);
  const env_path = join(repo_root, ENV);
  const env_exists = existsSync(env_path);
  const keys: FinishKey[] = [...environment.keys()].map((name) => ({ name, rotated: rotated.has(name), ...(rotated.has(name) && { rotated_on: rotated.get(name)! }) }));
  const env_tracked = env_exists && run_git(repo_root, ['ls-files', '--error-unmatch', ENV]).status === 0;

  const stage_dirs = list_stage_dirs(repo_root);
  const stages = stage_dirs.map((dir): FinishStage => ({ path: format_posix_path(relative(repo_root, dir)), size: get_size(dir), kind: classify_stage(dir), source_commit: read_stage_manifest(dir)!.source_commit }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  const reconcile_dir = join(repo_root, '.hewtd', 'reconcile');
  const reports = (is_real_dir(reconcile_dir) && is_real_dir(join(repo_root, '.hewtd')) ? readdirSync(reconcile_dir) : []).filter((name) => /^secrets-report-.*\.md$/.test(name));
  const reviews = list_review_files(repo_root, stage_dirs);
  const with_secrets = reviews.filter((file) => list_quoted_values(readFileSync(join(repo_root, file), 'utf-8'), environment).length);

  const graph = ['.hewtd/graph.json', '.hewtd/graph-cache.json'].filter((file) => existsSync(join(repo_root, file))).map((file) => ({ path: file, size: get_size(join(repo_root, file)), removable: file.endsWith('cache.json') }));

  const kept = new Set([format_posix_path(config.reconcile.ledger_path), BASELINE_PATH]); // hewtd means these to be committed
  const status = run_git(repo_root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.hewtd', ENV]).stdout.split('\0').filter((entry) => entry.startsWith('?? ')).map((entry) => entry.slice(3));
  const unignored = status.filter((file) => !kept.has(file));
  // the whole folder, so files hewtd writes later (graph, caches, stages) are covered too; the kept files stay visible
  const add_lines = unignored.length ? [...(unignored.some((file) => file.startsWith('.hewtd/')) ? ['.hewtd/*', ...[...kept].filter((file) => file.startsWith('.hewtd/')).flatMap(list_negation_lines)] : []), ...(unignored.includes(ENV) ? [ENV] : [])] : [];

  return {
    credentials: { exists: env_exists, size: env_exists ? get_size(env_path) : 0, mode: env_exists ? (statSync(env_path).mode & 0o777).toString(8) : '', tracked: env_tracked, keys, not_rotated: keys.filter((key) => !key.rotated).map((key) => key.name) },
    stages,
    review_files: { count: reviews.length, size: reviews.reduce((sum, file) => sum + get_size(join(repo_root, file)), 0), with_secrets },
    secrets_reports: { count: reports.length, size: reports.reduce((sum, name) => sum + get_size(join(reconcile_dir, name)), 0) },
    graph, git: { unignored, add_lines }, actions: [],
  };
}

/** `!` lines that keep one file visible under `.hewtd/*`: git cannot re-include a file whose parent folder is excluded, so each folder on the way is re-included and its other contents excluded again. */
function list_negation_lines(file: string): string[] {
  const parts = file.split('/');
  const lines: string[] = [];
  for (let i = 2; i < parts.length; i++) { const folder = parts.slice(0, i).join('/'); lines.push(`!${folder}/`, `${folder}/*`); }
  return [...lines, `!${file}`];
}

/** Env values (long enough to be meaningful) that a review text quotes, plain or JSON-escaped, found (the env value is the thing fingerprints are made from). */
function list_quoted_values(text: string, environment: Map<string, string>): Array<{ name: string; value: string; escaped: string }> {
  const found: Array<{ name: string; value: string; escaped: string }> = [];
  for (const [name, value] of environment) {
    if (value.length < MIN_VALUE_LENGTH) continue;
    const escaped = JSON.stringify(value).slice(1, -1);
    if (text.includes(value) || text.includes(escaped)) found.push({ name, value, escaped });
  }
  return found.sort((a, b) => b.value.length - a.value.length); // longest first, so a value inside another is not cut
}

/** Records `{env, rotated_on}` (names only) in the plugin config; refuses a config that is not a JSON object. Returns names not in .env.hewtd. */
export async function record_rotated(repo_root: string, names: string[], today = new Date().toISOString().slice(0, 10)): Promise<{ unknown_names: string[] }> {
  for (const name of names) if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`not an environment variable name: ${JSON.stringify(name)}`);
  const file = resolve_config_file_path(repo_root);
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(file, 'utf-8')); } catch { throw new Error(`${relative(repo_root, file)} is not valid JSON; fix it by hand, hewtd never rewrites a broken config`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${relative(repo_root, file)} is not a JSON object; fix it by hand`);
    data = parsed as Record<string, unknown>;
  }
  const reconcile = { ...(data.reconcile as Record<string, unknown> | undefined) };
  const secrets = { ...(reconcile.secrets as Record<string, unknown> | undefined) };
  // eslint-disable-next-line id-denylist -- serialized key (plugin config)
  const existing = Array.isArray(secrets.rotated) ? (secrets.rotated as Array<{ env?: unknown }>) : [];
  // eslint-disable-next-line id-denylist -- serialized key (plugin config)
  secrets.rotated = [...existing.filter((item) => !names.includes(item?.env as string)), ...names.map((name) => ({ env: name, rotated_on: today }))];
  await write_raw_config(repo_root, { ...data, reconcile: { ...reconcile, secrets } });
  const environment = load_environment(repo_root);
  return { unknown_names: names.filter((name) => !environment.has(name)) };
}

/** Replaces env values quoted in review files with their env pointer; returns the redacted files (repo-relative). */
export function redact_review_files(repo_root: string): string[] {
  const environment = load_environment(repo_root);
  const done: string[] = [];
  for (const review_file of list_review_files(repo_root, list_stage_dirs(repo_root))) {
    const file = join(repo_root, review_file);
    let text = readFileSync(file, 'utf-8');
    const quoted = list_quoted_values(text, environment);
    if (!quoted.length) continue;
    // one pass, longest first: a value that also occurs in a placeholder never rewrites an inserted placeholder
    const owner = new Map<string, string>();
    for (const { name: env_name, value, escaped } of quoted) for (const form of [value, escaped]) if (!owner.has(form)) owner.set(form, env_name);
    const forms = [...owner.keys()].sort((a, b) => b.length - a.length);
    text = text.replace(new RegExp(forms.map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'), (found) => `<secret: ${owner.get(found)}, see ${ENV}>`);
    writeFileSync(file, text);
    done.push(review_file);
  }
  return done;
}

/** Appends the missing ignore lines to the root .gitignore and checks they took effect; returns the lines added. */
export function add_ignore_lines(repo_root: string, lines: string[]): string[] {
  if (!lines.length) return [];
  const path = join(repo_root, '.gitignore');
  const current = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const have = new Set(current.split('\n').map((line) => line.trim()));
  // git's last matching line wins, so when `.hewtd/*` is new its `!` lines go after it even if the file already has them
  const fresh = lines.filter((line) => !have.has(line) || (!have.has('.hewtd/*') && line.startsWith('!.hewtd/')) || (!have.has('.hewtd/*') && /^\.hewtd\/.+\/\*$/.test(line)));
  if (!fresh.length) return [];
  writeFileSync(path, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${fresh.join('\n')}\n`);
  return fresh;
}

/** Removes rejected and promoted stages, the graph cache and the review files `redacted` in this run. Never an open stage, .env.hewtd, graph.json, cold generations or anything under the docs tree. */
export function remove_leftovers(repo_root: string, report: FinishReport, redacted: string[]): string[] {
  const removed: string[] = [];
  for (const file of redacted) if (file.startsWith('.hewtd/reconcile/review-') && !is_tracked(repo_root, file)) { rmSync(join(repo_root, file), { force: true }); removed.push(file); }
  for (const stage of report.stages) if (stage.kind === 'rejected' || stage.kind === 'promoted') { rmSync(join(repo_root, stage.path), { recursive: true, force: true }); removed.push(stage.path); }
  for (const item of report.graph) if (item.removable) { rmSync(join(repo_root, item.path), { force: true }); removed.push(item.path); }
  return removed;
}

export function format_finish_report(report: FinishReport): string {
  const lines: string[] = ['hewtd reconcile --finish (read-only unless --fix or --confirm)', ''];
  lines.push('Credentials');
  if (!report.credentials.exists) lines.push('  no .env.hewtd');
  else {
    lines.push(`  ${ENV} (${format_size(report.credentials.size)}, mode ${report.credentials.mode}): ${report.credentials.keys.length} key(s), the only copy the doc pointers resolve to; never deleted by hewtd`);
    for (const key of report.credentials.keys) lines.push(`    ${key.name}  ${key.rotated ? `rotated ${key.rotated_on}` : 'NOT rotated'}`);
    if (report.credentials.tracked) lines.push(`  WARNING: ${ENV} is tracked by git; remove it from the index and ignore it`);
    if (report.credentials.not_rotated.length) lines.push('  recommendation: rotate each credential that is not marked, move it to your secret store, then `hewtd reconcile --finish --rotated <ENV_NAME>` and delete its line by hand');
  }
  lines.push('', 'Stages');
  if (!report.stages.length) lines.push('  none');
  const advice = { rejected: '--confirm removes it', promoted: 'consumed by a promote (its docs are live); --confirm removes it', open: 'in progress or abandoned (hewtd cannot tell); kept: remove it by hand once you are done with it' } as const;
  for (const stage of report.stages) lines.push(`  ${stage.path} (${format_size(stage.size)}) ${stage.kind}, source ${stage.source_commit?.slice(0, 7) ?? 'unknown'}: ${advice[stage.kind]}`);
  lines.push('', 'Review files');
  lines.push(`  ${report.review_files.count} review file(s) (${format_size(report.review_files.size)}); ${report.review_files.with_secrets.length} quote a secret-lane value${report.review_files.with_secrets.length ? ' (--fix redacts them in place)' : ''}`);
  for (const file of report.review_files.with_secrets) lines.push(`    ${file}`);
  lines.push(`  ${report.secrets_reports.count} secrets report(s) (${format_size(report.secrets_reports.size)}), masked: safe to keep or delete by hand`);
  lines.push('', 'Graph');
  if (!report.graph.length) lines.push('  none');
  for (const item of report.graph) lines.push(`  ${item.path} (${format_size(item.size)})${item.removable ? ': --confirm removes it, the next run rebuilds it' : ': kept (rebuilt by `hewtd graph`)'}`);
  lines.push('', 'Git hygiene');
  if (!report.git.unignored.length) lines.push('  every hewtd working file is ignored or meant to be tracked');
  else {
    lines.push(`  ${report.git.unignored.length} hewtd working file(s) are not git-ignored; one \`git add -A\` would commit them. --fix adds:`);
    for (const line of report.git.add_lines) lines.push(`    ${line}`);
  }
  if (report.actions.length) lines.push('', 'Done', ...report.actions.map((line) => `  ${line}`));
  return lines.join('\n');
}
