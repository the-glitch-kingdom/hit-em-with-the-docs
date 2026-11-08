import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

// Format regression for the snake_case rename: serialized output must not change with identifier names.
// Snapshots were generated from the pre-rename build. Regenerate only on purpose: UPDATE_FORMAT_SNAPSHOTS=1.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const SNAP = join(__dirname, '__snapshots__', 'naming-formats');
const update = process.env.UPDATE_FORMAT_SNAPSHOTS === '1';
let root: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const fm = (t: string, body: string, extra = '') => `---\ntitle: ${t}\ndomains:\n  - backend\ntier: guide\nlast_verified: "2026-01-01"\n${extra}---\n\n# ${t}\n\n${body}\n`;

// Dates, times, the temp root and git hashes vary per run.
const normalize = (s: string): string =>
  s.split(root).join('<ROOT>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:-]+(?:\.\d+)?Z?/g, '<TS>')
    .replace(/\b20\d{2}-\d{2}-\d{2}\b/g, '<DATE>')
    .replace(/\b[0-9a-f]{40}\b/g, '<SHA>')
    .replace(/\b[0-9a-f]{7,12}\b(?=[\s",])/g, (m) => (/\d/.test(m) && /[a-f]/.test(m) ? '<SHA>' : m))
    .replace(/\/tmp\/[^\s"']+/g, '<TMP>');
const check = (name: string, actual: string): void => {
  const file = join(SNAP, name);
  const text = normalize(actual);
  if (update) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); return; }
  expect(existsSync(file), `missing snapshot ${name}`).toBe(true);
  expect(text).toBe(readFileSync(file, 'utf-8'));
};
const json = (args: string[]): string => {
  const r = hewtd(args);
  return `exit ${r.status}\n${r.stdout}`;
};

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests');
  root = mkdtempSync(join(tmpdir(), 'fmt-'));
  const key = 'AK' + 'IA' + 'ZXCVBNMASDFGHJKL';
  const hvs = 'hv' + 's.' + 'q7Zx3Lm9Pw2Rt8Vb5Nc1';
  put('.gitignore', '.hewtd/\n');
  put('src/auth.ts', 'export function requireRole(role: string) { return role; }\n');
  put('src/creds.ts', `export const k = '${key}';\n`);
  put('src/deployHelper.ts', 'export const x = 1;\n');
  put('.documentation/backend/auth.md', fm('Auth', 'Uses `requireRole()` in `src/auth.ts`. See [deploy](deploy.md) and [missing](missing.md).'));
  put('.documentation/backend/deploy.md', fm('Deploy', 'Roll back a bad deploy via `src/deployHelper.ts`; also `src/gone.ts`.'));
  put('.documentation/backend/creds.md', fm('Creds', 'See `src/creds.ts`.'));
  put('.documentation/backend/leak.md', fm('Leak', `token ${hvs}`));
  put('.documentation/backend/old.md', fm('Old', 'Stale thing.', 'last_updated: "2020-01-01"\n'));
  put('.documentation/frontend/ui.md', '---\ntitle: UI\ndomains:\n  - frontend\n---\n\n# UI\n\nLinks to [auth](../backend/auth.md).\n');
  put('gaps.json', JSON.stringify({ version: 1, source: 'test', gaps: [{ query: 'how do I roll back a bad deploy?', used_doc: 'backend/deploy.md', count: 3 }, { query: 'where is the zzz', used_doc: null }] }));
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('serialized formats are stable across the rename', () => {
  it('reconcile --next, --secrets, audit', () => {
    check('reconcile-next.json', json(['reconcile', '--next', '1000', '--json']));
    check('reconcile-secrets.json', json(['reconcile', '--secrets', '--json']));
    const audit = hewtd(['audit', '-r']);
    check('audit.txt', `exit ${audit.status}\n${audit.stdout}`);
    const reports = join(root, '.documentation/reports');
    const report = readdirSync(reports).find((f) => f.startsWith('audit-'));
    // Row order depends on file-read timing, so compare the sorted lines.
    check('audit-report.md', readFileSync(join(reports, report as string), 'utf-8').split('\n').sort().join('\n'));
  });

  it('index output files and graph.json', () => {
    expect(hewtd(['index']).status).toBe(0);
    const files = (readdirSync(join(root, '.documentation'), { recursive: true }) as string[]).filter((f) => /(INDEX|REGISTRY)\.md$/.test(f)).sort();
    expect(files.length).toBeGreaterThan(0);
    check('index-files.txt', files.map((f) => `=== ${f}\n${readFileSync(join(root, '.documentation', f), 'utf-8')}`).join('\n'));
    check('graph.json', readFileSync(join(root, '.hewtd/graph.json'), 'utf-8'));
  });

  it('gaps json and a written review file', () => {
    check('reconcile-gaps.json', json(['reconcile', '--gaps', 'gaps.json', '--json']));
    const r = JSON.parse(hewtd(['reconcile', '--gaps', 'gaps.json', '--write-review', '--json']).stdout) as { review: string };
    check('gaps-review.md', readFileSync(join(root, r.review), 'utf-8'));
    const next = hewtd(['reconcile', '--next', '2', '--write-review']);
    expect(next.status).toBe(0);
    const dir = join(root, '.hewtd/reconcile');
    const reviews = (readdirSync(dir) as string[]).filter((f) => /^review/.test(f)).sort();
    expect(reviews.length).toBeGreaterThan(0);
    check('review-files.txt', reviews.map((f) => `=== ${f}\n${readFileSync(join(dir, f), 'utf-8')}`).join('\n'));
  });
});
