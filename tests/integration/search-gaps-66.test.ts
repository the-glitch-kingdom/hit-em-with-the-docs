import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// End-to-end through the built CLI (#66): gaps file -> proposals -> review -> apply, in a temp git repo.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const doc = (title: string) => `---\ntitle: ${title}\ndomains:\n  - backend\ntier: guide\nlast_verified: "2026-01-01"\n---\n\n# ${title}\n\nBody of ${title}.\n`;
const gaps_json = (a: string[]) => { const r = hewtd(['reconcile', '--gaps', ...a, '--json']); return { r, out: JSON.parse(r.stdout) }; };
const all_artifacts = (): string => {
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => !f.startsWith('.git/') && f !== 'gaps.json' && /\.(md|json)$/.test(f));
  return files.map((f) => readFileSync(join(root, f), 'utf-8')).join('\n') + g('log', '--format=%B');
};

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gaps-66-'));
  put('src/deployHelper.ts', 'export const x = 1;\n');
  put('.documentation/backend/release.md', doc('Release'));
  put('.documentation/backend/other.md', doc('Other'));
  put('.gitignore', '.hewtd/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('hewtd reconcile --gaps (built CLI)', () => {
  it('generated gaps.v1: proposal -> review -> apply adds the phrase, audit unchanged, rerun is a no-op', () => {
    put('gaps.json', JSON.stringify({ version: 1, source: 'test', gaps: [{ query: 'how do I roll back a bad deploy?', used_doc: 'backend/release.md', count: 3 }, { query: 'where is the zzz', used_doc: null }] }));
    const { r, out } = gaps_json(['gaps.json', '--write-review']);
    expect(r.status).toBe(0);
    expect(out.proposals).toEqual([expect.objectContaining({ doc: 'backend/release.md', accepted: [{ query: 'how do I roll back a bad deploy', count: 3 }] })]);
    expect(out.questions.map((q: { query: string }) => q.query)).toEqual(['where is the zzz']);
    expect(g('status', '--porcelain', '-uno')).toBe(''); // docs tree untouched
    const review = join(root, out.review);
    writeFileSync(review, readFileSync(review, 'utf-8').replace('- [ ] accept', '- [x] accept'));
    const before = g('rev-parse', 'HEAD');
    const audit_before = hewtd(['audit']).stdout;
    expect(hewtd(['reconcile', '--apply', review]).status).toBe(0);
    expect(g('rev-parse', 'HEAD')).not.toBe(before);
    expect(readFileSync(join(root, '.documentation/backend/release.md'), 'utf-8')).toContain('how do I roll back a bad deploy');
    expect(hewtd(['audit']).stdout).toBe(audit_before); // apply adds no audit finding
    // the phrase now exists, so the same file proposes nothing
    expect(gaps_json(['gaps.json']).out.proposals).toEqual([]);
    const head = g('rev-parse', 'HEAD');
    hewtd(['reconcile', '--apply', review]);
    expect(g('rev-parse', 'HEAD')).toBe(head);
  });

  it('bare array and hand-written text file work with no search tool', () => {
    put('bare.json', JSON.stringify([{ query: 'rollback a broken release quickly', used_doc: '.documentation/backend/release.md' }]));
    expect(gaps_json(['bare.json']).out.proposals[0].doc).toBe('backend/release.md');
    put('hand.txt', '# my misses\nwhy does deployHelper.ts fail on startup?\nwhat is the meaning of life\n');
    const { r, out } = gaps_json(['hand.txt']);
    expect(r.status).toBe(0);
    expect(out.candidates[0].sources).toContain('src/deployHelper.ts');
    expect(out.questions.map((q: { query: string }) => q.query)).toEqual(['what is the meaning of life']);
  });

  it('near-duplicates merge and the cap is enforced', () => {
    const qs = ['how to roll back release', 'how do I roll back the release?', 'restart the stuck worker pool', 'clear the poisoned job queue', 'rotate the signing keys safely', 'reindex the search cluster nightly', 'warm the edge cache after deploy'];
    put('gaps.json', JSON.stringify(qs.map((query, i) => ({ query, used_doc: 'backend/release.md', count: 10 - i }))));
    const out = gaps_json(['gaps.json']).out;
    expect(out.proposals[0].accepted).toHaveLength(5);
    expect(out.dropped.map((d: { reason: string }) => d.reason)).toEqual(expect.arrayContaining(['duplicate', 'over cap']));
    expect(out.proposals[0].accepted.filter((a: { query: string }) => /roll back/.test(a.query))).toHaveLength(1);
  });

  it('secret-shaped query is dropped and masked; no fixture value in any artifact', () => {
    const token = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
    put('gaps.json', JSON.stringify([{ query: `why does ${token} fail on login`, used_doc: 'backend/release.md' }, { query: 'how do I roll back a deploy', used_doc: 'backend/release.md' }]));
    const { r, out } = gaps_json(['gaps.json', '--write-review']);
    expect(r.stdout).not.toContain(token);
    expect(out.dropped[0]).toMatchObject({ query: '[redacted]', reason: 'secret' });
    expect(out.proposals[0].accepted).toHaveLength(1);
    expect(all_artifacts()).not.toContain(token.slice(4));
  });

  it('bad inputs fail cleanly', () => {
    put('v2.json', '{"version":2,"gaps":[]}');
    const r = hewtd(['reconcile', '--gaps', 'v2.json']);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/version/);
    expect(hewtd(['reconcile', '--gaps', 'missing.json']).status).toBe(1);
  });

  it('without --gaps, reconcile output is byte-identical to the baseline and --gaps changes nothing in triage', () => {
    const a = hewtd(['reconcile', '--json']).stdout;
    put('gaps.json', JSON.stringify([{ query: 'how do I roll back a bad deploy', used_doc: 'backend/release.md' }]));
    gaps_json(['gaps.json', '--write-review']);
    expect(hewtd(['reconcile', '--json']).stdout).toBe(a);
    expect(a).not.toMatch(/phrases|gaps/);
  });
});
