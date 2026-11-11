import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, lstatSync, symlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { run_upgrade_check, type UpgradeReport } from '../../src/core/upgrade/check';
import { load_upgrade_notes, list_crossed_versions, compare_versions } from '../../src/core/upgrade/notes';

const package_root = resolve(__dirname, '../..');
const package_name = '@theglitchking/hit-em-with-the-docs';
let root: string;
let home: string;
let npm_root: string;

const write = (path: string, text: string): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
const fake_copy = (dir: string, version: string): void => write(join(dir, 'package.json'), JSON.stringify({ name: package_name, version }));
const config_path = (): string => join(root, '.claude/hit-em-with-the-docs.json');
const check = (options: Partial<Parameters<typeof run_upgrade_check>[0]> = {}): Promise<UpgradeReport> =>
  run_upgrade_check({ repo_root: root, installed_version: '3.2.1', package_root, home_dir: home, npm_root, ...options });
const item = (report: UpgradeReport, id: string) => report.items.find((entry) => entry.id === id)!;
const snapshot = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort().map((name) => {
  const stat = lstatSync(join(dir, name));
  return `${name}:${stat.isFile() ? readFileSync(join(dir, name), 'utf8') : stat.isSymbolicLink() ? 'link' : 'dir'}`;
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'upg-root-'));
  home = mkdtempSync(join(tmpdir(), 'upg-home-'));
  npm_root = mkdtempSync(join(tmpdir(), 'upg-npm-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, '.documentation'));
});
afterEach(() => { for (const dir of [root, home, npm_root]) rmSync(dir, { recursive: true, force: true }); });

describe('upgrade-notes.json', () => {
  it('has an entry for the package version and every release from 3.1.0', () => {
    const notes = load_upgrade_notes(package_root);
    const version = (JSON.parse(readFileSync(join(package_root, 'package.json'), 'utf8')) as { version: string }).version;
    expect(Object.keys(notes)).toContain(version);
    for (const wanted of ['3.1.0', '3.1.8', '3.2.0', '3.2.1', '3.2.2', '3.3.0']) expect(Object.keys(notes)).toContain(wanted);
  });
  it('lists versions after the recorded one up to the installed one, all from 3.1.0 when unrecorded', () => {
    const notes = load_upgrade_notes(package_root);
    expect(list_crossed_versions(notes, '3.1.8', '3.2.1')).toEqual(['3.2.0', '3.2.1']);
    expect(list_crossed_versions(notes, null, '3.1.1')).toEqual(['3.1.0', '3.1.1']);
    expect(list_crossed_versions(notes, '3.2.1', '3.2.1')).toEqual([]);
  });
});

describe('instruction drift (acceptance 1)', () => {
  it('reports file:line with the #98 note for a rules file that says "then hewtd integrate"', async () => {
    write(join(root, '.claude/rules/docs.md'), '# Docs\n\nWrite the file, then `npx hewtd integrate doc.md`.\n');
    write(join(root, 'CLAUDE.md'), 'nothing here\n');
    const report = await check({ recorded_version: '3.1.8' });
    expect(report.drift).toEqual([expect.objectContaining({ file: '.claude/rules/docs.md', line: 3, issue: 98, release: '3.2.0' })]);
    expect(item(report, 'instruction-drift').status).toBe('action');
  });
  it('reports nothing when the release is not crossed, and never edits the file', async () => {
    const file = join(root, 'AGENTS.md');
    write(file, 'run hewtd integrate\n');
    expect((await check({ recorded_version: '3.2.0' })).drift).toEqual([]);
    await check({ recorded_version: '3.1.8', fix: true });
    expect(readFileSync(file, 'utf8')).toBe('run hewtd integrate\n');
  });
});

describe('hook block (acceptance 2)', () => {
  it('custom core.hooksPath without the block: prints the exact lines to add, not a silent skip', async () => {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
    const report = await check({ recorded_version: '3.1.8' });
    const hook = item(report, 'hook');
    expect(hook.status).toBe('action');
    expect(hook.fixable).toBe(false);
    expect(hook.detail.join('\n')).toContain('npx --no-install hewtd secrets --staged || exit 1');
    expect(hook.detail.join('\n')).toContain('npx --no-install hewtd reconcile --changed --check --cached || exit 1');
    expect(hook.detail.join('\n')).toContain('.githooks/pre-commit');
  });
  it('an older hewtd block is out of date and --fix upgrades it in place', async () => {
    const hook = join(root, '.git/hooks/pre-commit');
    write(hook, '#!/bin/sh\n# >>> hewtd secrets >>>\nnpx --no-install hewtd secrets --staged || exit 1\n# <<< hewtd secrets <<<\n');
    expect(item(await check(), 'hook')).toMatchObject({ status: 'action', fixable: true });
    await check({ fix: true });
    expect(readFileSync(hook, 'utf8')).toContain('reconcile --changed --check --cached');
    expect(item(await check(), 'hook').status).toBe('ok');
  });
  it('no hook at all is info (the hook is opt-in), never installed by --fix, and does not block recording', async () => {
    const report = await check({ fix: true });
    expect(item(report, 'hook')).toMatchObject({ status: 'info', fixable: false });
  });
});

