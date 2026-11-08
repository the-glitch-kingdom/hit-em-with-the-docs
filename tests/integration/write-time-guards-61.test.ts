import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, chmodSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// #61 acceptance checks, end to end through the built CLI in a temp git repo (hook installed for commit checks).
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const vault = 'hv' + 's.' + 'Qz8rT2mVb4Xk9LpW3nYc7HdA';
let root: string;
const hewtd = (...a: string[]) => spawnSync('node', [CLI, ...a], { cwd: root, encoding: 'utf8', timeout: 60000 });
const git = (...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const read = (rel: string) => readFileSync(join(root, rel), 'utf-8');
const tree = (dir: string): string[] => readdirSync(join(root, dir), { recursive: true }).map(String).sort();
const sources_of = (rel: string): string[] => {
  const m = read(rel).match(/^sources:\n((?:  - .*\n)+)/m);
  return m ? m[1]!.trim().split('\n').map((l) => l.trim().replace(/^- /, '').replace(/^['"]|['"]$/g, '')) : [];
};
const integrate = (name: string, body: string) => {
  put(`inbox/${name}`, `---\ntitle: ${name}\ndomains:\n  - api\n---\n\n# ${name}\n\n${body}\n`);
  return hewtd('integrate', `inbox/${name}`, '-a', '-d', 'api');
};
const landed = (name: string) => `.documentation/api/${name}`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wtg-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (let i = 0; i < 60; i++) put(`src/f${i}.ts`, `export const v${i} = ${i};\n`);
  put('.gitignore', '.hewtd/\nnode_modules/\ninbox/\n');
  mkdirSync(join(root, '.documentation/api'), { recursive: true });
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(root, 'node_modules/.bin/hewtd'), `#!/bin/sh\nexec node "${CLI}" "$@"\n`);
  chmodSync(join(root, 'node_modules/.bin/hewtd'), 0o755);
  git('add', '-A'); git('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('#61 integrate secret scan', () => {
  it('refuses a vault token: masked value, reconcile pointer, nothing written', () => {
    const before = tree('.documentation');
    const r = integrate('leak.md', `token ${vault}`);
    const out = r.stdout + r.stderr;
    expect(r.status).toBe(1);
    expect(out).toContain('vault-token');
    expect(out).toContain('hvs.…28');
    expect(out).toContain('reconcile');
    expect(out).not.toContain(vault.slice(4));
    expect(tree('.documentation')).toEqual(before);
  });

  it('a baselined value does not block; the baseline file holds no raw value', () => {
    put('.documentation/old.md', `# Old\n\nkey ${vault}\n`);
    expect(hewtd('secrets', '--baseline-add', '.documentation/old.md:3', '--reason', 'fixture').status).toBe(0);
    const baseline = read('.hewtd/secrets-baseline.json');
    expect(baseline).not.toContain(vault);
    expect(baseline).not.toContain(vault.slice(4));
    expect(integrate('ok.md', `token ${vault}`).status).toBe(0);
  });
});

describe('#61 commit hook', () => {
  it('refuses an added secret line; allows a frontmatter-only change to a legacy secret doc', () => {
    put('.documentation/a.md', `---\ntitle: A\n---\n\nkey ${vault}\n`);
    git('add', '-A'); expect(git('commit', '-qm', 'legacy').status).toBe(0);
    expect(hewtd('hooks', 'install').status).toBe(0);
    put('.documentation/a.md', `---\ntitle: A\nsources:\n  - src/f1.ts\n---\n\nkey ${vault}\n`);
    git('add', '-A');
    expect(git('commit', '-qm', 'fields only').status).toBe(0);
    put('.documentation/b.md', `# B\n\nnew ${vault}\n`);
    git('add', '-A');
    const r = git('commit', '-qm', 'adds secret');
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('.documentation/b.md:3');
    expect(r.stdout + r.stderr).not.toContain(vault.slice(4));
  });
});

describe('#61 integrate sources', () => {
  it('writes resolving sources, never last_verified; a fresh doc triages to check', () => {
    const r = integrate('fresh.md', 'See `src/f1.ts` and `src/missing.ts`.');
    expect(r.status).toBe(0);
    expect(sources_of(landed('fresh.md'))).toEqual(['src/f1.ts']);
    expect(read(landed('fresh.md'))).not.toContain('last_verified');
    git('add', '-A'); git('commit', '-qm', 'doc');
    const rc = hewtd('reconcile', 'api', '--json'); const t = JSON.parse(rc.stdout || rc.stderr);
    expect(t.docs.find((d: { path: string }) => d.path === 'api/fresh.md').lane).toBe('check');
  });

  it('60 references: at most sources_max file-level entries, most-cited first; #symbol and :line fold in', () => {
    const refs = Array.from({ length: 60 }, (_, i) => `\`src/f${i}.ts\``);
    const body = refs.join(' ') + ' `src/f40.ts#v40` `src/f40.ts:3` `src/f40.ts` `src/f41.ts:9`';
    expect(integrate('big.md', body).status).toBe(0);
    const s = sources_of(landed('big.md'));
    expect(s).toHaveLength(10);
    expect(s.slice(0, 2)).toEqual(['src/f40.ts', 'src/f41.ts']);
    expect(s.every((x) => /^src\/f\d+\.ts$/.test(x))).toBe(true);
    expect(new Set(s).size).toBe(10);
  });

  it('keeps hand-written sources and never removes one', () => {
    put('inbox/hand.md', `---\ntitle: hand\ndomains:\n  - api\nsources:\n  - docs/by-hand.md\n  - src/f2.ts\n---\n\n# hand\n\nSee \`src/f3.ts\`.\n`);
    expect(hewtd('integrate', 'inbox/hand.md', '-a', '-d', 'api').status).toBe(0);
    expect(sources_of(landed('hand.md'))).toEqual(['docs/by-hand.md', 'src/f2.ts', 'src/f3.ts']);
  });

  it('sources values are not searchable', () => {
    integrate('only-in-sources.md', 'See `src/f7.ts`.');
    expect(sources_of(landed('only-in-sources.md'))).toEqual(['src/f7.ts']);
    const body = read(landed('only-in-sources.md'));
    // the body also names the path, so rewrite it: the path must survive only in frontmatter
    put(landed('only-in-sources.md'), body.replace('See `src/f7.ts`.', 'See the seven file.'));
    expect(hewtd('reconcile', '--overview', 'seven file', '--json').stdout).toContain('only-in-sources.md'); // control: search finds the doc
    const r = hewtd('reconcile', '--overview', 'src/f7.ts', '--json');
    expect(r.stdout + r.stderr).not.toContain('only-in-sources.md');
  });
});
