import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// #117 targets.code_coverage: opt-in, advisory, one row per surface kind (built CLI).
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
const hewtd = (...args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root } });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const rows = () => (JSON.parse(hewtd('audit', '--json').stdout).targets.rows as { id: string; value: number; total: number; met: boolean; held: number }[]);

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cov-target-117-'));
  put('src/limits.ts', 'export const RETRY_LIMIT = 5;\nexport const OLD_LIMIT = 7;\n');
  put('.documentation/ops/limits.md', '---\ntitle: Limits\ntier: guide\nstatus: active\ndomains:\n  - ops\nsources:\n  - src/limits.ts\n---\n\n# Limits\n\nThe RETRY_LIMIT constant is 5 and caps how many times a failed send is retried.\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('targets.code_coverage (#117)', () => {
  it('no row until it is set', () => {
    expect(rows().some((row) => row.id.startsWith('code_coverage'))).toBe(false);
  });
  it('set: an advisory row per surface kind; ignored surfaces are held; audit still exits 0', () => {
    const baseline = hewtd('audit', '--strict').status;
    put('.claude/hit-em-with-the-docs.json', JSON.stringify({ targets: { code_coverage: { min: 0.9 } } }));
    const row = rows().find((r) => r.id === 'code_coverage_constant')!;
    expect(row).toMatchObject({ value: 1, total: 2, met: false, held: 0 });
    expect(hewtd('audit', '--strict').status).toBe(baseline); // an unmet code row never changes the exit code
    put('.claude/hit-em-with-the-docs.json', JSON.stringify({ targets: { code_coverage: { min: 0.9 } }, coverage: { ignore: [{ name: 'OLD_LIMIT', reason: 'dead' }] } }));
    expect(rows().find((r) => r.id === 'code_coverage_constant')).toMatchObject({ value: 1, total: 1, met: true, held: 1 });
  });
});
