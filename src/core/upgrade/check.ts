import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { dirname, join, relative } from 'path';
import { spawnSync } from 'child_process';
import { parse as parse_yaml } from 'yaml';
import { load_plugin_config_sync, write_raw_config, resolve_config_file_path, resolve_docs_root } from '../../utils/config.js';
import { partial_metadata_schema } from '../metadata/schema.js';
import { BLOCK, START, install_hook, resolve_hook_path } from '../reconcile/hooks.js';
import { FIRST_NOTED_VERSION, compare_versions, list_crossed_versions, load_upgrade_notes, type UpgradeNotes } from './notes.js';

const PACKAGE_NAME = '@theglitchking/hit-em-with-the-docs';
const PLUGIN_NAME = 'hit-em-with-the-docs';

export interface UpgradeCheckOptions {
  repo_root: string;
  installed_version: string;
  package_root: string;
  /** Home directory searched for the plugin cache and the npx cache. */
  home_dir: string;
  /** `npm root -g`, or null when there is no global npm. */
  npm_root: string | null;
  /** Overrides `last_upgrade_check` from the plugin config. */
  recorded_version?: string | null;
  fix?: boolean;
  /** Record `last_upgrade_check` now, after a human handled the remaining items. */
  record?: boolean;
}
export interface UpgradeCopy { kind: 'plugin' | 'global' | 'npx' | 'node_modules'; path: string; version: string; used_by: string[]; superseded?: boolean }
export interface UpgradeItem { id: string; status: 'ok' | 'info' | 'action'; title: string; detail: string[]; fixable: boolean }
export interface UpgradeDrift { file: string; line: number; issue: number; release: string; note: string; text: string }
export interface UpgradeReport {
  installed_version: string;
  recorded_version: string | null;
  crossed: string[];
  notes: string[];
  copies: UpgradeCopy[];
  items: UpgradeItem[];
  drift: UpgradeDrift[];
  fixed: string[];
  recorded: boolean;
}

function read_version(path: string): string | null {
  try { return (JSON.parse(readFileSync(path, 'utf8')) as { version?: string }).version ?? null; } catch { return null; }
}
function list_dirs(path: string): string[] {
  try { return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return []; }
}

function list_copies(options: UpgradeCheckOptions): UpgradeCopy[] {
  const found: Array<Omit<UpgradeCopy, 'used_by'>> = [];
  const add = (kind: UpgradeCopy['kind'], path: string, version: string | null): void => { if (version) found.push({ kind, path, version }); };
  const node_modules = join(options.repo_root, 'node_modules', PACKAGE_NAME);
  add('node_modules', node_modules, read_version(join(node_modules, 'package.json')));
  if (options.npm_root) add('global', join(options.npm_root, PACKAGE_NAME), read_version(join(options.npm_root, PACKAGE_NAME, 'package.json')));
  const npx_cache = join(options.home_dir, '.npm/_npx');
  for (const hash of list_dirs(npx_cache)) add('npx', join(npx_cache, hash, 'node_modules', PACKAGE_NAME), read_version(join(npx_cache, hash, 'node_modules', PACKAGE_NAME, 'package.json')));
  const plugin_cache = join(options.home_dir, '.claude/plugins/cache');
  for (const marketplace of list_dirs(plugin_cache)) for (const plugin of list_dirs(join(plugin_cache, marketplace)).filter((name) => name.startsWith(PLUGIN_NAME))) {
    const versions = list_dirs(join(plugin_cache, marketplace, plugin)).map((name) => {
      const dir = join(plugin_cache, marketplace, plugin, name);
      return { dir, version: read_version(join(dir, '.claude-plugin/plugin.json')) ?? (/^\d+\.\d+\.\d+$/.test(name) ? name : null) };
    }).filter((entry): entry is { dir: string; version: string } => entry.version !== null).sort((a, b) => compare_versions(b.version, a.version));
    // Claude Code keeps earlier versions next to the active one; only the newest is in use
    versions.forEach((entry, index) => found.push({ kind: 'plugin', path: entry.dir, version: entry.version, ...(index > 0 && { superseded: true }) }));
  }
  // `npx --no-install hewtd` (the git hook) and `npx --no <pkg>` (the commands) take repo node_modules, else the PATH install.
  const invoked = found.some((copy) => copy.kind === 'node_modules') ? 'node_modules' : 'global';
  return found.map((copy) => ({ ...copy, used_by: copy.kind === invoked ? ['git hook', 'slash commands'] : copy.kind === 'plugin' && !copy.superseded ? ['plugin skills and hooks'] : [] }));
}

