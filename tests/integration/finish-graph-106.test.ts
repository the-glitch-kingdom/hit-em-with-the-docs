import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// #106: reconcile --finish inventories and cleans what a reconcile leaves behind; hewtd graph + post-merge/post-checkout hooks keep graph.json at HEAD.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
let home: string;

const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf-8' }).trim();
const hewtd = (args: string[], cwd = root, env: Record<string, string> = {}) => spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME: home, ...env } });
const put = (rel: string, text: string, base = root) => { mkdirSync(join(base, rel, '..'), { recursive: true }); writeFileSync(join(base, rel), text); };
const read = (rel: string, base = root): string => readFileSync(join(base, rel), 'utf8');
const fm = (title: string) => `---\ntitle: ${title}\ndomains:\n  - backend\n---\n\n# ${title}\n\nBody of ${title}. See \`src/real.ts\`.\n`;
// built at runtime: no secret-shaped literal in a committed file
const fake_value = (tag: string): string => ['sk', 'live', tag, 'Zq81LmN0pQr5'].join('_');
const config_file = '.claude/hit-em-with-the-docs.json';
const SECRET_A = fake_value('alpha');
const SECRET_B = fake_value('bravo');
const stage_manifest = (source_commit: string) => JSON.stringify({ format: 1, docs_path: '.documentation', source_commit, staged_at: '2026-01-01T00:00:00Z', live_checksum: 'x' });

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'finish-106-'));
  home = mkdtempSync(join(tmpdir(), 'finish-106-home-'));
  put('src/real.ts', 'export const realThing = 1;\n');
  put('.documentation/backend/a.md', fm('a'));
  put(config_file, JSON.stringify({ updatePolicy: 'nudge' }, null, 2) + '\n');
  put('.gitignore', 'node_modules/\n');
  g(root, 'init', '-q'); g(root, 'add', '-A'); g(root, 'commit', '-qm', 'init');
});
afterEach(() => { for (const dir of [root, home]) { spawnSync('chmod', ['-R', 'u+w', dir]); rmSync(dir, { recursive: true, force: true }); } });

/** What a reconcile leaves behind: env file, review files (one quoting a value), stages, graph files. */
const leave_leftovers = () => {
  put('.env.hewtd', `HEWTD_KEY_A=${SECRET_A}\nHEWTD_KEY_B=${SECRET_B}\n`);
  chmodSync(join(root, '.env.hewtd'), 0o600);
  put('.hewtd/reconcile/review-1.md', `# review\n\n\`\`\`json\n${JSON.stringify({ path: 'backend/a.md', patch: { old: `token ${SECRET_A}`, new: 'x' } })}\n\`\`\`\n`);
  put('.hewtd/reconcile/review-2.md', '# review 2\n\nnothing sensitive\n');
  put('.hewtd/reconcile/secrets-report-2026-01-01.md', '# masked\n');
  const head = g(root, 'rev-parse', 'HEAD');
  put('.hewtd/stage/rejected-x/stage.json', stage_manifest(head)); put('.hewtd/stage/rejected-x/docs/a.md', 'old\n');
  put('.hewtd/stage/old-one/stage.json', stage_manifest('0'.repeat(40))); put('.hewtd/stage/old-one/docs/a.md', 'old\n');
  expect(hewtd(['graph']).status).toBe(0);
  put('.hewtd/graph-cache.json', '{"cache_version":2}');
};

