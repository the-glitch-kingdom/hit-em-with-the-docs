import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { parse_frontmatter } from '../../src/utils/frontmatter.js';

// #98: integrate hands the author to reconcile instead of leaving a silent `check` doc.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const NEW = 'new-guide.md';
const DOC = '# User fetching\n\nThis paragraph describes how users are fetched from the store.\n\nCalls `fetchUser()` in `src/user.ts` and the removed `loadUserV1()`.\n';

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'integrate-98-'));
  put('src/user.ts', 'export function fetchUser() { return 1; }\n');
  put('.documentation/api/.gitkeep', '');
  put('.gitignore', '.hewtd/\n');
  put('src/legacy.ts', 'export function loadUserV1() { return 0; }\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
  rmSync(join(root, 'src/legacy.ts')); g('add', '-A'); g('commit', '-qm', 'remove loadUserV1');
  put(NEW, DOC); // untracked, as a draft usually is: a tracked copy would count as another mention of the removed symbol
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('hewtd integrate hands off to reconcile (#98)', () => {
  it('reports the missing ref and the next step, invents no purpose, adds no extra domain, copies', () => {
    const r = hewtd(['integrate', NEW, '-a', '-d', 'api', '--review']);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/Reconcile lane: check/);
    expect(r.stdout + r.stderr).toMatch(/missing reference: loadUserV1/);
    expect(r.stdout + r.stderr).toMatch(/\/hit-em-with-the-docs:reconcile api\/new-guide\.md/);
    expect(r.stdout + r.stderr).toMatch(/copied, not moved/);
    expect(existsSync(join(root, NEW))).toBe(true);
    const { data } = parse_frontmatter<Record<string, unknown>>(readFileSync(join(root, '.documentation/api', NEW), 'utf8'));
    expect(data.purpose).toBeUndefined();
    expect(data.domains).toEqual(['api']);
    expect(data.last_verified).toBeUndefined();
    const reviews = readdirSync(join(root, '.hewtd/reconcile')).filter((f) => /^review-.*\.md$/.test(f));
    expect(reviews).toHaveLength(1);
    expect(readFileSync(join(root, '.hewtd/reconcile', reviews[0]!), 'utf8')).toContain('api/new-guide.md');
  });

  it('keeps an author-written purpose and their extra domain', () => {
    put('own.md', '---\ntitle: Own\npurpose: How do I fetch a user?\ndomains: [api, security]\n---\n\n# Own\n\nBody.\n');
    expect(hewtd(['integrate', 'own.md', '-a', '-d', 'api']).status).toBe(0);
    const { data } = parse_frontmatter<Record<string, unknown>>(readFileSync(join(root, '.documentation/api/own.md'), 'utf8'));
    expect(data.purpose).toBe('How do I fetch a user?');
    expect(data.domains).toEqual(['api', 'security']);
  });

  it('after verify + external_refs the reviewed doc reaches the clean lane', () => {
    hewtd(['integrate', NEW, '-a', '-d', 'api', '--review']);
    rmSync(join(root, NEW)); // the copy stays on disk by design; drop it before committing
    g('add', '-A'); g('commit', '-qm', 'add doc');
    const file = join(root, '.hewtd/reconcile', readdirSync(join(root, '.hewtd/reconcile')).find((f) => /^review-.*\.md$/.test(f))!);
    const text = readFileSync(file, 'utf8').replace(/```json\n([\s\S]*?)\n```/, (_m, json) => '```json\n' + JSON.stringify({
      ...JSON.parse(json), verdict: 'verify', sources: ['src/user.ts'], external_refs: ['loadUserV1'],
      frontmatter: { purpose: 'How do I fetch a user record from the store, and what does fetchUser return?', symptoms: ['user lookup returns nothing for a known id', 'fetchUser comes back empty'] },
    }, null, 2) + '\n```').replace('- [ ] accept', '- [x] accept');
    writeFileSync(file, text);
    const applied = hewtd(['reconcile', '--apply', file]);
    expect(applied.status).toBe(0);
    const triage = JSON.parse(hewtd(['reconcile', 'api', '--json']).stdout);
    const entry = triage.docs.find((d: { path: string }) => d.path === 'api/new-guide.md');
    expect([entry.lane, entry.reasons]).toEqual(['clean', []]);
  });
});

