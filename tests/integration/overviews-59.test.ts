import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { render_review, type ReviewEntry } from '../../src/core/reconcile/review';
import { hash_content } from '../../src/core/reconcile/ledger';
import { parse_frontmatter } from '../../src/utils/frontmatter';

// #59 acceptance checks through the built CLI on fixture repos.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
let docs: string;

const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(docs, rel, '..'), { recursive: true }); writeFileSync(join(docs, rel), text); };
const read = (rel: string) => readFileSync(join(docs, rel), 'utf-8');
const h = (rel: string) => hash_content(read(rel));
const commit = () => { g('add', '-A'); if (g('status', '--porcelain')) g('commit', '-qm', 'x'); };
const fm = (title: string) => `---\ntitle: ${title}\ndomains:\n  - backend\n---\n\n`;
/** Commits any hand edit first: reconcile refuses a dirty scope. */
const triage = (): Record<string, { lane: string; reasons: string[] }> =>
  (commit(), Object.fromEntries(JSON.parse(hewtd(['reconcile', ...readdirSync(docs), '--json']).stdout).docs.map((d: { path: string }) => [d.path, d])));

let n = 0;
/** Write entries as a ticked review file and apply it through the CLI. */
function apply(entries: ReviewEntry[]) {
  const f = join(root, `.hewtd/reconcile/review-t${++n}-1.md`);
  mkdirSync(join(root, '.hewtd/reconcile'), { recursive: true });
  writeFileSync(f, render_review({ batch: `t${n}`, shard: 1, scope: 'backend' }, entries).replace(/- \[ \] accept/g, '- [x] accept'));
  return hewtd(['reconcile', '--apply', f]);
}
const verify = (rel: string): ReviewEntry => ({ path: rel, content_hash: h(rel), verdict: 'verify', sources: ['src/real.ts'] });

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ov59-'));
  docs = join(root, '.documentation');
  writeFileSync(join(root, '.gitignore'), '.hewtd/\n');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/real.ts'), 'export const x = 1;\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('question-seeded overview (#59 section 1)', () => {
  const seed = () => {
    put('build/pipeline.md', fm('Build pipeline') + '# Build pipeline\n\nThe release build compiles artifacts and signs the release candidate.\n');
    put('ops/rollout.md', fm('Rollout checklist') + '# Rollout checklist\n\nPromote the release candidate to production with a staged rollout.\n');
    put('api/gate.md', fm('Release gate') + '# Release gate\n\nThe release gate approves the release candidate before production.\n');
    put('misc/lunch.md', fm('Lunch') + '# Lunch\n\nMenus and parking.\n');
    g('init', '-q'); commit();
    const r = hewtd(['reconcile', '--overview', 'how does a release go from build to production', '--json']);
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout) as { members: { path: string; state: string }[]; file: string };
  };

  it('finds unlinked cross-domain docs, gates on reconciled members, and a member change sends it to check', () => {
    const s = seed();
    const paths = s.members.map((m) => m.path).sort();
    expect(paths).toEqual(['api/gate.md', 'build/pipeline.md', 'ops/rollout.md']);
    expect(s.members.every((m) => m.state === 'unreviewed')).toBe(true);
    expect(existsSync(join(root, s.file))).toBe(true);

    const sk = hewtd(['reconcile', '--write-review', '--overview', s.file]);
    expect(sk.status).toBe(0);
    const review_path = join(root, '.hewtd/reconcile', readdirSync(join(root, '.hewtd/reconcile')).find((f) => /^review-.*\.md$/.test(f))!);
    const skeleton = readFileSync(review_path, 'utf-8');
    const json = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(skeleton)![1]!) as ReviewEntry;
    const filled: ReviewEntry = {
      ...json, verdict: 'overview',
      draft: '# Release flow\n\n1. [Build](../build/pipeline.md)\n2. [Gate](../api/gate.md)\n3. [Rollout](../ops/rollout.md)\n',
      frontmatter: { title: 'Release flow', domains: ['backend'], purpose: 'How a release reaches production.', last_validated: '2020-01-01' },
    };
    const target = json.path;

    // unreconciled members: refused, nothing written
    let res = apply([filled]);
    expect(res.stdout + res.stderr).toMatch(/not reconciled|unreviewed/i);
    expect(existsSync(join(docs, target))).toBe(false);

    // reconcile the members, then the overview applies
    expect(apply(paths.map(verify)).status).toBe(0);
    const f2 = { ...filled, members: filled.members!.map((m) => ({ path: m.path, content_hash: h(m.path) })) };
    res = apply([f2]);
    expect(res.status).toBe(0);
    const { data } = parse_frontmatter<Record<string, unknown>>(read(target));
    expect(data.kind).toBe('overview');
    expect(data.last_validated).toBeUndefined();
    expect(triage()[target]?.reasons.join() ?? '').not.toMatch(/member changed/);

    // a member change sends the overview back to check
    writeFileSync(join(docs, 'ops/rollout.md'), read('ops/rollout.md') + '\nNow with canaries.\n');
    const t = triage()[target]!;
    expect(t.lane).toBe('check');
    expect(t.reasons).toContain('member changed: ops/rollout.md');
  });
});