function check_skew(copies: UpgradeCopy[], installed: string): UpgradeItem {
  const skewed = copies.filter((copy) => !copy.superseded && copy.version !== installed);
  const detail = copies.map((copy) => `${copy.kind} ${copy.version}${copy.superseded ? ' (old plugin cache, unused)' : copy.version === installed ? '' : ' (differs)'} at ${copy.path}${copy.used_by.length ? `, used by: ${copy.used_by.join(', ')}` : ''}`);
  const no_runnable = !copies.some((copy) => copy.used_by.includes('git hook'));
  if (no_runnable) detail.push('no repo or global copy found: `npx --no-install hewtd` in the git hook would fail');
  if (skewed.length) detail.push(`update the copies that differ from the running ${installed} (the plugin cache, \`npm -g\`, the npx cache and node_modules are updated separately)`);
  if (skewed.length) return { id: 'version-skew', status: 'action', title: `${skewed.length} copy(ies) of hewtd differ from ${installed}`, detail, fixable: false };
  return { id: 'version-skew', status: no_runnable ? 'info' : 'ok', title: no_runnable ? 'no repo or global copy of hewtd found' : `hewtd copies agree on ${installed}`, detail, fixable: false };
}

function get_nested(data: Record<string, unknown>, key: string): unknown {
  let node: unknown = data;
  for (const part of key.split('.')) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
  return node;
}
function set_nested(data: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let node = data;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== 'object' || Array.isArray(node[part])) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts.at(-1)!] = value;
}

/** The plugin config as written, and why it cannot be read when it exists but is not a JSON object (never rewritten then). */
function read_config_state(repo_root: string): { data: Record<string, unknown>; error: string | null } {
  let text: string;
  try { text = readFileSync(resolve_config_file_path(repo_root), 'utf8'); } catch { return { data: {}, error: null }; }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { data: parsed as Record<string, unknown>, error: null };
    return { data: {}, error: 'it is not a JSON object' };
  } catch (error) { return { data: {}, error: (error as Error).message }; }
}

function check_config_keys(options: UpgradeCheckOptions, notes: UpgradeNotes, crossed: string[]): UpgradeItem[] {
  const { data: config_data, error } = read_config_state(options.repo_root);
  const seen = new Set<string>();
  const items: UpgradeItem[] = error ? [{ id: 'config-file', status: 'action', fixable: false, title: `${relative(options.repo_root, resolve_config_file_path(options.repo_root))} is not valid JSON, so hewtd ignores it`, detail: [error, 'fix it by hand (comments and trailing commas are not allowed); --fix and --record never write to it while it is broken'] }] : [];
  for (const version of crossed) for (const entry of notes[version]!.config_keys) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    const is_set = get_nested(config_data, entry.key) !== undefined;
    items.push({
      id: `config:${entry.key}`, status: is_set ? 'ok' : 'info', fixable: !is_set && !error,
      title: is_set ? `${entry.key} is set` : `${entry.key} is not set (added in ${version})`,
      detail: [`${entry.note}`, `default: ${JSON.stringify(entry.default)}${is_set ? '' : ' (applies until you set it; --fix writes it)'}`],
    });
  }
  for (const version of crossed) for (const entry of notes[version]!.changed_defaults) {
    items.push({ id: `default:${entry.key}`, status: 'info', fixable: false, title: `${entry.key} default changed in ${version}`, detail: [`${JSON.stringify(entry.from)} -> ${JSON.stringify(entry.to)}: ${entry.note}`] });
  }
  return items;
}