describe('version skew (acceptance 3)', () => {
  it('reports a global CLI older than the plugin and says which copy the hook uses', async () => {
    fake_copy(join(npm_root, package_name), '3.1.0');
    fake_copy(join(home, '.claude/plugins/cache/market/hit-em-with-the-docs/3.2.1'), '3.2.1');
    fake_copy(join(home, '.npm/_npx/abc/node_modules', package_name), '3.0.9');
    const report = await check();
    expect(report.copies.map((copy) => [copy.kind, copy.version]).sort()).toEqual([['global', '3.1.0'], ['npx', '3.0.9'], ['plugin', '3.2.1']]);
    expect(report.copies.find((copy) => copy.kind === 'global')!.used_by).toContain('git hook');
    expect(item(report, 'version-skew').status).toBe('action');
    expect(item(report, 'version-skew').detail.join('\n')).toContain('3.1.0');
  });
  it('the repo node_modules copy wins for the hook and no skew when all agree', async () => {
    fake_copy(join(root, 'node_modules', package_name), '3.2.1');
    fake_copy(join(npm_root, package_name), '3.2.1');
    const report = await check();
    expect(report.copies.find((copy) => copy.kind === 'node_modules')!.used_by).toContain('git hook');
    expect(report.copies.find((copy) => copy.kind === 'global')!.used_by).not.toContain('git hook');
    expect(item(report, 'version-skew').status).toBe('ok');
  });
});

describe('config keys, skills, schema, template', () => {
  it('unset keys from crossed releases are info with the default; --fix adds them and keeps other keys', async () => {
    write(config_path(), JSON.stringify({ updatePolicy: 'nudge', reconcile: { require_review: true } }));
    const before = await check({ recorded_version: '3.1.8' });
    expect(item(before, 'config:reconcile.cold_root')).toMatchObject({ status: 'info', fixable: true });
    expect(item(before, 'config:reconcile.cold_root').detail.join()).toContain('.documentation-cold');
    expect(item(before, 'config:reconcile.require_review').status).toBe('ok');
    await check({ recorded_version: '3.1.8', fix: true });
    const written = JSON.parse(readFileSync(config_path(), 'utf8'));
    expect(written.updatePolicy).toBe('nudge');
    expect(written.reconcile).toEqual({ require_review: true, cold_root: '.documentation-cold', cold_scanner_allowlist: true });
  });
  it('unrecorded repos say so and start at 3.1.0', async () => {
    const report = await check({ installed_version: '3.1.1' });
    expect(report.recorded_version).toBeNull();
    expect(report.crossed).toEqual(['3.1.0', '3.1.1']);
    expect(report.notes.join()).toContain('3.1.0');
  });
  it('a stale skill symlink is relinked by --fix', async () => {
    const skills_dir = join(root, 'node_modules', package_name, 'skills/documentation-lifecycle');
    write(join(skills_dir, 'SKILL.md'), 'x');
    fake_copy(join(root, 'node_modules', package_name), '3.2.1');
    mkdirSync(join(root, '.claude/skills'), { recursive: true });
    symlinkSync('../../gone', join(root, '.claude/skills/documentation-lifecycle'));
    expect(item(await check(), 'skills')).toMatchObject({ status: 'action', fixable: true });
    await check({ fix: true });
    expect(item(await check(), 'skills').status).toBe('ok');
  });
  it('compares vault.schema.yml fields with the frontmatter contract; absent is a manual item', async () => {
    expect(item(await check(), 'frontmatter-schema')).toMatchObject({ status: 'info' });
    write(join(root, 'vault.schema.yml'), 'fields:\n  title: string\n  tier: string\n  bogus_field: string\n');
    const entry = item(await check(), 'frontmatter-schema');
    expect(entry.status).toBe('action');
    expect(entry.detail.join('\n')).toContain('missing: ');
    expect(entry.detail.join('\n')).toContain('purpose');
    expect(entry.detail.join('\n')).toContain('extra: bogus_field');
  });
  it('flags a repo doc template that differs from the shipped one', async () => {
    write(join(root, '.documentation/templates/doc.template.md'), 'old template\n');
    expect(item(await check({ recorded_version: '3.1.8' }), 'template').status).toBe('action');
    write(join(root, '.documentation/templates/doc.template.md'), readFileSync(join(package_root, 'templates/doc.template.md'), 'utf8'));
    expect(item(await check({ recorded_version: '3.1.8' }), 'template').status).toBe('ok');
  });
});

