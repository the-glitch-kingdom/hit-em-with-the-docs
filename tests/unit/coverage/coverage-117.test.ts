import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { plugin_config_schema } from '../../../src/utils/config.js';
import { run_coverage, type CoverageReport } from '../../../src/core/coverage/coverage.js';

let repo: string;
const w = (p: string, t: string): void => { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), t); };
const cli = (args: string[]) => spawnSync('node', [join(resolve(__dirname, '../../..'), 'dist/cli/index.js'), ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: repo } });
const config_with = (extra: object = {}) => plugin_config_schema.parse(extra);
let report: CoverageReport;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'coverage-117-'));
  w('.documentation/ops/uploads.md', '---\ntitle: Uploads\ntier: guide\ndomains: [ops]\nstatus: active\nsources: [src/limits.ts]\n---\n# Uploads\n\nSee MAX_UPLOAD_BYTES.\n');
  w('src/limits.ts', 'export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;\nexport const RETRY_LIMIT = 5;\nexport const DEBUG_LIMIT = 9;\nexport const DB_PORT = 5432;\n');
  w('app/tasks.py', '@shared_task(bind=True)\ndef send_receipt(self):\n    pass\n');
  w('ops/crontab', '*/5 * * * * /opt/app/bin/rotate_logs --all\n0 3 * * 1 root /usr/bin/vacuum_db\n0 4 * * * /opt/app/bin/purge_cache\n');
  w('legacy/old.py', '@shared_task\ndef old_job():\n    pass\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'init'], { cwd: repo });
  w('.claude/hit-em-with-the-docs.json', JSON.stringify({ coverage: { ignore: [{ path: 'legacy/**', reason: 'frozen' }, { name: 'DEBUG_LIMIT', reason: 'debug only' }] } }));
  report = await run_coverage({ repo_root: repo, docs_root: join(repo, '.documentation'), config: config_with({ coverage: { ignore: [{ path: 'legacy/**', reason: 'frozen' }, { name: 'DEBUG_LIMIT', reason: 'debug only' }, 'nothing/here'] } }), today: '2026-11-15' });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('run_coverage (#117)', () => {
  it('counts ignored surfaces as held, not as misses', () => {
    expect(report.held.total).toBe(2);
    expect(report.held.entries.map((e) => e.name).sort()).toEqual(['DEBUG_LIMIT', 'old_job']);
    expect(report.held.entries.find((e) => e.name === 'old_job')?.reason).toBe('frozen');
    expect(report.surfaces.some((s) => s.name === 'old_job' || s.name === 'DEBUG_LIMIT')).toBe(false);
  });
  it('grades and summarizes per kind and area', () => {
    expect(report.summary.by_kind.constant).toMatchObject({ total: 3 });
    expect(report.summary.by_kind['scheduled-job']!.absent).toBe(3);
  });
  it('a declared list gets "generate the reference" first and is not drafted one by one', () => {
    expect(report.generate_reference).toEqual([expect.objectContaining({ kind: 'schedules', file: 'ops/crontab', count: 3 })]);
    expect(JSON.stringify(report.plan?.drafts)).not.toContain('rotate_logs');
  });
  it('absent constants are stated from the located line, a named one extends its doc, other surfaces wait for the judge', () => {
    const entries = report.plan!.drafts.entries;
    const retry = entries.find((e) => JSON.stringify(e).includes('RETRY_LIMIT'));
    expect(JSON.stringify(retry)).toContain('is `5`');
    const upload = entries.find((e) => e.path === 'ops/uploads.md');
    expect(upload?.verdict).toBe('verify');
    expect(JSON.stringify(upload)).toContain('MAX_UPLOAD_BYTES');
    const receipt = entries.find((e) => JSON.stringify(e).includes('send_receipt'));
    expect(receipt).toMatchObject({ verdict: null });
    expect(receipt!.for_judge?.[0]?.at).toEqual(['app/tasks.py:2']);
  });
  it('a value-named constant is listed by name, its value never reaches the report or the drafts', () => {
    expect(report.surfaces.find((s) => s.name === 'DB_PORT')?.value).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain('5432');
  });
  it('never writes anything and never overwrites a doc', () => {
    expect(readFileSync(join(repo, '.documentation/ops/uploads.md'), 'utf-8')).toContain("See MAX_UPLOAD_BYTES.");
    expect(existsSync(join(repo, '.hewtd'))).toBe(false);
  });
});

describe('hewtd coverage (built CLI)', () => {
  const run = (extra: string[] = []) => cli(['coverage', '-p', '.documentation', ...extra]);
  it('prints the surface table and exits 0 without writing', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/constant\s+3/);
    expect(r.stdout).toMatch(/held/i);
    expect(existsSync(join(repo, '.hewtd/reconcile'))).toBe(false);
  });
  it('--json has the summary, held, generate_reference and coverage', () => {
    const out = JSON.parse(run(['--json']).stdout);
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['summary', 'held', 'generate_reference', 'surfaces', 'coverage']));
    expect(out.summary.total.total).toBeGreaterThan(5);
  });
  it('--write-review writes review-<batch>-coverage.md, unticked', () => {
    const out = JSON.parse(run(['--json', '--write-review']).stdout);
    expect(out.coverage_review).toMatch(/review-\d+-coverage\.md$/);
    expect(readFileSync(join(repo, out.coverage_review), 'utf-8')).not.toMatch(/- \[x\] accept/);
    expect(readdirSync(join(repo, '.documentation/ops'))).toEqual(['uploads.md']);
  });
});

describe('coverage without a docs folder (validation)', () => {
  it('grades every surface absent instead of failing on the missing folder', () => {
    const bare = mkdtempSync(join(tmpdir(), 'coverage-nodocs-'));
    try {
      writeFileSync(join(bare, 'limits.ts'), 'export const RETRY_LIMIT = 5;\n');
      execFileSync('git', ['init', '-q'], { cwd: bare });
      execFileSync('git', ['add', '-A'], { cwd: bare });
      execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'init'], { cwd: bare });
      const run = spawnSync('node', [join(resolve(__dirname, '../../..'), 'dist/cli/index.js'), 'coverage', '--json'], { cwd: bare, encoding: 'utf8', env: { ...process.env, HOME: bare } });
      expect(run.stderr).not.toMatch(/ENOENT/);
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout).summary.total.absent).toBe(1);
    } finally { rmSync(bare, { recursive: true, force: true }); }
  });
});