function check_hook(options: UpgradeCheckOptions, notes: UpgradeNotes, crossed: string[]): UpgradeItem {
  let path: string;
  try { path = resolve_hook_path(options.repo_root); } catch { return { id: 'hook', status: 'info', title: 'not a git repository: no pre-commit hook to check', detail: [], fixable: false }; }
  let current: string | null = null;
  try { current = readFileSync(path, 'utf8'); } catch { /* absent */ }
  const shown = relative(options.repo_root, path);
  const hook_note = crossed.map((version) => notes[version]!.hook_block).filter(Boolean);
  if (current?.includes(START)) {
    if (current.includes(BLOCK)) return { id: 'hook', status: 'ok', title: `pre-commit block is current (${shown})`, detail: [], fixable: false };
    return { id: 'hook', status: 'action', fixable: true, title: `pre-commit block is out of date (${shown})`, detail: [...hook_note.map(String), '`hewtd hooks install` (or --fix) upgrades it in place'] };
  }
  // eslint-disable-next-line id-denylist -- child_process option name
  const custom = spawnSync('git', ['config', 'core.hooksPath'], { cwd: options.repo_root, encoding: 'utf8' }).stdout.trim();
  return {
    id: 'hook', status: custom ? 'action' : 'info', fixable: false,
    title: custom ? `pre-commit block missing: this repo uses its own hooks path (${custom})` : 'pre-commit block not installed (opt-in)',
    detail: [...hook_note.map(String), `add these lines to ${shown}${custom ? '' : ' (or run `hewtd hooks install`)'}:`, ...BLOCK.trimEnd().split('\n').map((line) => `  ${line}`)],
  };
}

function list_skill_links(repo_root: string): Array<{ name: string; source: string; dest: string; stale: boolean }> {
  const skills_source = join(repo_root, 'node_modules', PACKAGE_NAME, 'skills');
  return list_dirs(skills_source).filter((name) => !name.endsWith('-workspace')).map((name) => {
    const source = join(skills_source, name);
    const dest = join(repo_root, '.claude/skills', name);
    let stale = false;
    if (!path_exists(dest)) stale = true;
    else if (lstatSync(dest).isSymbolicLink()) { try { stale = realpathSync(dest) !== realpathSync(source); } catch { stale = true; } } // a real directory is the user's: left alone
    return { name, source, dest, stale };
  });
}
function path_exists(path: string): boolean { try { lstatSync(path); return true; } catch { return false; } }

function check_skills(repo_root: string): UpgradeItem {
  const links = list_skill_links(repo_root);
  const stale = links.filter((link) => link.stale);
  if (!links.length) return { id: 'skills', status: 'ok', title: 'no repo-installed skills to link (plugin installs link their own)', detail: [], fixable: false };
  return { id: 'skills', status: stale.length ? 'action' : 'ok', fixable: stale.length > 0, title: stale.length ? 'skill symlinks are missing or stale' : 'skill symlinks point at the installed package', detail: stale.map((link) => `.claude/skills/${link.name}: run \`/hit-em-with-the-docs:relink\` (or --fix)`) };
}

function fix_skills(repo_root: string): string[] {
  const done: string[] = [];
  for (const link of list_skill_links(repo_root).filter((entry) => entry.stale)) {
    mkdirSync(dirname(link.dest), { recursive: true });
    if (path_exists(link.dest)) rmSync(link.dest, { force: true });
    symlinkSync(relative(dirname(link.dest), link.source), link.dest, 'dir');
    done.push(`relinked .claude/skills/${link.name}`);
  }
  return done;
}

function check_template(options: UpgradeCheckOptions, notes: UpgradeNotes, crossed: string[]): UpgradeItem {
  const docs_root = resolve_docs_root(options.repo_root, load_plugin_config_sync(options.repo_root));
  const shipped = readFileSync(join(options.package_root, 'templates/doc.template.md'), 'utf8');
  const found = [join(docs_root, 'templates/doc.template.md'), join(options.repo_root, 'templates/doc.template.md'), join(options.repo_root, '.claude/templates/doc.template.md')].find(existsSync);
  if (!found) return { id: 'template', status: 'ok', title: 'the repo keeps no doc.template.md', detail: [], fixable: false };
  const shown = relative(options.repo_root, found);
  if (readFileSync(found, 'utf8') === shipped) return { id: 'template', status: 'ok', title: `${shown} matches the shipped template`, detail: [], fixable: false };
  const changed = crossed.map((version) => notes[version]!.template_changes).filter(Boolean);
  return { id: 'template', status: changed.length ? 'action' : 'info', fixable: false, title: `${shown} differs from templates/doc.template.md`, detail: [...changed.map(String), `compare with ${join(options.package_root, 'templates/doc.template.md')}; this file is never overwritten`] };
}

