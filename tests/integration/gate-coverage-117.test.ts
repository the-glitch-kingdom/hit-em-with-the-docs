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
    expect(run.stdout).toMatch(/gate:coverage 36\/36/);
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

  it('fails a malformed spec: an empty ignored_files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-cov-malformed-'));
    try {
      const broken = JSON.parse(readFileSync(EXPECTED, 'utf-8'));
      broken.ignored_files = [];
      const file = join(dir, 'expected.json');
      writeFileSync(file, JSON.stringify(broken));
      const run = gate(file);
      expect(run.status).toBe(1);
      expect(run.stdout).toMatch(/^FAIL  generated files.*non-empty list/m);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 130_000);

  it('fails a deleted draft, a deleted case and an unexpected surface', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-cov-complete-'));
    try {
      const file = join(dir, 'expected.json');
      const run_with = (mutate: (all: any) => void) => {
        const broken = JSON.parse(readFileSync(EXPECTED, 'utf-8'));
        mutate(broken);
        writeFileSync(file, JSON.stringify(broken));
        const run = gate(file);
        return { status: run.status, text: run.stdout + run.stderr };
      };
      const no_draft = run_with((all) => { delete all.cases[0].draft; });
      expect(no_draft.status).not.toBe(0);
      expect(no_draft.text).toMatch(/malformed expectation[\s\S]*draft is required/);
      const no_case = run_with((all) => { all.cases = all.cases.filter((c: any) => c.kind !== 'cli-flag'); });
      expect(no_case.status).toBe(1);
      expect(no_case.text).toMatch(/^FAIL  every detector kind has a case.*no case for detector kind cli-flag/m);
      const unexpected = run_with((all) => { all.unscored = all.unscored.slice(1); });
      expect(unexpected.status).toBe(1);
      expect(unexpected.text).toMatch(/^FAIL  every detector kind.*unexpected surface/m);
      const no_reason = run_with((all) => { delete all.unscored[0].reason; });
      expect(no_reason.status).not.toBe(0);
      expect(no_reason.text).toMatch(/unscored must be/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 130_000);

  it('fails every malformed expectation, naming the case', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-cov-malformed2-'));
    try {
      const forms: [string, (spec: any, all: any) => void][] = [
        ['no cases', (_s, all) => { all.cases = []; }],
        ['stated deleted', (s) => { delete s.stated; }],
        ['stated empty', (s) => { s.stated = []; }],
        ['draft typo', (s) => { s.draft = 'stated '; }],
        ['unknown key', (s) => { s.statd = ['x']; }],
      ];
      for (const [label, mutate] of forms) {
        const broken = JSON.parse(readFileSync(EXPECTED, 'utf-8'));
        const spec = broken.cases.find((c: any) => c.draft === 'stated');
        mutate(spec, broken);
        const file = join(dir, 'expected.json');
        writeFileSync(file, JSON.stringify(broken));
        const run = gate(file);
        expect(run.status, label).not.toBe(0);
        expect(run.stderr + run.stdout, label).toMatch(/malformed expectation/);
        if (label !== 'no cases') expect(run.stderr + run.stdout, label).toContain(spec.id);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 130_000);
});
