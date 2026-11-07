import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyReviews } from '../../../src/core/reconcile/apply';
import { renderReview, parseReview, writeReviewSkeletons, type ReviewEntry } from '../../../src/core/reconcile/review';
import { hashContent, loadLedger } from '../../../src/core/reconcile/ledger';

let root: string, docs: string, ledgerFile: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const doc = (name: string, extra = '') => `---\ntitle: ${name}\ndomains:\n  - backend\n${extra}---\n\n# ${name}\n\nBody of ${name}.\n`;
const read = (rel: string) => readFileSync(join(docs, rel), 'utf-8');
const entry = (rel: string, over: Partial<ReviewEntry>): ReviewEntry =>
  ({ path: rel, content_hash: hashContent(read(rel)), verdict: 'verify', ...over });
const review = (name: string, entries: ReviewEntry[], accept: boolean[] = entries.map(() => true), shard = 1) => {
  let t = renderReview({ batch: '1', shard, scope: 'backend' }, entries);
  accept.forEach((a) => { if (a) t = t.replace('- [ ] accept', '- [x] accept'); });
  const f = join(root, '.hewtd/reconcile', name);
  mkdirSync(join(root, '.hewtd/reconcile'), { recursive: true });
  writeFileSync(f, t);
  return f;
};
const run = async (files: string[]) => applyReviews({ root, docsPath: docs, files, ledger: await loadLedger(ledgerFile), ledgerFile, today: '2026-11-07' });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'apply-'));
  docs = join(root, '.documentation');
  ledgerFile = join(root, '.hewtd/reconcile.json');
  mkdirSync(join(docs, 'backend'), { recursive: true });
  for (const n of ['a', 'b', 'c']) writeFileSync(join(docs, `backend/${n}.md`), doc(n));
  writeFileSync(join(root, '.gitignore'), '.hewtd/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('applyReviews', () => {
  it('nothing changes before acceptance; rejected entries untouched', async () => {
    const before = read('backend/a.md');
    const res = await run([review('review-1-1.md', [entry('backend/a.md', { sources: ['x.ts'] })], [false])]);
    expect(res.outcomes[0].status).toBe('rejected');
    expect(read('backend/a.md')).toBe(before);
    expect(g('rev-list', '--count', 'HEAD')).toBe('1');
  });

  it('verify writes sources as listed, stamps today, commits once and records the ledger', async () => {
    const res = await run([review('review-1-1.md', [entry('backend/a.md', { sources: ['src/z.ts', 'src/y.ts'], patch: [{ old: 'Body of a.', new: 'Fixed.' }] })])]);
    expect(res.outcomes[0].status).toBe('applied');
    const t = read('backend/a.md');
    expect(t).toMatch(/last_verified: '?2026-11-07/);
    expect(t.indexOf('src/z.ts')).toBeLessThan(t.indexOf('src/y.ts'));
    expect(t).toContain('Fixed.');
    expect(g('rev-list', '--count', 'HEAD')).toBe('2');
    expect(g('log', '-1', '--format=%s')).toBe('docs(reconcile): backend batch 1');
    const l = (await loadLedger(ledgerFile)).entries['backend/a.md'];
    expect(l).toMatchObject({ verdict: 'verify', applied_commit: res.commit, review_file: '.hewtd/reconcile/review-1-1.md' });
  });

  it('unverifiable and fields never derive last_verified', async () => {
    await run([review('review-1-1.md', [
      entry('backend/a.md', { verdict: 'unverifiable', frontmatter: { purpose: 'p', last_verified: '1999-01-01' } }),
      entry('backend/b.md', { verdict: 'fields', frontmatter: { purpose: 'q' } }),
    ])]);
    expect(read('backend/a.md')).toMatch(/confidence: low/);
    expect(read('backend/a.md')).not.toContain('last_verified');
  });

  it('skips a stale proposal and reports it', async () => {
    const e = entry('backend/a.md', {});
    writeFileSync(join(docs, 'backend/a.md'), doc('a', 'tags:\n  - changed\n'));
    const res = await run([review('review-1-1.md', [e])]);
    expect(res.outcomes[0].status).toBe('stale');
    expect(res.commit).toBeUndefined();
  });

  it('second apply of the same file is a no-op', async () => {
    const f = review('review-1-1.md', [entry('backend/a.md', { sources: ['x.ts'] })]);
    await run([f]);
    const head = g('rev-parse', 'HEAD');
    const again = await run([f]);
    expect(again.outcomes[0].status).toBe('already-applied');
    expect(g('rev-parse', 'HEAD')).toBe(head);
  });

  it('rejects overlapping shards before writing anything', async () => {
    const e = entry('backend/a.md', {});
    const f1 = review('review-1-1.md', [e]);
    const f2 = review('review-1-2.md', [e], [true], 2);
    await expect(run([f1, f2])).rejects.toThrow(/appears in both/);
    expect(g('rev-list', '--count', 'HEAD')).toBe('1');
  });

  it('rejects the same doc twice in one file, but not an outside entry with the same path (review fix)', async () => {
    const e = entry('backend/a.md', {});
    await expect(run([review('review-1-1.md', [e, e])])).rejects.toThrow(/appears twice/);
    const out = { ...entry('backend/a.md', {}), outside: true, verdict: null };
    const r = await run([review('review-2-1.md', [e]), review('review-2-2.md', [out], [false], 2)]);
    expect(r.outcomes.map((o) => o.status)).toContain('rejected');
  });

  it('archive uses archiveDoc; rewrite leaves the original and writes a draft', async () => {
    const f = review('review-1-1.md', [entry('backend/b.md', { verdict: 'archive', reason: 'gone' })]);
    const res = await run([f]);
    expect(res.outcomes[0].status).toBe('applied');
    expect(existsSync(join(docs, 'backend/b.md'))).toBe(false);
    expect(existsSync(join(docs, 'archive/backend/b.md'))).toBe(true);
    const before = read('backend/c.md');
    await run([review('review-1-2.md', [entry('backend/c.md', { verdict: 'rewrite', draft: 'NEW' })], [true], 2)]);
    expect(read('backend/c.md')).toBe(before);
    expect(readFileSync(join(root, '.hewtd/reconcile/drafts/backend/c.md'), 'utf-8')).toBe('NEW');
  });

  it('skeleton review files parse back, are unjudged, and are never applied', async () => {
    const triage: any = { docs: [{ path: 'backend/a.md', lane: 'check', reasons: ['r'] }, { path: 'backend/b.md', lane: 'clean', reasons: [] }], shards: [], totals: {}, mode: 'serial', warnings: [] };
    const [f] = await writeReviewSkeletons({ root, docsPath: docs, triage, scope: 'backend' });
    expect(f).toMatch(/review-1-1\.md$/);
    const r = await parseReview(f!);
    expect(r.entries.map((e) => [e.entry.path, e.entry.verdict, e.accepted])).toEqual([['backend/a.md', null, false]]);
    expect((await run([f!])).outcomes[0].status).toBe('rejected');
  });
});
