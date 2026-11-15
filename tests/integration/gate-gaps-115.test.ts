import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// The release gate (scripts/gate-gaps.mjs) over the synthetic fixture (#115), through the built CLI.
const ROOT = resolve(__dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/gate-gaps.mjs');
const EXPECTED = join(ROOT, 'tests/fixtures/gaps-triage-115/expected.json');
const gate = (expected?: string) => spawnSync('node', [SCRIPT, ...(expected ? ['--expected', expected] : [])], { cwd: ROOT, encoding: 'utf-8', timeout: 120_000 });

beforeAll(() => { if (!existsSync(join(ROOT, 'dist/cli/index.js'))) throw new Error('run `npm run build` before the integration tests'); });

describe('gate:gaps', () => {
  it('passes on the shipped expectations', () => {
    const run = gate();
    expect(run.stdout).not.toMatch(/^FAIL/m);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/gate:gaps 31\/31/);
  }, 130_000);

  it('fails when an expectation is wrong (outcome, target, stated fact, source)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-broken-'));
    try {
      const broken = JSON.parse(readFileSync(EXPECTED, 'utf-8'));
      broken.cases.find((c: any) => c.id === 'best-coverage').doc = 'ops/queue-ops.md'; // the cited-by doc
      broken.cases.find((c: any) => c.id === 'topic-absent').kind = 'extend';
      broken.cases.find((c: any) => c.id === 'size').stated = ['not_in_the_code'];
      broken.cases.find((c: any) => c.id === 'numeric').sources = ['src/data/table_01.ts'];
      const file = join(dir, 'expected.json');
      writeFileSync(file, JSON.stringify(broken));
      const run = gate(file);
      expect(run.status).toBe(1);
      for (const id of ['best-coverage', 'topic-absent', 'size', 'numeric']) expect(run.stdout).toMatch(new RegExp(`^FAIL  ${id}`, 'm'));
      expect(run.stdout).toMatch(/gate:gaps 27\/31/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 130_000);

  it('fails when a case is deleted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-deleted-'));
    try {
      const broken = JSON.parse(readFileSync(EXPECTED, 'utf-8'));
      broken.cases.pop();
      const file = join(dir, 'expected.json');
      writeFileSync(file, JSON.stringify(broken));
      const run = gate(file);
      expect(run.status).toBe(1);
      expect(run.stdout).toMatch(/^FAIL  every fixture gap has a case.*no case for gap/m);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 130_000);

  it('fails every malformed expectation, naming the case', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-malformed-'));
    try {
      const forms: [string, (spec: any, all: any) => void][] = [
        ['no cases', (_s, all) => { all.cases = []; }],
        ['stated deleted', (s) => { delete s.stated; }],
        ['stated empty', (s) => { s.stated = []; }],
        ['draft typo', (s) => { s.draft = 'stated '; }],
        ['judge deleted', (s) => { s.draft = 'judge'; delete s.stated; delete s.judge; }],
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