describe('templates/doc.template.md (#98)', () => {
  const template = readFileSync(join(resolve(__dirname, '../..'), 'templates/doc.template.md'), 'utf8');

  it('names the fields authors forget', () => {
    for (const key of ['title', 'tier', 'domains', 'purpose', 'symptoms', 'sources']) expect(template).toMatch(new RegExp(`^${key}:`, 'm'));
    expect(template).toMatch(/^# external_refs:/m);
  });

  it('passes `hewtd audit --strict` once its placeholders are filled', () => {
    const filled = template
      .replace('<Name the specific subject — e.g. "Deploying the API to production">', 'Deploying the API to production')
      .replace('<domain-1>', 'devops')
      .replace('YYYY-MM-DD', '2026-01-01')
      .replace(/^purpose: .*$/m, 'purpose: How do I deploy the API to production and roll it back?')
      .replace('<"deploy hangs on the migration step">', 'deploy hangs on the migration step')
      .replace('<"error: release lock already held">', 'error release lock already held')
      .replace('<src/path/to/file.ts>', 'src/user.ts')
      .replace('<tag-1>', 'deployment')
      .replace('<Title>', 'Deploying the API to production')
      .replace(/<Two or three[^>]*>/, 'This covers deploying the API and rolling it back.')
      .replace('<Section>', 'Steps')
      .replace(/<Content[^\n]*>/, 'Run the deploy script, then check the release.');
    expect(filled.replace(/^#.*$/gm, '')).not.toMatch(/<[^>\n]+>/); // the optional block stays commented
    put('.documentation/devops/deploying.md', filled);
    hewtd(['index']); // a bare tree has no INDEX/REGISTRY yet; that is index-drift, not a template problem
    const r = hewtd(['audit', '--strict']);
    expect(r.stdout + r.stderr).not.toMatch(/MISSING_PURPOSE|WEAK_PURPOSE|MISSING_SYMPTOMS|[1-9]\d* errors/i);
    expect(r.status).toBe(0);
  });
});

describe('hewtd integrate edge cases (#98)', () => {
  it('without --review writes no skeleton and still prints the next step', () => {
    const r = hewtd(['integrate', NEW, '-a']);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/Next: .*\/hit-em-with-the-docs:reconcile/);
    expect(existsSync(join(root, '.hewtd/reconcile'))).toBe(false);
  });

  it('a doc from outside the repo is integrated, copied, and left in place', () => {
    const outside = mkdtempSync(join(tmpdir(), 'integrate-98-out-'));
    try {
      writeFileSync(join(outside, 'ext.md'), '# External\n\nBody text for the doc.\n');
      const r = hewtd(['integrate', join(outside, 'ext.md'), '-a', '-d', 'api']);
      expect(r.status).toBe(0);
      expect(existsSync(join(outside, 'ext.md'))).toBe(true);
      const { data } = parse_frontmatter<Record<string, unknown>>(readFileSync(join(root, '.documentation/api/ext.md'), 'utf8'));
      expect(data.purpose).toBeUndefined();
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('--dry-run writes nothing', () => {
    expect(hewtd(['integrate', NEW, '-a', '-d', 'api', '--dry-run']).status).toBe(0);
    expect(existsSync(join(root, '.documentation/api', NEW))).toBe(false);
  });
});

describe('integrate pass-1 review fixes (#98)', () => {
  it('rewriting a doc in place does not tell the author to delete the only copy', () => {
    put('.documentation/devops/inplace.md', '# In place\n\nThis paragraph describes the in place document body text.\n');
    const r = hewtd(['integrate', '.documentation/devops/inplace.md', '--force']);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/copied, not moved|delete it yourself/);
    expect(existsSync(join(root, '.documentation/devops/inplace.md'))).toBe(true);
  });

  it('refuses to overwrite a different doc at the target, even with --force', () => {
    put('.documentation/api/new-guide.md', '# Other\n\nSome other doc.\n');
    for (const extra of [[], ['--force']]) {
      const r = hewtd(['integrate', NEW, '-a', '-d', 'api', ...extra]);
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/already exists and is a different doc/);
      expect(readFileSync(join(root, '.documentation/api/new-guide.md'), 'utf8')).toBe('# Other\n\nSome other doc.\n');
    }
  });

  it('a tracked original is not mention evidence for integrate, and the output says reconcile still counts it', () => {
    g('add', NEW); g('commit', '-qm', 'track draft');
    const r = hewtd(['integrate', NEW, '-a', '-d', 'api']);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/missing reference: loadUserV1/);
    expect(r.stdout + r.stderr).toMatch(/tracked original, reconcile counts it/);
    g('add', '-A'); g('commit', '-qm', 'add copy');
    const entry = JSON.parse(hewtd(['reconcile', 'api', '--json']).stdout).docs.find((d: { path: string }) => d.path === 'api/new-guide.md');
    expect(entry.missing).toEqual([]); // the tracked original is a mention for reconcile
  });
});
