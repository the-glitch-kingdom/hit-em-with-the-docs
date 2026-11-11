import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// #101: a promote commit must pass the repo's secret scanners without hand edits (cold-root allowlist, opt-out),
// the plan warns about it and about staged docs without a review, and undo reverses every scanner edit exactly.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
let stage: string;

const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const fm = (title: string) => `---\ntitle: ${title}\ndomains:\n  - backend\n---\n\n# ${title}\n\nBody of ${title}.\n`;
// built at runtime: no secret-shaped literal in a committed file
const fake_key = (): string => ['AKIA', 'QWERTYUIOPASDFGH'].join('');
const config_file = '.claude/hit-em-with-the-docs.json';
const COLD_RE = '^\\.documentation-cold/';

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cold-scanners-101-'));
  stage = join(root, '.hewtd/stage');
  put('src/real.ts', 'export const realThing = 1;\n');
  put('.documentation/backend/a.md', fm('a') + `\nSee \`src/real.ts\`. key=${fake_key()}\n`);
  put('.documentation/backend/b.md', fm('b') + '\nSee `src/real.ts`.\n');
  put(config_file, JSON.stringify({ updatePolicy: 'nudge' }, null, 2) + '\n');
  put('.gitignore', '.hewtd/\n');
});
afterEach(() => { spawnSync('chmod', ['-R', 'u+w', root]); rmSync(root, { recursive: true, force: true }); });

