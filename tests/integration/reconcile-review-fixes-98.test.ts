import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// #98 review fixes: hewtd's own commits pass the review hook, one "unreviewed" rule without a ledger, one rule across surfaces.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
let extra_dirs: string[] = [];
const git_in = (cwd: string, env: Record<string, string>, ...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf-8', env: { ...process.env, ...env } }).trim();
const g = (...a: string[]) => git_in(root, {}, ...a);
const hewtd_in = (cwd: string, args: string[]) => spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
const hewtd = (args: string[]) => hewtd_in(root, args);
const put = (rel: string, text: string, cwd = root) => { mkdirSync(join(cwd, rel, '..'), { recursive: true }); writeFileSync(join(cwd, rel), text); };
const body = (title: string) => `# ${title}\n\nThis paragraph describes how ${title.toLowerCase()} works.\n\nCalls \`fetchUser()\` in \`src/user.ts\`.\n`;
const review_files = () => (existsSync(join(root, '.hewtd/reconcile')) ? readdirSync(join(root, '.hewtd/reconcile')).filter((f) => /^review-.*\.md$/.test(f)).sort() : []);
function fill(file: string): void {
  const path = join(root, '.hewtd/reconcile', file);
  const text = readFileSync(path, 'utf8')
    .replace(/```json\n([\s\S]*?)\n```/g, (_m, json) => '```json\n' + JSON.stringify({
      ...JSON.parse(json), verdict: 'verify', sources: ['src/user.ts'],
      frontmatter: { purpose: 'How do I fetch a user record from the store, and what does fetchUser return?', symptoms: ['user lookup returns nothing for a known id', 'fetchUser comes back empty'] },
    }, null, 2) + '\n```')
    .replaceAll('- [ ] accept', '- [x] accept');
  writeFileSync(path, text);
}
const changed_in = (cwd: string) => (JSON.parse(hewtd_in(cwd, ['reconcile', '--changed', '--json']).stdout).docs as { path: string }[]).map((d) => d.path);
const apply_latest = () => { fill(review_files().at(-1)!); return hewtd(['reconcile', '--apply', join(root, '.hewtd/reconcile', review_files().at(-1)!)]); };

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rfix-98-'));
  put('src/user.ts', 'export function fetchUser() { return 1; }\n');
  put('.gitignore', '.hewtd/\n');
  put('.documentation/api/old.md', body('Old guide'));
  put('.documentation/api/stable.md', body('Stable guide'));
  put('node_modules/.bin/hewtd', `#!/bin/sh\nexec node "${CLI}" "$@"\n`);
  chmodSync(join(root, 'node_modules/.bin/hewtd'), 0o755);
  put('.gitignore', '.hewtd/\nnode_modules/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
  expect(hewtd(['reconcile', 'api', '--write-review']).status).toBe(0);
  expect(apply_latest().status).toBe(0);
});
afterEach(() => { for (const dir of [root, ...extra_dirs]) rmSync(dir, { recursive: true, force: true }); extra_dirs = []; });

describe('hewtd commits pass the review hook (#98 finding 1)', () => {
  it('apply of an edited reviewed doc succeeds with require_review and the hook; a plain commit of an unreviewed edit is blocked', () => {
    put('.claude/hit-em-with-the-docs.json', JSON.stringify({ reconcile: { require_review: true } }));
    expect(hewtd(['hooks', 'install']).status).toBe(0);
    const old = join(root, '.documentation/api/old.md');
    writeFileSync(old, readFileSync(old, 'utf8') + '\nAn added paragraph about retries.\n');
    expect(hewtd(['reconcile', '--changed', '--write-review']).status).toBe(0);
    const applied = apply_latest();
    expect(applied.stdout + applied.stderr).not.toMatch(/rolled back/);
    expect(applied.status).toBe(0);
    expect(g('status', '--porcelain', '--', '.documentation/api/old.md')).toBe('');
    expect(g('log', '-3', '--format=%s')).toMatch(/docs\(reconcile\): changed batch/); // finding 4
    writeFileSync(old, readFileSync(old, 'utf8') + '\nAnother edit nobody reviewed.\n');
    g('add', '.documentation/api/old.md');
    const blocked = spawnSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', 'commit', '-qm', 'plain'], { cwd: root, encoding: 'utf8' });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stdout + blocked.stderr).toMatch(/not reviewed/);
  });

  it('--check returns 0 with a note when HEWTD_REVIEWED_COMMIT is set', () => {
    put('.claude/hit-em-with-the-docs.json', JSON.stringify({ reconcile: { require_review: true } }));
    put('.documentation/api/direct.md', body('Direct write'));
    const r = spawnSync('node', [CLI, 'reconcile', '--changed', '--check'], { cwd: root, encoding: 'utf8', env: { ...process.env, HEWTD_REVIEWED_COMMIT: '1' } });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/HEWTD_REVIEWED_COMMIT/);
  });
});