const SCHEMA_FILES = ['vault.schema.yml', 'vault.schema.yaml', '.claude/vault.schema.yml', '.vault/vault.schema.yml', '.claude/.vault/vault.schema.yml'];
function list_schema_fields(path: string): string[] {
  const data = parse_yaml(readFileSync(path, 'utf8')) as unknown;
  const root = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const fields = root.fields ?? root.properties ?? root.frontmatter ?? root;
  if (Array.isArray(fields)) return fields.map((field) => (typeof field === 'string' ? field : String((field as { name?: string; key?: string }).name ?? (field as { key?: string }).key ?? '')));
  return fields && typeof fields === 'object' ? Object.keys(fields) : [];
}
function check_schema(repo_root: string): UpgradeItem {
  const found = SCHEMA_FILES.map((file) => join(repo_root, file)).find(existsSync);
  if (!found) return { id: 'frontmatter-schema', status: 'info', fixable: false, title: 'no vault.schema.yml found', detail: ['if another tool mirrors the hewtd frontmatter contract, check its schema against src/core/metadata/schema.ts by hand'] };
  const contract = Object.keys(partial_metadata_schema.shape);
  let fields: string[];
  try { fields = list_schema_fields(found); } catch (error) { return { id: 'frontmatter-schema', status: 'action', fixable: false, title: `${relative(repo_root, found)} is not readable YAML`, detail: [(error as Error).message] }; }
  const missing = contract.filter((key) => !fields.includes(key));
  const extra = fields.filter((key) => !contract.includes(key));
  const shown = relative(repo_root, found);
  if (!missing.length && !extra.length) return { id: 'frontmatter-schema', status: 'ok', title: `${shown} matches the frontmatter contract`, detail: [], fixable: false };
  return { id: 'frontmatter-schema', status: missing.length ? 'action' : 'info', fixable: false, title: `${shown} differs from hewtd's frontmatter contract`, detail: [`missing: ${missing.join(', ') || 'none'}`, `extra: ${extra.join(', ') || 'none'}`] };
}

function list_instruction_files(repo_root: string): string[] {
  const files = ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md'].filter((file) => existsSync(join(repo_root, file)));
  try { for (const file of readdirSync(join(repo_root, '.claude/rules'), { recursive: true, encoding: 'utf8' })) if (file.endsWith('.md')) files.push(`.claude/rules/${file.split('\\').join('/')}`); } catch { /* none */ }
  return files;
}

function scan_drift(repo_root: string, notes: UpgradeNotes, crossed: string[]): UpgradeDrift[] {
  const found: UpgradeDrift[] = [];
  for (const file of list_instruction_files(repo_root)) {
    readFileSync(join(repo_root, file), 'utf8').split('\n').forEach((text, index) => {
      for (const release of crossed) for (const change of notes[release]!.behaviour_changes) {
        if (!change.patterns.some((pattern) => new RegExp(pattern, 'i').test(text))) continue;
        if (found.some((entry) => entry.file === file && entry.line === index + 1 && entry.issue === change.issue && entry.release === release)) continue;
        found.push({ file, line: index + 1, issue: change.issue, release, note: change.note, text: text.trim().slice(0, 120) });
      }
    });
  }
  return found;
}

async function collect(options: UpgradeCheckOptions, notes: UpgradeNotes, recorded: string | null): Promise<Omit<UpgradeReport, 'fixed' | 'recorded'>> {
  const crossed = list_crossed_versions(notes, recorded, options.installed_version);
  const copies = list_copies(options);
  const drift = scan_drift(options.repo_root, notes, crossed);
  const messages = recorded === null ? [`no recorded version (last_upgrade_check is unset): reading release notes from ${FIRST_NOTED_VERSION}, the first release they cover; older releases have no notes`] : [];
  const items: UpgradeItem[] = [
    check_skew(copies, options.installed_version),
    ...check_config_keys(options, notes, crossed),
    check_hook(options, notes, crossed),
    check_skills(options.repo_root),
    check_template(options, notes, crossed),
    check_schema(options.repo_root),
    { id: 'instruction-drift', status: drift.length ? 'action' : 'ok', fixable: false, title: drift.length ? `${drift.length} instruction line(s) name commands whose behaviour changed` : 'no instruction drift found', detail: drift.map((entry) => `${entry.file}:${entry.line} (#${entry.issue}, ${entry.release}): ${entry.note}`) },
  ];
  return { installed_version: options.installed_version, recorded_version: recorded, crossed, notes: messages, copies, items, drift };
}

