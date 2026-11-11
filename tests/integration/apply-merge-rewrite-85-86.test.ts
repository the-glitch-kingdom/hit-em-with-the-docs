import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// #85 #86 through the built CLI: sources merge, sources_remove, a rewrite lands the draft, re-apply and stale.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
const hewtd = (...a: string[]) => spawnSync('node', [CLI, ...a], { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: root, INIT_CWD: root } });
const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf8' }).stdout.trim();
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const read = (rel: string) => readFileSync(join(root, '.documentation', rel), 'utf-8');
const doc = (t: string, extra = '') => `---\ntitle: ${t}\ndomains:\n  - backend\n${extra}---\n\n# ${t}\n\nSee \`src/a.ts\`.\n`;
const sources_of = (rel: string) => (/sources:\n((?:\s+- .*\n)+)/.exec(read(rel))?.[1] ?? '').split('\n').map((l) => l.replace(/^\s+- /, '').replace(/^['"]|['"]$/g, '')).filter(Boolean);
const review_files = () => readdirSync(join(root, '.hewtd/reconcile')).filter((x) => /^review-.*\.md$/.test(x)).map((x) => join(root, '.hewtd/reconcile', x));
// fill the written skeleton: patch each entry by path and tick accept
const fill = (fn: (path: string) => Record<string, unknown> | null) => review_files().forEach((f) => writeFileSync(f, readFileSync(f, 'utf-8').split(/^(?=## )/m).map((sec) => {
  const m = /```json\n([\s\S]*?)\n```/.exec(sec);
  if (!m) return sec;
  const e = JSON.parse(m[1]!); const p = fn(e.path);
  return p ? sec.replace(m[1]!, JSON.stringify({ ...e, ...p }, null, 2)).replace('- [ ] accept', '- [x] accept') : sec;
}).join('')));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mr8586-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const n of ['a', 'b', 'c']) put(`src/${n}.ts`, `export const ${n}_thing = 1;\n`);
  put('.documentation/backend/a.md', doc('a', 'sources:\n  - src/a.ts\n  - src/b.ts\n'));
  put('.documentation/backend/b.md', doc('b', 'sources:\n  - src/a.ts\n  - src/b.ts\n'));
  put('.documentation/backend/r.md', doc('r', 'owner: keep-me\nsources:\n  - src/a.ts\n') + '\n## Old heading\n\nold text\n');
  put('.gitignore', '.hewtd/\n');
  git('add', '-A'); git('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('apply through the CLI (#85 #86)', () => {
  it('merges sources, honours sources_remove, lands a rewrite, then already-applied and stale', () => {
    hewtd('reconcile', 'backend', '--write-review');
    fill((p) => ({
      'backend/a.md': { verdict: 'verify', sources: ['src/c.ts', 'src/a.ts'] },
      'backend/b.md': { verdict: 'verify', sources: ['src/c.ts'], sources_remove: ['src/b.ts'] },
      'backend/r.md': { verdict: 'rewrite', draft: '# r rewritten\n\nNew body about `src/c.ts`.\n', frontmatter: { purpose: 'explains r' }, sources: ['src/c.ts'] },
    } as Record<string, Record<string, unknown>>)[p] ?? null);
    const head = git('rev-parse', 'HEAD');
    const res = hewtd('reconcile', '--apply', ...review_files());
    expect(res.status).toBe(0);
    expect(git('rev-parse', 'HEAD')).not.toBe(head);
    expect(sources_of('backend/a.md')).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(sources_of('backend/b.md')).toEqual(['src/a.ts', 'src/c.ts']);
    const r = read('backend/r.md');
    expect(r).toContain('New body');
    expect(r).not.toContain('Old heading');
    expect(r).toContain('owner: keep-me');
    expect(r).toContain('purpose: explains r');
    expect(sources_of('backend/r.md')).toEqual(['src/a.ts', 'src/c.ts']);
    expect(git('log', '--name-only', '--format=', head + '..HEAD')).toContain('.documentation/backend/r.md');
    expect(existsSync(join(root, '.hewtd/reconcile/drafts'))).toBe(false);

    expect(hewtd('reconcile', '--apply', ...review_files()).stdout).toMatch(/already.applied/i);

    put('.documentation/backend/r.md', read('backend/r.md') + '\nhand edit\n');
    expect(hewtd('reconcile', '--apply', ...review_files()).stdout).toMatch(/stale/i);
  });

  it('an applied rewrite is reviewed: --changed and audit skip it until the doc is edited (#103)', () => {
    hewtd('reconcile', 'backend', '--write-review');
    fill((p) => ({
      'backend/a.md': { verdict: 'verify' },
      'backend/b.md': { verdict: 'verify' },
      'backend/r.md': { verdict: 'rewrite', draft: '# r rewritten\n\nNew body about `src/c.ts`.\n', sources: ['src/c.ts'] },
    } as Record<string, Record<string, unknown>>)[p] ?? null);
    expect(hewtd('reconcile', '--apply', ...review_files()).status).toBe(0);
    const changed = () => (JSON.parse(hewtd('reconcile', '--changed', '--json').stdout).docs as { path: string }[]).map((d) => d.path);
    expect(changed()).toEqual([]);
    const audit = hewtd('audit');
    expect(audit.stdout + audit.stderr).not.toMatch(/DOCS_UNREVIEWED/);
    put('.documentation/backend/r.md', read('backend/r.md') + '\nhand edit\n');
    expect(changed()).toEqual(['backend/r.md']);
  });

  it('--write-review on a named clean-lane doc writes its entry', () => {
    hewtd('reconcile', 'backend', '--write-review');
    expect(review_files().map((f) => readFileSync(f, 'utf-8')).join('')).toContain('## backend/a.md');
  });
});