describe('one owner per fact (#59 addendum)', () => {
  const OWNER = fm('Deploy guide') + '# Deploy guide\n\n## Release\n\nRun `deploy.sh` first.\n\n## Other\n\nx\n';
  const COPY = (t: string) => fm(t) + `# ${t}\n\nIntro.\n\nRun \`deploy.sh --canary\` and wait 30 minutes.\n\nOutro.\n`;
  const OLD = 'Run `deploy.sh --canary` and wait 30 minutes.';
  const SUMMARY = 'Release with a canary (`--canary`) for 30 minutes.';
  const merge = (): ReviewEntry => ({ path: 'backend/deploy.md', content_hash: h('backend/deploy.md'), verdict: 'merge', section: 'release', patch: [{ old: 'Run `deploy.sh` first.', new: 'Run `deploy.sh` first, or `deploy.sh --canary` and wait 30 minutes.' }] });
  const point = (rel: string, over: Partial<ReviewEntry> = {}): ReviewEntry => ({
    path: rel, content_hash: h(rel), verdict: 'point', remove: { old: OLD },
    pointer: { summary: SUMMARY, target: 'backend/deploy.md#release' }, depends_on_merge: 'backend/deploy.md', ...over,
  });
  beforeEach(() => {
    put('backend/deploy.md', OWNER);
    put('backend/admin.md', COPY('Admin'));
    put('backend/ops.md', COPY('Ops'));
    g('init', '-q'); commit();
  });

  it('refuses a point that would lose a token, listing it, and writes nothing', () => {
    const before = read('backend/admin.md');
    const thin = { ...merge(), patch: [{ old: 'Run `deploy.sh` first.', new: 'Run `deploy.sh` first and wait.' }] };
    const r = apply([point('backend/admin.md', { pointer: { summary: 'Canary release.', target: 'backend/deploy.md#release' } }), thin]);
    expect(r.stdout + r.stderr).toMatch(/missing: .*--canary/);
    expect(read('backend/admin.md')).toBe(before);
  });

  it('merge-then-point removes the copy with no token lost; owner change or heading rename flags every pointer', () => {
    const r = apply([merge(), point('backend/admin.md'), point('backend/ops.md')]);
    expect(r.status).toBe(0);
    for (const c of ['backend/admin.md', 'backend/ops.md']) {
      expect(read(c)).not.toContain(OLD);
      expect(read(c)).toContain('Details: [Deploy guide: Release](deploy.md#release)');
      expect(read(c)).toContain('Intro.');
    }
    expect(read('backend/deploy.md')).toContain('`deploy.sh --canary` and wait 30 minutes');
    commit();
    const lanes = () => triage();
    expect(lanes()['backend/admin.md']!.reasons.join()).not.toMatch(/pointer target/);

    // owner section changes: both pointers go to check
    writeFileSync(join(docs, 'backend/deploy.md'), read('backend/deploy.md').replace('30 minutes', '45 minutes'));
    for (const c of ['backend/admin.md', 'backend/ops.md']) {
      expect(lanes()[c]!.lane).toBe('check');
      expect(lanes()[c]!.reasons).toContain('pointer target changed: backend/deploy.md#release');
    }

    // heading rename: link-check warns (advisory, exit 0) and the pointers report the section missing
    writeFileSync(join(docs, 'backend/deploy.md'), read('backend/deploy.md').replace('## Release', '## Shipping'));
    const lc = hewtd(['link-check', '-p', docs]);
    expect(lc.status).toBe(0);
    expect(lc.stdout + lc.stderr).toMatch(/LINK_BROKEN_ANCHOR: no heading #release/);
    expect(lanes()['backend/admin.md']!.reasons.join()).toMatch(/\(section missing\)/);
  });

  it('flags the Admin copy of a procedure and merge-then-point removes it', () => {
    const steps = Array.from({ length: 8 }, (_, i) => `${i + 1}. Run the release step number ${i + 1} and confirm the pipeline reports green before tagging version ${i}.`).join('\n');
    const filler = Array.from({ length: 400 }, (_, i) => `Admin note ${i}: rotate unrelated knob ${i * 7} weekly.`).join('\n');
    rmSync(join(docs, 'backend'), { recursive: true });
    put('procedures/release-procedure.md', `---\ntitle: Release procedure\npurpose: How to cut and tag a release\n---\n# Release procedure\n\n${steps}\n`);
    put('guides/admin.md', `---\ntitle: Admin\n---\n# Admin\n\n${filler}\n\n## Cutting a release\n\n${steps}\n`);
    commit();
    const t = triage()['guides/admin.md']!;
    expect(t.reasons.join()).toContain('copy of procedures/release-procedure.md#release-procedure');
    expect(triage()['procedures/release-procedure.md']!.reasons.join()).not.toMatch(/copy of/);

    // the owner already holds every token, so a bare pointer applies and nothing is lost
    const r = apply([{
      path: 'guides/admin.md', content_hash: h('guides/admin.md'), verdict: 'point', remove: { old: steps },
      pointer: { summary: 'Cut a release with the release procedure.', target: 'procedures/release-procedure.md#release-procedure' },
      target_hash: h('procedures/release-procedure.md'),
    }]);
    expect(r.status).toBe(0);
    expect(read('guides/admin.md')).not.toContain('step number 3');
    expect(read('guides/admin.md')).toContain('Details: [Release procedure: Release procedure](../procedures/release-procedure.md#release-procedure)');
    expect(read('procedures/release-procedure.md')).toContain('step number 3');
  });
});
