import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const package_version = (JSON.parse(readFileSync(join(resolve(__dirname, '../..'), 'package.json'), 'utf8')) as { version: string }).version;
let root: string;
let home: string;
let npm_root: string;
const hewtd = (...args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home, HEWTD_NPM_ROOT: npm_root } });
const config_path = (): string => join(root, '.claude/hit-em-with-the-docs.json');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'upgc-root-'));
  home = mkdtempSync(join(tmpdir(), 'upgc-home-'));
  npm_root = mkdtempSync(join(tmpdir(), 'upgc-npm-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, '.documentation'));
  mkdirSync(join(root, '.claude/rules'), { recursive: true });
  writeFileSync(join(root, '.claude/rules/docs.md'), 'Write it, then `hewtd integrate`.\n');
  writeFileSync(config_path(), JSON.stringify({ last_upgrade_check: '3.1.8' }));
});
afterEach(() => { for (const dir of [root, home, npm_root]) rmSync(dir, { recursive: true, force: true }); });

describe('hewtd upgrade-check', () => {
  it('prints a checklist, exits 0 and changes nothing without --fix', () => {
    const before = readFileSync(config_path(), 'utf8');
    const result = hewtd('upgrade-check');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('.claude/rules/docs.md:1');
    expect(result.stdout).toContain('#98');
    expect(readFileSync(config_path(), 'utf8')).toBe(before);
  });
  it('--json is parseable and carries the drift entry', () => {
    const result = hewtd('upgrade-check', '--json');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.recorded_version).toBe('3.1.8');
    expect(report.installed_version).toBe(package_version);
    expect(report.drift[0]).toMatchObject({ file: '.claude/rules/docs.md', line: 1, issue: 98 });
  });
  it('--fix adds new config keys at their defaults and keeps the recorded version while a human item is open', () => {
    expect(hewtd('upgrade-check', '--fix').status).toBe(0);
    const config = JSON.parse(readFileSync(config_path(), 'utf8'));
    expect(config.reconcile.cold_root).toBe('.documentation-cold');
    expect(config.last_upgrade_check).toBe('3.1.8');
  });
});