describe('no ledger: git fallback (#98 finding 2)', () => {
  it('a clone lists an edit committed after last_verified, and not an unedited reviewed doc', () => {
    const day = (d: string) => ({ GIT_COMMITTER_DATE: `${d}T12:00:00`, GIT_AUTHOR_DATE: `${d}T12:00:00` });
    const fm = (t: string) => `---\ntitle: ${t}\nlast_verified: 2026-01-01\n---\n${body(t)}`;
    put('.documentation/api/edited.md', fm('Edited guide'));
    put('.documentation/api/untouched.md', fm('Untouched guide'));
    g('add', '-A'); git_in(root, day('2026-01-01'), 'commit', '-qm', 'reviewed');
    put('.documentation/api/edited.md', fm('Edited guide') + '\nA later paragraph.\n');
    g('add', '-A'); git_in(root, day('2026-03-01'), 'commit', '-qm', 'edit');
    const clone = mkdtempSync(join(tmpdir(), 'rfix-98-clone-'));
    extra_dirs.push(clone);
    execFileSync('git', ['clone', '-q', root, clone]);
    expect(existsSync(join(clone, '.hewtd'))).toBe(false);
    const listed = changed_in(clone);
    expect(listed).toContain('api/edited.md');
    expect(listed).not.toContain('api/untouched.md');
    const audit = hewtd_in(clone, ['audit']);
    expect(audit.stdout + audit.stderr).toMatch(/DOCS_UNREVIEWED.*api\/edited\.md/s);
    expect(audit.stdout + audit.stderr).not.toMatch(/DOCS_UNREVIEWED[^\n]*untouched\.md/);
    const check = hewtd_in(clone, ['reconcile', '--changed', '--check']);
    expect(check.stdout + check.stderr).toMatch(/api\/edited\.md/);
    expect(check.stdout + check.stderr).not.toMatch(/untouched\.md/);
  });
});

describe('one predicate everywhere (#98 finding 3)', () => {
  it('--changed, audit and the hook check agree on a mixed fixture', () => {
    put('.documentation/api/legacy.md', `---\ntitle: Legacy\nlast_verified: 2099-01-01\n---\n${body('Legacy guide')}\nAlso \`loadUserV1()\`.\n`);
    g('add', '-A'); g('commit', '-qm', 'legacy');
    put('.documentation/api/fresh.md', body('Fresh guide'));
    put('.documentation/README.md', '# Docs readme\n\nWhere things live.\n');
    const old = join(root, '.documentation/api/old.md');
    writeFileSync(old, readFileSync(old, 'utf8') + '\nAn added paragraph about retries.\n');
    const expected = ['README.md', 'api/fresh.md', 'api/old.md'];
    expect(changed_in(root).sort()).toEqual(expected);
    const audit = (hewtd(['audit']).stdout + '').match(/DOCS_UNREVIEWED: ([^\n]*)/)![1]!;
    const check = (hewtd(['reconcile', '--changed', '--check']).stdout + hewtd(['reconcile', '--changed', '--check']).stderr).match(/not reviewed[^:]*: ([^\n]*?)\. Run/)![1]!;
    for (const text of [audit, check]) {
      for (const path of expected) expect(text).toContain(path);
      expect(text).not.toMatch(/legacy\.md|stable\.md/);
    }
  });
});
