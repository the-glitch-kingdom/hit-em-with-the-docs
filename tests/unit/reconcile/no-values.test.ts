import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyReviews } from '../../../src/core/reconcile/apply';
import { renderReview, type ReviewEntry } from '../../../src/core/reconcile/review';
import { hashContent, loadLedger, saveLedger } from '../../../src/core/reconcile/ledger';
import { assertNoSecrets } from '../../../src/core/reconcile/secrets';

// Secret-shaped strings are built at runtime so the repo holds no scannable literal.
const rnd = (n: number, seed = 7) => { let x = seed; let s = ''; const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += a[x % a.length]; } return s; };
const tok = 'hv' + 's.' + rnd(24);

let root: string, docs: string, ledgerFile: string;
const g = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' }).trim();
const doc = (body: string) => `---\ntitle: a\ndomains:\n  - backend\n---\n\n# a\n\n${body}\n`;
const read = (rel: string) => readFileSync(join(docs, rel), 'utf-8');
// The render guard would refuse a real value, so a hand-edited review file is simulated by substituting after render.
const M = '@@T@@';
const run = async (e: ReviewEntry) => {
  mkdirSync(join(root, '.hewtd/reconcile'), { recursive: true });
  const f = join(root, '.hewtd/reconcile/review-1-1.md');
  writeFileSync(f, renderReview({ batch: '1', shard: 1, scope: 'backend' }, [e]).replace('- [ ] accept', '- [x] accept').split(M).join(tok));
  return applyReviews({ root, docsPath: docs, files: [f], ledger: await loadLedger(ledgerFile), ledgerFile, today: '2026-11-07' });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'novals-'));
  docs = join(root, '.documentation');
  ledgerFile = join(root, '.hewtd/reconcile.json');
  mkdirSync(join(docs, 'backend'), { recursive: true });
  writeFileSync(join(docs, 'backend/a.md'), doc('Body of a.'));
  writeFileSync(join(root, '.gitignore'), '.hewtd/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const entry = (over: Partial<ReviewEntry>): ReviewEntry => ({ path: 'backend/a.md', content_hash: hashContent(read('backend/a.md')), verdict: 'verify', ...over });

describe('no values anywhere', () => {
  it('assertNoSecrets throws a masked message, never the value', () => {
    expect(() => assertNoSecrets(`x ${tok}`, 'here')).toThrow(/vault-token line 1 hvs\.…28/);
    try { assertNoSecrets(`x ${tok}`, 'here'); } catch (e) { expect((e as Error).message).not.toContain(tok); }
    expect(() => assertNoSecrets('nothing here', 'here')).not.toThrow();
  });

  it('refuses to render a review that carries a value', () => {
    expect(() => renderReview({ batch: '1', shard: 1, scope: 's' }, [{ path: 'a.md', content_hash: 'h', verdict: 'verify', patch: [{ old: 'x', new: tok }] }])).toThrow(/would write a secret/);
  });

  it('refuses to save a ledger that carries a value', async () => {
    await expect(saveLedger(ledgerFile, { version: 1, entries: { p: { path: p(tok), lane: 'check', content_hash: 'h' } } })).rejects.toThrow(/would write a secret/);
    expect(existsSync(ledgerFile)).toBe(false);
  });

  it('a patch with a token is an error outcome and nothing is applied', async () => {
    const before = read('backend/a.md');
    const res = await run(entry({ patch: [{ old: 'Body of a.', new: `token ${M}` }] }));
    expect(res.outcomes[0]).toMatchObject({ status: 'error' });
    expect(res.outcomes[0]!.detail).toMatch(/would write a secret/);
    expect(JSON.stringify(res)).not.toContain(tok);
    expect(read('backend/a.md')).toBe(before);
    expect(g('rev-list', '--count', 'HEAD')).toBe('1');
  });

  it('a draft or frontmatter value with a token is refused; no draft file written', async () => {
    const d = await run(entry({ verdict: 'rewrite', draft: `# new\n${M}` }));
    expect(d.outcomes[0]!.status).toBe('error');
    expect(existsSync(join(root, '.hewtd/reconcile/drafts'))).toBe(false);
    const f = await run(entry({ verdict: 'fields', frontmatter: { purpose: M } }));
    expect(f.outcomes[0]!.status).toBe('error');
  });

  it('the staged-diff check rolls back a batch that would commit a value, restoring the edit', async () => {
    writeFileSync(join(docs, 'backend/a.md'), doc(`leaked ${tok}`)); // uncommitted edit already holding a value
    const dirty = read('backend/a.md');
    const res = await run(entry({ verdict: 'fields', frontmatter: { purpose: 'p' } }));
    expect(res.outcomes[0]!.status).toBe('error');
    expect(res.outcomes[0]!.detail).toMatch(/rolled back: would write a secret to the staged diff/);
    expect(res.outcomes[0]!.detail).not.toContain(tok);
    expect(g('rev-list', '--count', 'HEAD')).toBe('1');
    expect(read('backend/a.md')).toBe(dirty);
  });

  it('no artifact reconcile wrote holds the value', async () => {
    await run(entry({ patch: [{ old: 'Body of a.', new: `token ${M}` }] }));
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === '.git' ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    // the hand-edited review file is the test's own input; everything reconcile wrote must be clean
    for (const f of walk(join(root, '.hewtd')).filter((x) => !/review-1-1\.md$/.test(x))) expect(readFileSync(f, 'utf-8')).not.toContain(tok);
    expect(g('log', '-p', '--all')).not.toContain(tok);
  });
});

const p = (s: string) => `x/${s}`;