describe('reconcile --finish inventory', () => {
  it('lists every leftover with sizes, key names only, and flags keys not marked rotated', () => {
    leave_leftovers();
    const result = hewtd(['reconcile', '--finish']);
    expect(result.status).toBe(0);
    const out = result.stdout;
    expect(out).toContain('.env.hewtd');
    expect(out).toMatch(/HEWTD_KEY_A\s+NOT rotated/);
    expect(out).toContain('.hewtd/stage/rejected-x');
    expect(out).toMatch(/rejected-x.*rejected/);
    expect(out).toMatch(/old-one.*abandoned/);
    expect(out).toContain('graph-cache.json');
    expect(out).toMatch(/2 review file/);
    expect(out).toContain('review-1.md');
    expect(out).not.toContain(SECRET_A);
    expect(out).not.toContain(SECRET_B);
    expect(out).toMatch(/\d+(\.\d)? (B|KB)/);
  });
  it('is read-only: no flags changes nothing', () => {
    leave_leftovers();
    const before = read('.hewtd/reconcile/review-1.md');
    hewtd(['reconcile', '--finish']);
    expect(read('.hewtd/reconcile/review-1.md')).toBe(before);
    expect(existsSync(join(root, '.hewtd/stage/rejected-x'))).toBe(true);
  });
  it('--json is parseable, carries names and no values', () => {
    leave_leftovers();
    const result = hewtd(['reconcile', '--finish', '--json']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(SECRET_A);
    const report = JSON.parse(result.stdout);
    expect(report.credentials.keys.map((key: { name: string }) => key.name)).toEqual(['HEWTD_KEY_A', 'HEWTD_KEY_B']);
    expect(report.credentials.keys[0].rotated).toBe(false);
    expect(report.stages.map((stage: { kind: string }) => stage.kind).sort()).toEqual(['abandoned', 'rejected']);
    expect(report.review_files.count).toBe(2);
    expect(report.review_files.with_secrets).toEqual(['.hewtd/reconcile/review-1.md']);
  });
  it('finds a stage.json outside .hewtd too', () => {
    put('work/stage-z/stage.json', stage_manifest('0'.repeat(40))); put('work/stage-z/docs/a.md', 'old\n');
    expect(hewtd(['reconcile', '--finish']).stdout).toContain('work/stage-z');
  });
  it('flags .hewtd working files that git does not ignore', () => {
    leave_leftovers();
    const out = hewtd(['reconcile', '--finish']).stdout;
    expect(out).toMatch(/not git-ignored/i);
    expect(out).toContain('--fix');
  });
});

describe('--rotated', () => {
  it('records {env, rotated_on} (names only) and the key is no longer flagged', () => {
    leave_leftovers();
    const result = hewtd(['reconcile', '--finish', '--rotated', 'HEWTD_KEY_A']);
    expect(result.status).toBe(0);
    const config = JSON.parse(read(config_file));
    expect(config.reconcile.secrets.rotated).toEqual([{ env: 'HEWTD_KEY_A', rotated_on: new Date().toISOString().slice(0, 10) }]);
    expect(read(config_file)).not.toContain(SECRET_A);
    expect(config.updatePolicy).toBe('nudge');
    expect(result.stdout).toMatch(/HEWTD_KEY_A\s+rotated/);
    expect(result.stdout).toMatch(/HEWTD_KEY_B\s+NOT rotated/);
  });
  it('is repeatable and a second record of the same name replaces it', () => {
    leave_leftovers();
    hewtd(['reconcile', '--finish', '--rotated', 'HEWTD_KEY_A', '--rotated', 'HEWTD_KEY_B']);
    hewtd(['reconcile', '--finish', '--rotated', 'HEWTD_KEY_A']);
    expect(JSON.parse(read(config_file)).reconcile.secrets.rotated).toHaveLength(2);
  });
  it('refuses an unparseable config and a bad name, and changes nothing', () => {
    leave_leftovers();
    put(config_file, '{ not json');
    const bad = hewtd(['reconcile', '--finish', '--rotated', 'HEWTD_KEY_A']);
    expect(bad.status).toBe(1);
    expect(read(config_file)).toBe('{ not json');
    put(config_file, '{}');
    expect(hewtd(['reconcile', '--finish', '--rotated', 'not a name']).status).toBe(1);
  });
  it('warns when the name is not in .env.hewtd', () => {
    leave_leftovers();
    expect(hewtd(['reconcile', '--finish', '--rotated', 'NOT_THERE']).stdout + '').toMatch(/NOT_THERE.*not in \.env\.hewtd/);
  });
});

describe('--fix', () => {
  it('redacts a secret-lane value in review files with its env pointer, and only there', () => {
    leave_leftovers();
    const untouched = read('.hewtd/reconcile/review-2.md');
    const result = hewtd(['reconcile', '--finish', '--fix']);
    expect(result.status).toBe(0);
    const review = read('.hewtd/reconcile/review-1.md');
    expect(review).not.toContain(SECRET_A);
    expect(review).toContain('<secret: HEWTD_KEY_A, see .env.hewtd>');
    expect(read('.hewtd/reconcile/review-2.md')).toBe(untouched);
    expect(read('.env.hewtd')).toContain(SECRET_A);
    expect(result.stdout).not.toContain(SECRET_A);
  });
  it('adds the missing ignore lines so git status shows no hewtd working files, keeping reconcile.json and the baseline tracked', () => {
    leave_leftovers();
    put('.hewtd/reconcile.json', '{}\n'); put('.hewtd/secrets-baseline.json', '[]\n');
    expect(hewtd(['reconcile', '--finish', '--fix']).status).toBe(0);
    const status = g(root, 'status', '--porcelain', '--untracked-files=all');
    expect(status).not.toMatch(/\.env\.hewtd|graph|stage|reconcile\/review/);
    expect(status).toContain('.hewtd/reconcile.json');
    expect(status).toContain('.hewtd/secrets-baseline.json');
    const again = read('.gitignore');
    hewtd(['reconcile', '--finish', '--fix']);
    expect(read('.gitignore')).toBe(again);
  });
});

describe('--confirm', () => {
  it('needs --finish', () => { expect(hewtd(['reconcile', '--confirm']).status).toBe(1); });
  it('removes only rejected/abandoned stages and graph caches; never .env.hewtd, graph.json, the docs tree or a live stage', () => {
    leave_leftovers();
    put('.hewtd/stage/live/stage.json', stage_manifest(g(root, 'rev-parse', 'HEAD'))); put('.hewtd/stage/live/docs/a.md', 'wip\n');
    const docs_before = read('.documentation/backend/a.md');
    const result = hewtd(['reconcile', '--finish', '--confirm']);
    expect(result.status).toBe(0);
    expect(existsSync(join(root, '.hewtd/stage/rejected-x'))).toBe(false);
    expect(existsSync(join(root, '.hewtd/stage/old-one'))).toBe(false);
    expect(existsSync(join(root, '.hewtd/graph-cache.json'))).toBe(false);
    expect(existsSync(join(root, '.hewtd/stage/live/docs/a.md'))).toBe(true);
    expect(existsSync(join(root, '.hewtd/graph.json'))).toBe(true);
    expect(read('.env.hewtd')).toContain(SECRET_A);
    expect(read('.documentation/backend/a.md')).toBe(docs_before);
    expect(existsSync(join(root, '.hewtd/reconcile/review-1.md'))).toBe(true); // not redacted, so kept
  });
  it('with --fix also removes the review files it redacted, and nothing else under reconcile/', () => {
    leave_leftovers();
    hewtd(['reconcile', '--finish', '--fix', '--confirm']);
    expect(existsSync(join(root, '.hewtd/reconcile/review-1.md'))).toBe(false);
    expect(existsSync(join(root, '.hewtd/reconcile/review-2.md'))).toBe(true);
    expect(existsSync(join(root, '.hewtd/reconcile/secrets-report-2026-01-01.md'))).toBe(true);
    expect(existsSync(join(root, '.env.hewtd'))).toBe(true);
  });
  it('never touches cold generations; promote --confirm ends with the inventory', () => {
    put('.gitignore', '.hewtd/\n'); g(root, 'add', '-A'); g(root, 'commit', '-qm', 'ignore');
    expect(hewtd(['reconcile', '--stage', '.hewtd/stage/s1']).status).toBe(0);
    writeFileSync(join(root, '.hewtd/stage/s1/docs/backend/a.md'), fm('a') + '\nReconciled.\n');
    const promoted = hewtd(['reconcile', '--promote', '--staged', '.hewtd/stage/s1', '--confirm']);
    expect(promoted.status).toBe(0);
    expect(promoted.stdout).toContain('hewtd reconcile --finish');
    expect(promoted.stdout).toContain('.hewtd/stage/s1');
    const cold = readdirSync(join(root, '.documentation-cold')).filter((name) => !name.startsWith('.'));
    expect(cold.length).toBe(1);
    hewtd(['reconcile', '--finish', '--fix', '--confirm']);
    expect(readdirSync(join(root, '.documentation-cold')).filter((name) => !name.startsWith('.'))).toEqual(cold);
    expect(statSync(join(root, '.documentation')).isDirectory()).toBe(true);
  });
});

describe('hewtd graph', () => {
  it('writes graph.json at HEAD; --quiet prints nothing', () => {
    const result = hewtd(['graph', '--quiet']);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toBe('');
    expect(JSON.parse(read('.hewtd/graph.json')).source_commit).toBe(g(root, 'rev-parse', 'HEAD'));
  });
  it('refreshes after a code-only commit', () => {
    hewtd(['graph', '--quiet']);
    put('src/other.ts', 'export const other = 2;\n'); g(root, 'add', '-A'); g(root, 'commit', '-qm', 'code');
    hewtd(['graph', '--quiet']);
    expect(JSON.parse(read('.hewtd/graph.json')).source_commit).toBe(g(root, 'rev-parse', 'HEAD'));
  });
});

describe('graph hooks', () => {
  const hook_path = (name: string) => join(root, '.git/hooks', name);
  it('hooks install adds post-merge and post-checkout blocks beside the pre-commit one, keeping user content; uninstall restores', () => {
    put('.git/hooks/post-merge', '#!/bin/sh\necho mine\n');
    const mine = read('.git/hooks/post-merge');
    expect(hewtd(['hooks', 'install']).status).toBe(0);
    for (const name of ['pre-commit', 'post-merge', 'post-checkout']) expect(read(`.git/hooks/${name}`)).toContain('hewtd');
    expect(read('.git/hooks/post-merge')).toContain('echo mine');
    expect(read('.git/hooks/post-merge')).toContain('hewtd graph --quiet');
    expect(statSync(hook_path('post-checkout')).mode & 0o111).toBeTruthy();
    const once = read('.git/hooks/post-merge');
    hewtd(['hooks', 'install']);
    expect(read('.git/hooks/post-merge')).toBe(once);
    expect(hewtd(['hooks', 'uninstall']).status).toBe(0);
    expect(read('.git/hooks/post-merge')).toBe(mine);
    expect(existsSync(hook_path('post-checkout'))).toBe(false);
    expect(existsSync(hook_path('pre-commit'))).toBe(false);
  });
  it('upgrades an old graph block in place', () => {
    hewtd(['hooks', 'install']);
    const current = read('.git/hooks/post-merge');
    put('.git/hooks/post-merge', current.replace('hewtd graph --quiet', 'hewtd graph --old'));
    hewtd(['hooks', 'install']);
    expect(read('.git/hooks/post-merge')).toBe(current);
  });
  it('after a pull, graph.json source_commit equals HEAD (a real hook run)', () => {
    const clone = join(mkdtempSync(join(tmpdir(), 'finish-106-clone-')), 'c');
    try {
      execFileSync('git', ['clone', '-q', root, clone]);
      // `npx --no-install hewtd` (the hook line) takes the repo's node_modules/.bin first
      put('node_modules/.bin/hewtd', `#!/bin/sh\nexec node ${CLI} "$@"\n`, clone); chmodSync(join(clone, 'node_modules/.bin/hewtd'), 0o755);
      const env = { HOME: home };
      expect(hewtd(['hooks', 'install'], clone, env).status).toBe(0);
      expect(hewtd(['graph', '--quiet'], clone, env).status).toBe(0);
      put('src/new.ts', 'export const added = 3;\n'); g(root, 'add', '-A'); g(root, 'commit', '-qm', 'upstream');
      const pulled = spawnSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', 'pull', '-q', '--no-rebase', 'origin'], { cwd: clone, encoding: 'utf8', env: { ...process.env, ...env } });
      expect(pulled.status, pulled.stderr).toBe(0);
      expect(JSON.parse(read('.hewtd/graph.json', clone)).source_commit).toBe(g(clone, 'rev-parse', 'HEAD'));
      const head = g(clone, 'rev-parse', 'HEAD');
      g(clone, 'checkout', '-q', '-b', 'side'); put('src/side.ts', 'export const side = 4;\n', clone); g(clone, 'add', '-A'); g(clone, 'commit', '-qm', 'side');
      g(clone, 'checkout', '-q', head);
      expect(JSON.parse(read('.hewtd/graph.json', clone)).source_commit).toBe(head);
    } finally { rmSync(resolve(clone, '..'), { recursive: true, force: true }); }
  });
});

describe('upgrade-check reports the graph hook blocks', () => {
  it('lists post-merge and post-checkout as missing, then ok once installed', () => {
    const before = hewtd(['upgrade-check', '--json']);
    const ids = JSON.parse(before.stdout).items.map((item: { id: string }) => item.id);
    expect(ids).toContain('hook:post-merge');
    expect(ids).toContain('hook:post-checkout');
    expect(before.stdout).toContain('hewtd graph --quiet');
    hewtd(['hooks', 'install']);
    const after = JSON.parse(hewtd(['upgrade-check', '--json']).stdout).items.filter((item: { id: string }) => item.id.startsWith('hook'));
    expect(after.every((item: { status: string }) => item.status === 'ok')).toBe(true);
  });
  it('--fix upgrades an out-of-date graph block', () => {
    hewtd(['hooks', 'install']);
    const current = read('.git/hooks/post-checkout');
    put('.git/hooks/post-checkout', current.replace('hewtd graph --quiet', 'hewtd graph --old'));
    hewtd(['upgrade-check', '--fix']);
    expect(read('.git/hooks/post-checkout')).toBe(current);
  });
  it('a custom core.hooksPath gets the exact graph lines to add, and nothing is written there', () => {
    g(root, 'config', 'core.hooksPath', '.githooks');
    const text = hewtd(['upgrade-check']).stdout;
    for (const name of ['post-merge', 'post-checkout']) {
      expect(text).toContain(`add these lines to .githooks/${name}:`);
    }
    expect(text).toContain('        # >>> hewtd graph >>>\n        if [ "${3:-1}" != "0" ]; then npx --no-install hewtd graph --quiet || true; fi\n        # <<< hewtd graph <<<');
    expect(existsSync(join(root, '.githooks'))).toBe(false);
  });
  it('upgrade-notes.json 3.3.0 names the hooks', () => {
    const notes = JSON.parse(readFileSync(join(resolve(__dirname, '../..'), 'upgrade-notes.json'), 'utf8'));
    expect(notes['3.3.0'].hook_block).toMatch(/post-merge/);
    expect(notes['3.3.0'].config_keys.map((key: { key: string }) => key.key)).toContain('reconcile.secrets.rotated');
  });
});
