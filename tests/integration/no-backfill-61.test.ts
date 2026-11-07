import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, readdirSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// #61: upgrading / routine commands never add `sources`; only /reconcile does, and a secret never rides in on an apply.
const PKG = resolve(__dirname, '../..');
const CLI = join(PKG, 'dist/cli/index.js');
const val = 'sk' + '_live_' + 'Qz8rT2mVb4Xk9LpW3nYc7HdA';
let root: string;
const run = (script: string, ...a: string[]) =>
  spawnSync('node', [script, ...a], { cwd: root, encoding: 'utf8', input: '{}', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: root, INIT_CWD: root } });
const hewtd = (...a: string[]) => run(CLI, ...a);
const git = (...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const fm = (t: string, body = '') => `---\ntitle: ${t}\ndomains:\n  - backend\n---\n\n# ${t}\n\nSee \`src/real.ts\`.\n${body}`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nobf-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  put('src/real.ts', 'export const realThing = 1;\n');
  put('.documentation/backend/a.md', fm('a'));
  put('.documentation/backend/b.md', fm('b'));
  put('.gitignore', '.hewtd/\n');
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(root, 'node_modules/.bin/hewtd'), `#!/bin/sh\nexec node "${CLI}" "$@"\n`);
  chmodSync(join(root, 'node_modules/.bin/hewtd'), 0o755);
  put('.gitignore', '.hewtd/\nnode_modules/\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('no backfill', () => {
  it('postinstall, SessionStart hooks and routine commands leave committed docs untouched', () => {
    hewtd('index'); // generated indexes are part of the committed baseline
    git('add', '-A'); git('commit', '-qm', 'init');
    run(join(PKG, 'scripts/link-skills.js'));
    run(join(PKG, 'hooks/session-start.js'));
    run(join(PKG, 'hooks/session-brief.js'));
    for (const c of [['index'], ['maintain', '--quick'], ['metadata-sync'], ['audit']]) hewtd(...c);
    // maintain writes an untracked reports/ dir (not a doc); everything tracked must be unchanged
    expect(git('status', '--porcelain', '--', '.documentation', ':!.documentation/reports').stdout).toBe('');
    for (const f of ['a', 'b']) expect(readFileSync(join(root, `.documentation/backend/${f}.md`), 'utf-8')).not.toContain('sources');
  });

  it('reconcile --apply: fields on a legacy secret doc commits with the hook; a patch adding a secret is refused', () => {
    put('.documentation/backend/a.md', fm('a', `\nkey ${val}\n`));
    git('add', '-A'); git('commit', '-qm', 'legacy');
    expect(hewtd('hooks', 'install').status).toBe(0);
    hewtd('reconcile', 'backend', '--write-review');
    // a doc holding a secret is reviewed in its own file, so fill every review file
    const fs = readdirSync(join(root, '.hewtd/reconcile')).filter((x) => /^review-.*\.md$/.test(x)).map((x) => join(root, '.hewtd/reconcile', x));
    const fill = (fn: (p: string) => Record<string, unknown> | null) => fs.forEach((f) => writeFileSync(f, readFileSync(f, 'utf-8').split(/^(?=## )/m).map((sec) => {
      const m = /```json\n([\s\S]*?)\n```/.exec(sec);
      if (!m) return sec;
      const e = JSON.parse(m[1]!); const p = fn(e.path);
      return p ? sec.replace(m[1]!, JSON.stringify({ ...e, ...p }, null, 2)).replace('- [ ] accept', '- [x] accept') : sec;
    }).join('')));

    const head = git('rev-parse', 'HEAD').stdout;
    fill((p) => (p === 'backend/a.md' ? { verdict: 'fields', frontmatter: { purpose: 'Explains the a module for the backend service pipeline end to end' } } : null));
    const ok = hewtd('reconcile', '--apply', ...fs);
    expect(ok.status).toBe(0);
    expect(git('rev-parse', 'HEAD').stdout).not.toBe(head); // committed through the hook
    expect(readFileSync(join(root, '.documentation/backend/a.md'), 'utf-8')).toContain('purpose:');

    const head2 = git('rev-parse', 'HEAD').stdout;
    fill((p) => (p === 'backend/b.md' ? { verdict: 'verify', sources: ['src/real.ts'], patch: [{ old: 'See `src/real.ts`.', new: `See \`src/real.ts\`. key ${val}` }] } : null));
    const bad = hewtd('reconcile', '--apply', ...fs);
    expect(bad.stdout + bad.stderr).not.toContain(val.slice(4));
    expect(git('rev-parse', 'HEAD').stdout).toBe(head2);
    expect(readFileSync(join(root, '.documentation/backend/b.md'), 'utf-8')).not.toContain(val.slice(4));
  });
});
