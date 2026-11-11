import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// #109 acceptance through the built CLI. Every secret-shaped value is built at runtime.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const SECRET = 'hv' + 's.' + 'q7Zk3XpL9mWd2RtY8vNb4HcJ6a';
let root: string;
let home: string;
const hewtd = (...args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home } });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const config_path = () => join(root, '.claude/hit-em-with-the-docs.json');
const set_config = (config: unknown) => put('.claude/hit-em-with-the-docs.json', JSON.stringify(config));
const today = new Date().toISOString().slice(0, 10);
const doc = (title: string, purpose: string, body: string, extra = '') =>
  `---\ntitle: ${title}\ntier: guide\nstatus: active\nversion: 1.0.0\nlast_updated: ${today}\ndomains:\n  - backend\npurpose: ${purpose}\nlast_verified: ${extra || today}\nsources:\n  - src/real.ts\n---\n\n# ${title}\n\n${body}\n`;
const rows = (): Record<string, { value: number; total: number; met: boolean; next?: string; held?: number }> => {
  const result = hewtd('audit', '--json');
  const parsed = JSON.parse(result.stdout);
  return Object.fromEntries(parsed.targets.rows.map((row: { id: string }) => [row.id, row]));
};

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'targets109-'));
  home = mkdtempSync(join(tmpdir(), 'targets109-home-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  put('src/real.ts', 'export const a = 1;\n');
  put('.documentation/backend/good.md', doc('Good', 'Explains when to rotate the signing keys and who approves it.', 'Body text for the good doc, long enough.'));
  put('.documentation/backend/copy.md', doc('Copy', 'This paragraph is copied word for word into the purpose field of the doc.', 'This paragraph is copied word for word into the purpose field of the doc.'));
  put('.documentation/backend/old.md', doc('Old', 'Explains how the legacy importer maps columns to the new schema.', 'See `src/gone.ts` and `src/missing.ts` and `src/nope.ts`.', '2020-01-01'));
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: root });
});
afterEach(() => { for (const dir of [root, home]) rmSync(dir, { recursive: true, force: true }); });

describe('#109 init and upgrade-check write the targets block', () => {
  it('init writes targets with defaults and a reason for each, and never overwrites an existing block', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'targets109-init-'));
    try {
      expect(spawnSync('node', [CLI, 'init'], { cwd: fresh, encoding: 'utf8', env: { ...process.env, HOME: home } }).status).toBe(0);
      const config = JSON.parse(readFileSync(join(fresh, '.claude/hit-em-with-the-docs.json'), 'utf8'));
      expect(config.targets.purpose_real).toMatchObject({ min: 0.9 });
      expect(config.targets.verified.min).toBe(0.8);
      expect(config.targets.unreviewed.max).toBe(0);
      expect(config.targets.flows).toEqual([]);
      for (const key of ['purpose_real', 'verified', 'no_missing_refs', 'unreviewed', 'secrets', 'archive_candidates']) expect(config.targets[key].reason).toBeTruthy();
    } finally { rmSync(fresh, { recursive: true, force: true }); }
  });
  it('init keeps an existing targets block', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'targets109-init2-'));
    try {
      mkdirSync(join(fresh, '.claude'));
      writeFileSync(join(fresh, '.claude/hit-em-with-the-docs.json'), JSON.stringify({ targets: { verified: { min: 0.5, reason: 'mine' } } }));
      spawnSync('node', [CLI, 'init'], { cwd: fresh, encoding: 'utf8', env: { ...process.env, HOME: home } });
      expect(JSON.parse(readFileSync(join(fresh, '.claude/hit-em-with-the-docs.json'), 'utf8')).targets).toEqual({ verified: { min: 0.5, reason: 'mine' } });
    } finally { rmSync(fresh, { recursive: true, force: true }); }
  });
  it('upgrade-check --fix adds targets at its defaults', () => {
    set_config({ last_upgrade_check: '3.3.0' });
    const npm_root = mkdtempSync(join(tmpdir(), 'targets109-npm-'));
    try {
      expect(spawnSync('node', [CLI, 'upgrade-check', '--fix'], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home, HEWTD_NPM_ROOT: npm_root } }).status).toBe(0);
      expect(JSON.parse(readFileSync(config_path(), 'utf8')).targets.verified.min).toBe(0.8);
    } finally { rmSync(npm_root, { recursive: true, force: true }); }
  });
});

describe('#109 audit Targets section', () => {
  it('prints the table with met / not met and one next command per unmet target', () => {
    const result = hewtd('audit');
    expect(result.stdout).toContain('Targets');
    expect(result.stdout).toMatch(/purpose/i);
    expect(result.stdout).toContain('hewtd reconcile --next');
    expect(result.stdout).toContain('does not mean retrieval targets are met');
  });
  it('--json carries value, total, target, met and next per metric', () => {
    const r = rows();
    expect(r.purpose_real).toMatchObject({ value: 2, total: 3, met: false });
    expect(r.purpose_real!.next).toContain('reconcile --next');
    expect(r.verified).toMatchObject({ value: 2, total: 3, met: false });
    expect(r.no_missing_refs).toMatchObject({ value: 2, total: 3, met: false });
    expect(r.no_missing_refs!.next).toBeTruthy();
    expect(r.secrets).toMatchObject({ value: 0, met: true });
    expect(r.secrets!.next).toBeUndefined();
    expect(r.flows).toBeUndefined(); // empty flows list: not applicable
  });
  it('is advisory: unmet targets never fail audit or --strict', () => {
    expect(hewtd('audit', '--strict').status).toBe(0);
    expect(hewtd('audit').status).toBe(0);
  });
  it('a configured target is honoured', () => {
    set_config({ targets: { purpose_real: { min: 0.5, reason: 'r' } } });
    expect(rows().purpose_real!.met).toBe(true);
  });
  it('counts unreviewed docs over the same active set as the other targets (a draft is not counted)', () => {
    const before = rows().unreviewed!;
    put('.documentation/drafts/wip.md', doc('Wip', 'Explains a draft that is not active yet and should not be counted.', 'Draft body.'));
    expect(rows().unreviewed).toMatchObject({ value: before.value, total: before.total });
  });
  it('counts a secret-lane doc, and counts a held one apart from the failures', () => {
    put('.documentation/backend/leak.md', doc('Leak', 'Explains how the deploy token is injected into the runner.', `VAULT_TOKEN=${SECRET}`));
    expect(rows().secrets).toMatchObject({ value: 1, met: false });
    expect(rows().secrets!.next).toContain('reconcile --secrets');
    set_config({ targets: { held: [{ path: 'backend/leak.md', reason: 'rotation pending' }] } });
    const held = rows();
    expect(held.secrets).toMatchObject({ value: 0, met: true, held: 1 });
    expect(JSON.stringify(JSON.parse(hewtd('audit', '--json').stdout).targets)).not.toContain(SECRET);
  });
  it('lists flows without an overview doc, and meets once one exists; empty flows is not applicable', () => {
    set_config({ targets: { flows: ['Billing', 'Onboarding'] } });
    put('.documentation/backend/billing-overview.md', doc('Billing overview', 'Explains how the billing flow fits together end to end.', 'x').replace('tier: guide', 'tier: guide\nkind: overview'));
    const r = rows();
    expect(r.flows).toMatchObject({ value: 1, total: 2, met: false });
    expect(JSON.parse(hewtd('audit', '--json').stdout).targets.rows.find((row: { id: string }) => row.id === 'flows').missing).toEqual(['Onboarding']);
    expect(r.flows!.next).toContain('overview');
  });
});
