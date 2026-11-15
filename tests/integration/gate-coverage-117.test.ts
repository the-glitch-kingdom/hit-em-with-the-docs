import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// The release gate (scripts/gate-coverage.mjs) over the synthetic fixture (#117), through the built CLI.
const ROOT = resolve(__dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/gate-coverage.mjs');
const EXPECTED = join(ROOT, 'tests/fixtures/coverage-117/expected.json');
const gate = (expected?: string) => spawnSync('node', [SCRIPT, ...(expected ? ['--expected', expected] : [])], { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 });

beforeAll(() => { if (!existsSync(join(ROOT, 'dist/cli/index.js'))) throw new Error('run `npm run build` before the integration tests'); });

describe('gate:coverage', () => {
  it('passes on the shipped expectations', () => {
    const run = gate();
    expect(run.stdout).not.toMatch(/^FAIL/m);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/gate:coverage 35\/35/);
  }, 130_000);

  it('is wired into package.json, prepublishOnly and CI', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    expect(pkg.scripts['gate:coverage']).toContain('gate-coverage.mjs');
    expect(pkg.scripts.prepublishOnly).toContain('npm run gate:coverage');
    expect(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf-8')).toContain('node scripts/gate-coverage.mjs');
  });

  it('fails when an expectation is wrong (grade, outcome, target, stated value, held, reference)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-cov-broken-'));
    try {
      const broken = JSON.parse(readFileSync(EXPECTED, 'utf-8'));
      const find = (id: string) => broken.cases.find((c: any) => c.id === id);
      find('crontab').grade = 'named';
      find('code-constant-explained').grade = 'named';
      find('prometheus-named').outcome = 'new';
      find('code-constant-absent').doc = 'ops/alerts.md';
      find('code-constant-named').stated = [{ name: 'PAGE_SIZE', value: '51' }];
      broken.held = [{ name: 'RETRY_LIMIT', reason: 'x' }];
      broken.generate_reference[0].count = 4;
      const file = join(dir, 'expected.json');
      writeFileSync(file, JSON.stringify(broken));
      const run = gate(file);
      expect(run.status).toBe(1);
      for (const id of ['crontab', 'code-constant-explained', 'prometheus-named', 'code-constant-absent', 'code-constant-named', 'ignore list', 'declared list']) expect(run.stdout).toMatch(new RegExp(`^FAIL  ${id}`, 'm'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 130_000);
});