describe('read-only by default (acceptance 5) and --fix (acceptance 4)', () => {
  const build_messy_repo = (): void => {
    write(join(root, '.claude/rules/docs.md'), 'then hewtd integrate\n');
    write(config_path(), JSON.stringify({ updatePolicy: 'nudge' }));
    write(join(root, '.git/hooks/pre-commit'), '#!/bin/sh\n# >>> hewtd secrets >>>\nnpx --no-install hewtd secrets --staged || exit 1\n# <<< hewtd secrets <<<\n');
    write(join(root, 'node_modules', package_name, 'skills/documentation-lifecycle/SKILL.md'), 'x');
    fake_copy(join(root, 'node_modules', package_name), '3.2.1');
  };
  it('without --fix nothing on disk changes (repo, home, npm root)', async () => {
    build_messy_repo();
    const before = [snapshot(root), snapshot(home), snapshot(npm_root)];
    const report = await check({ recorded_version: '3.1.8' });
    expect(report.fixed).toEqual([]);
    expect([snapshot(root), snapshot(home), snapshot(npm_root)]).toEqual(before);
  });
  it('after --fix a second run reports only items that need a human', async () => {
    build_messy_repo();
    const first = await check({ recorded_version: '3.1.8', fix: true });
    expect(first.fixed.length).toBeGreaterThan(0);
    const second = await check({ recorded_version: '3.1.8' });
    const open = second.items.filter((entry) => entry.status !== 'ok');
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((entry) => !entry.fixable)).toBe(true);
    expect(open.map((entry) => entry.id)).toContain('instruction-drift');
    expect(open.map((entry) => entry.id)).not.toContain('skills');
  });
  it('--fix records last_upgrade_check only once nothing is left for a human, so human items stay listed', async () => {
    build_messy_repo();
    await check({ recorded_version: '3.1.8', fix: true });
    expect(JSON.parse(readFileSync(config_path(), 'utf8')).last_upgrade_check).toBeUndefined();
    rmSync(join(root, '.claude/rules'), { recursive: true });
    const clean = await check({ recorded_version: '3.1.8', fix: true });
    expect(clean.items.filter((entry) => entry.status === 'action')).toEqual([]);
    expect(JSON.parse(readFileSync(config_path(), 'utf8')).last_upgrade_check).toBe('3.2.1');
  });
});

describe('review fixes (#104)', () => {
  it('an unparseable config is an action item, and --fix never writes it or records', async () => {
    const broken = '{ "docs_root": "docs", // a comment\n  "updatePolicy": "nudge",\n}\n';
    write(config_path(), broken);
    const report = await check({ recorded_version: '3.1.8', fix: true });
    expect(item(report, 'config-file')).toMatchObject({ status: 'action', fixable: false });
    expect(readFileSync(config_path(), 'utf8')).toBe(broken);
    expect(report.recorded).toBe(false);
  });
  it('--record writes last_upgrade_check even with human items left, and the next run starts after it', async () => {
    write(join(root, '.claude/rules/docs.md'), 'then hewtd integrate\n');
    write(config_path(), JSON.stringify({ updatePolicy: 'nudge' }, null, 2) + '\n');
    const first = await check({ record: true });
    expect(first.recorded).toBe(true);
    const config = JSON.parse(readFileSync(config_path(), 'utf8'));
    expect(config).toMatchObject({ updatePolicy: 'nudge', last_upgrade_check: '3.2.1' });
    const next = await check();
    expect(next.recorded_version).toBe('3.2.1');
    expect(next.crossed).toEqual([]);
  });
  it('--record refuses an unparseable config', async () => {
    write(config_path(), '{ broken');
    const report = await check({ record: true });
    expect(report.recorded).toBe(false);
    expect(readFileSync(config_path(), 'utf8')).toBe('{ broken');
  });
  it('old plugin-cache versions are not skew: only the newest one per plugin counts', async () => {
    fake_copy(join(root, 'node_modules', package_name), '3.2.1');
    write(join(home, '.claude/plugins/cache/mk/hit-em-with-the-docs/3.2.0/.claude-plugin/plugin.json'), JSON.stringify({ version: '3.2.0' }));
    write(join(home, '.claude/plugins/cache/mk/hit-em-with-the-docs/3.2.1/.claude-plugin/plugin.json'), JSON.stringify({ version: '3.2.1' }));
    const report = await check({ npm_root: null });
    expect(item(report, 'version-skew').status).toBe('ok');
    expect(item(report, 'version-skew').detail.join('\n')).toMatch(/3\.2\.0.*unused/);
  });
  it('no copy anywhere is not reported as ok', async () => {
    const report = await check({ npm_root: null });
    expect(item(report, 'version-skew').status).not.toBe('ok');
  });
  it('versions with a v prefix or a prerelease suffix compare by their numbers; an invalid recorded value counts as unrecorded', () => {
    const notes = load_upgrade_notes(package_root);
    expect(compare_versions('v3.2.0', '3.2.0')).toBe(0);
    expect(list_crossed_versions(notes, 'v3.2.0', '3.2.1')).toEqual(['3.2.1']);
    expect(list_crossed_versions(notes, '3.2.0', '3.3.0-beta.1')).toEqual(['3.2.1', '3.2.2', '3.3.0']);
    expect(list_crossed_versions(notes, 'garbage', '3.1.1')).toEqual(['3.1.0', '3.1.1']);
  });
});
