import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const val = 'sk' + '_live_' + 'Qz8rT2mVb4Xk9LpW3nYc7HdA';
let root: string;
const hewtd = (...a: string[]) => spawnSync('node', [CLI, ...a], { cwd: root, encoding: 'utf8' });
const git = (...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
const d = (n: string) => join(root, '.documentation', n);
const hook = () => join(root, '.git/hooks/pre-commit');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stg-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, '.documentation'));
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(root, 'node_modules/.bin/hewtd'), `#!/bin/sh\nexec node "${CLI}" "$@"\n`);
  chmodSync(join(root, 'node_modules/.bin/hewtd'), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('staged secret scan + pre-commit hook', () => {
  it('refuses an added secret line (masked) and allows a frontmatter-only change on a legacy secret doc', () => {
    // legacy: committed before the hook exists
    writeFileSync(d('a.md'), `---\ntitle: A\n---\n\nkey ${val}\n`);
    git('add', '.'); expect(git('commit', '-qm', 'legacy').status).toBe(0);
    expect(hewtd('hooks', 'install').status).toBe(0);
    writeFileSync(d('a.md'), `---\ntitle: A\nsources:\n  - x.ts\n---\n\nkey ${val}\n`);
    git('add', '.');
    expect(git('commit', '-qm', 'fields only').status).toBe(0);
    writeFileSync(d('b.md'), `# B\n\nnew key ${val}\n`);
    git('add', '.');
    const r = git('commit', '-qm', 'adds secret');
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('.documentation/b.md:3');
    expect(r.stdout + r.stderr).not.toContain(val.slice(4));
  });

  it('a baselined value is allowed', () => {
    writeFileSync(d('a.md'), `# A\n\nkey ${val}\n`);
    expect(hewtd('secrets', '--baseline-add', '.documentation/a.md:3', '--reason', 'fixture').status).toBe(0);
    git('add', '.documentation');
    expect(hewtd('secrets', '--staged').status).toBe(0);
  });

  it('keeps an existing hook, installs once, and uninstall restores it byte for byte', () => {
    const orig = '#!/bin/sh\necho user-hook > "$PWD/ran"\n# no trailing newline';
    mkdirSync(join(root, '.git/hooks'), { recursive: true });
    writeFileSync(hook(), orig); chmodSync(hook(), 0o755);
    hewtd('hooks', 'install'); hewtd('hooks', 'install');
    const cur = readFileSync(hook(), 'utf-8');
    expect(cur.split('>>> hewtd secrets').length).toBe(2);
    writeFileSync(d('a.md'), '# A\n\nclean\n');
    git('add', '.documentation');
    expect(git('commit', '-qm', 'ok').status).toBe(0);
    expect(existsSync(join(root, 'ran'))).toBe(true);
    hewtd('hooks', 'uninstall');
    expect(readFileSync(hook(), 'utf-8')).toBe(orig);
  });

  it('uninstall removes a hook that hewtd created', () => {
    hewtd('hooks', 'install');
    expect(existsSync(hook())).toBe(true);
    hewtd('hooks', 'uninstall');
    expect(existsSync(hook())).toBe(false);
  });
});