const commit_all = (): void => { g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init'); };
const promote = (extra: string[] = []) => {
  expect(hewtd(['reconcile', '--stage', stage]).status).toBe(0);
  writeFileSync(join(stage, 'docs/backend/b.md'), fm('b') + '\nReconciled.\n');
  return hewtd(['reconcile', '--promote', '--staged', stage, ...extra]);
};
const generation = (): string => JSON.parse(read(config_file)).cold_storage[0].generation as string;

describe('promote adds a cold-root scanner allowlist (#101)', () => {
  it('appends to an existing [allowlist] paths array, records it in the manifest and the promote commit, and undo restores the bytes', () => {
    const original = "title = \"mine\"\n\n[[rules]]\nid = \"x\"\nregex = '''zzz'''\n\n[allowlist]\n# keep\npaths = [\n  '''^vendor/''',\n]\n";
    put('.gitleaks.toml', original);
    commit_all();
    const done = promote(['--confirm']);
    expect(done.status, done.stdout + done.stderr).toBe(0);
    const after = read('.gitleaks.toml');
    expect(after).toContain(`'''${COLD_RE}'''`);
    expect(after).toContain("'''^vendor/'''");
    expect(after.match(/\[allowlist\]/g)).toHaveLength(1);
    expect(JSON.parse(read(config_file)).cold_storage[0].scanner_allowlists).toEqual(['.gitleaks.toml']);
    expect(g('show', '--name-only', '--format=', 'HEAD').split('\n')).toContain('.gitleaks.toml');
    expect(g('status', '--porcelain')).toBe('');
    expect(done.stdout).toContain('allowlisted in .gitleaks.toml');

    const undone = hewtd(['reconcile', '--undo', generation(), '--confirm']);
    expect(undone.status, undone.stdout + undone.stderr).toBe(0);
    expect(read('.gitleaks.toml')).toBe(original);
    expect(g('status', '--porcelain')).toBe('');
  });

  it('a repo without .gitleaks.toml gets one that extends the default rules, and undo deletes it', () => {
    commit_all();
    const done = promote(['--confirm']);
    expect(done.status, done.stdout + done.stderr).toBe(0);
    const created = read('.gitleaks.toml');
    expect(created).toMatch(/\[extend\]\s*\nuseDefault = true/);
    expect(created).toContain(`'''${COLD_RE}'''`);
    expect(g('ls-files', '.gitleaks.toml')).toBe('.gitleaks.toml');
    expect(hewtd(['reconcile', '--undo', generation(), '--confirm']).status).toBe(0);
    expect(existsSync(join(root, '.gitleaks.toml'))).toBe(false);
    expect(g('status', '--porcelain')).toBe('');
  });

  it('adds the cold root to a detect-secrets baseline exclude and undo restores it', () => {
    const original = JSON.stringify({ version: '1.5.0', filters_used: [{ path: 'detect_secrets.filters.common.is_baseline_file', filename: '.secrets.baseline' }, { path: 'detect_secrets.filters.regex.should_exclude_file', pattern: ['^vendor/'] }], results: {} }, null, 2) + '\n';
    put('.secrets.baseline', original);
    put('.gitleaks.toml', '[extend]\nuseDefault = true\n');
    commit_all();
    expect(promote(['--confirm']).status).toBe(0);
    const baseline = JSON.parse(read('.secrets.baseline'));
    expect(baseline.filters_used[1].pattern).toEqual(['^vendor/', COLD_RE]);
    expect(JSON.parse(read(config_file)).cold_storage[0].scanner_allowlists).toEqual(['.gitleaks.toml', '.secrets.baseline']);
    expect(hewtd(['reconcile', '--undo', generation(), '--confirm']).status).toBe(0);
    expect(read('.secrets.baseline')).toBe(original);
  });

  it('reconcile.cold_scanner_allowlist: false touches no scanner file and the plan warns instead', () => {
    put(config_file, JSON.stringify({ updatePolicy: 'nudge', reconcile: { cold_scanner_allowlist: false } }, null, 2) + '\n');
    commit_all();
    const planned = promote();
    expect(planned.stdout).toMatch(/1 file\(s\) in the outgoing tree contain strings secret scanners commonly flag/);
    expect(planned.stdout).toMatch(/promote commit will re-add them/);
    const done = hewtd(['reconcile', '--promote', '--staged', stage, '--confirm']);
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(existsSync(join(root, '.gitleaks.toml'))).toBe(false);
    expect(JSON.parse(read(config_file)).cold_storage[0].scanner_allowlists).toEqual([]);
  });

  it('the plan names the flagged files and the scanner files, and changes nothing', () => {
    commit_all();
    const before = [g('rev-parse', 'HEAD'), g('status', '--porcelain')].join('\n');
    const planned = promote();
    expect(planned.status, planned.stderr).toBe(0);
    expect(planned.stdout).toContain('1 file(s) in the outgoing tree contain strings secret scanners commonly flag (hewtd found 1)');
    expect(planned.stdout).toContain('allowlisted in .gitleaks.toml (created)');
    expect(planned.stdout).not.toContain(fake_key());
    expect([g('rev-parse', 'HEAD'), g('status', '--porcelain')].join('\n')).toBe(before);
    expect(existsSync(join(root, '.gitleaks.toml'))).toBe(false);
  });

  it('undo leaves a scanner file edited since the promote alone and says so', () => {
    commit_all();
    expect(promote(['--confirm']).status).toBe(0);
    const edited = read('.gitleaks.toml') + '\n# edited after the promote\n';
    put('.gitleaks.toml', edited);
    g('commit', '-qam', 'edit');
    const undone = hewtd(['reconcile', '--undo', generation(), '--confirm']);
    expect(undone.status, undone.stdout + undone.stderr).toBe(0);
    expect(read('.gitleaks.toml')).toBe(edited);
    expect(undone.stdout + undone.stderr).toContain('.gitleaks.toml');
  });

  it('warns how many staged docs have no review in the stage ledger, and never marks them reviewed', () => {
    commit_all();
    const planned = promote();
    expect(planned.stdout).toMatch(/after promote, 2 doc\(s\) will show as unreviewed \(DOCS_UNREVIEWED\)/);
    expect(planned.stdout).toContain('.hewtd/stage/ledger.json');
    const done = hewtd(['reconcile', '--promote', '--staged', stage, '--confirm']);
    expect(done.stdout).toMatch(/2 doc\(s\) will show as unreviewed/);
    expect(existsSync(join(root, '.hewtd/reconcile.json'))).toBe(false);
  });
});