/** Compares the repo with the installed hewtd. Read-only unless `fix`, which applies only the safe items. */
export async function run_upgrade_check(options: UpgradeCheckOptions): Promise<UpgradeReport> {
  const notes = load_upgrade_notes(options.package_root);
  const config_state = read_config_state(options.repo_root);
  const recorded = options.recorded_version !== undefined ? options.recorded_version : typeof config_state.data.last_upgrade_check === 'string' ? config_state.data.last_upgrade_check : null;
  const first = await collect(options, notes, recorded);
  const record = async (report: Omit<UpgradeReport, 'fixed' | 'recorded'>, fixed: string[]): Promise<UpgradeReport> => {
    const latest = read_config_state(options.repo_root);
    if (latest.error || compare_versions(options.installed_version, recorded ?? FIRST_NOTED_VERSION) < 0) return { ...report, fixed, recorded: false };
    if (recorded !== options.installed_version) {
      latest.data.last_upgrade_check = options.installed_version;
      await write_raw_config(options.repo_root, latest.data);
      fixed.push(`recorded last_upgrade_check ${options.installed_version}`);
    }
    return { ...report, fixed, recorded: true };
  };
  if (!options.fix) return options.record ? record(first, []) : { ...first, fixed: [], recorded: false };

  const fixed: string[] = [];
  const config = config_state.data;
  let config_changed = false;
  for (const entry of first.items.filter((candidate) => candidate.id.startsWith('config:') && candidate.fixable)) {
    const key = entry.id.slice('config:'.length);
    const default_value = first.crossed.flatMap((version) => notes[version]!.config_keys).find((candidate) => candidate.key === key)!.default;
    set_nested(config, key, default_value);
    fixed.push(`set ${key} to ${JSON.stringify(default_value)}`);
    config_changed = true;
  }
  if (first.items.find((entry) => entry.id === 'hook')?.fixable) { const result = await install_hook(options.repo_root); fixed.push(`upgraded the hewtd block in ${relative(options.repo_root, result.path)}`); }
  fixed.push(...fix_skills(options.repo_root));
  if (config_changed) await write_raw_config(options.repo_root, config);

  const after = await collect(options, notes, recorded);
  // --fix records only when nothing is left for a human, so the crossed releases' items stay listed; --record acknowledges them
  const clear = !after.items.some((entry) => entry.status === 'action');
  return clear || options.record ? record(after, fixed) : { ...after, fixed, recorded: false };
}

/** Plain-text checklist for the terminal. */
export function format_report(report: UpgradeReport): string {
  const lines = [`hewtd upgrade-check: ${report.recorded_version ?? 'unrecorded'} -> ${report.installed_version}${report.crossed.length ? ` (notes: ${report.crossed.join(', ')})` : ''}`, ...report.notes.map((note) => `note: ${note}`), ''];
  const mark = { ok: '[ok]', info: '[info]', action: '[action]' } as const;
  for (const entry of report.items) {
    lines.push(`${mark[entry.status]} ${entry.title}${entry.fixable && entry.status !== 'ok' ? ' (--fix)' : ''}`, ...entry.detail.map((line) => `      ${line}`));
  }
  if (report.fixed.length) lines.push('', 'fixed:', ...report.fixed.map((line) => `  ${line}`));
  const open = report.items.filter((entry) => entry.status === 'action').length;
  lines.push('', open ? `${open} item(s) need action.${report.recorded ? '' : ' Once a human has handled them, `hewtd upgrade-check --record` records this version so later runs start after it.'}` : 'Nothing needs action.');
  return lines.join('\n');
}
