import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { load_plugin_config } from '../../src/utils/config';
import { validate_no_secrets } from '../../src/core/reconcile/secrets';

const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
// Built at runtime: the repo never holds a scannable literal.
const val = 'sk' + '_live_' + 'Qz8rT2mVb4Xk9LpW3nYc7HdA';
let root: string;
const hewtd = (...a: string[]) => spawnSync('node', [CLI, ...a], { cwd: root, encoding: 'utf8' });
const base = () => join(root, '.hewtd/secrets-baseline.json');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sbl-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, '.documentation'));
  writeFileSync(join(root, '.documentation/a.md'), `# A\n\nfixture key ${val}\n`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('secrets baseline', () => {
  it('refuses without a reason and when no finding is on the line', () => {
    expect(hewtd('secrets', '--baseline-add', '.documentation/a.md:3').status).toBe(1);
    expect(hewtd('secrets', '--baseline-add', '.documentation/a.md:1', '--reason', 'x').status).toBe(1);
  });

  it('baselines a finding: no value in the file, and every check honours it', async () => {
    const text = readFileSync(join(root, '.documentation/a.md'), 'utf-8');
    await expect(load_plugin_config(root).then((c) => validate_no_secrets(text, 'a.md', c.reconcile.secrets))).rejects.toThrow();
    const r = hewtd('secrets', '--baseline-add', '.documentation/a.md:3', '--reason', 'test fixture');
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(val);
    const raw = readFileSync(base(), 'utf-8');
    expect(raw).not.toContain(val);
    expect(raw).not.toContain(val.slice(4));
    expect(JSON.parse(raw).entries[0]).toMatchObject({ rule: 'stripe-key', file: '.documentation/a.md', reason: 'test fixture' });
    const cfg = (await load_plugin_config(root)).reconcile.secrets;
    expect(() => validate_no_secrets(text, 'elsewhere.md', cfg)).not.toThrow();
  });

  it('prune drops stale entries and keeps live ones', () => {
    hewtd('secrets', '--baseline-add', '.documentation/a.md:3', '--reason', 'fixture');
    expect(hewtd('secrets', '--baseline-prune').status).toBe(0);
    expect(JSON.parse(readFileSync(base(), 'utf-8')).entries).toHaveLength(1);
    writeFileSync(join(root, '.documentation/a.md'), '# A\n\nclean\n');
    hewtd('secrets', '--baseline-prune');
    expect(JSON.parse(readFileSync(base(), 'utf-8')).entries).toHaveLength(0);
  });

  it('hints when the baseline is gitignored', () => {
    writeFileSync(join(root, '.gitignore'), '.hewtd/\n');
    expect(hewtd('secrets', '--baseline-add', '.documentation/a.md:3', '--reason', 'fixture').stdout + '').toMatch(/git add -f/);
  });
});
