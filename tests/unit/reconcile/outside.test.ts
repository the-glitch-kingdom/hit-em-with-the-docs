import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyReviews } from '../../../src/core/reconcile/apply';
import { renderReview, type ReviewEntry } from '../../../src/core/reconcile/review';
import { discoverOutside, writeOutsideReview } from '../../../src/core/reconcile/outside';
import { hashContent, loadLedger } from '../../../src/core/reconcile/ledger';

let root: string, docs: string, ledgerFile: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 'Ann' } }).trim();
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const entry = (rel: string, verdict: ReviewEntry['verdict'], over: Partial<ReviewEntry> = {}): ReviewEntry =>
  ({ path: rel, outside: true, content_hash: hashContent(readFileSync(join(root, rel), 'utf-8')), verdict, ...over });
const run = async (entries: ReviewEntry[], accept = true) => {
  let t = renderReview({ batch: '1', shard: 1, scope: 'outside' }, entries);
  if (accept) t = t.replaceAll('- [ ] accept', '- [x] accept');
  const f = join(root, '.hewtd/reconcile/review-1-outside.md');
  mkdirSync(join(root, '.hewtd/reconcile'), { recursive: true });
  writeFileSync(f, t);
  return applyReviews({ root, docsPath: docs, files: [f], ledger: await loadLedger(ledgerFile), ledgerFile, today: '2026-11-07' });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'outside-'));
  docs = join(root, '.documentation');
  ledgerFile = join(root, '.hewtd/reconcile.json');
  mkdirSync(join(docs, 'backend'), { recursive: true });
  writeFileSync(join(docs, 'backend/a.md'), `---\ntitle: A\ndomains:\n  - backend\n---\n\n# A\n\nSee [notes](../../notes/design.md).\n`);
  put('README.md', `# Readme\n\n${words(40)}\n`);
  put('notes/design.md', `# Design of the cache layer\n\nSee [a](../.documentation/backend/a.md) and [code](../src/x.ts).\n\n${words(60)}\n`);
  put('notes/stub.md', '# todo\n');
  put('notes/copy.md', readFileSync(join(docs, 'backend/a.md'), 'utf-8'));
  put('scripts/gen.sh', 'echo hi > out/summary-notes.md\n');
  put('out/summary-notes.md', `# Summary\n\n${words(50)}\n`);
  writeFileSync(join(root, '.gitignore'), '.hewtd/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('discoverOutside', () => {
  it('sorts files into classes; keep_in_place always wins', async () => {
    const docsList = await discoverOutside(docs, ['README.md']);
    const cls = Object.fromEntries(docsList.map((d) => [d.path, d.cls]));
    expect(cls).toEqual({
      'README.md': 'tool-read', 'notes/design.md': 'misplaced', 'notes/stub.md': 'not-a-doc',
      'notes/copy.md': 'junk', 'out/summary-notes.md': 'junk',
    });
    expect((await discoverOutside(docs, ['notes/**'])).find((d) => d.path === 'notes/copy.md')!.cls).toBe('tool-read');
  });

  it('classes config-referenced files as not-a-doc and archive folders as junk', async () => {
    put('.design-sync/conventions.md', `# Conventions\n\n${words(50)}\n`);
    put('tools/config.json', '{"conventions": "./.design-sync/conventions.md"}\n');
    put('_archive/x.md', `# Old thing\n\n${words(50)}\n`);
    g('add', '-A'); g('commit', '-qm', 'more');
    const found = await discoverOutside(docs, []);
    expect(found.find((d) => d.path === '.design-sync/conventions.md')).toMatchObject({ cls: 'not-a-doc', reason: 'referenced by tools/config.json' });
    expect(found.find((d) => d.path === '_archive/x.md')).toMatchObject({ cls: 'junk', reason: 'archived copy' });
    expect((await discoverOutside(docs, ['_archive/**'])).find((d) => d.path === '_archive/x.md')!.cls).toBe('tool-read');
  });

  it('writes a review skeleton: junk pre-set to delete, misplaced left open', async () => {
    const f = await writeOutsideReview({ docsPath: docs, root, docs: await discoverOutside(docs, ['README.md']) });
    const t = readFileSync(f, 'utf-8');
    expect(t).not.toContain('[x]');
    expect(t).toContain('"verdict": "delete"');
    expect(t).toContain('"verdict": null');
  });
});

describe('outside apply', () => {
  it('integrates, removes the original and commits it all at once', async () => {
    const res = await run([entry('notes/design.md', 'integrate', { domain: 'api' })]);
    expect(res.outcomes[0]).toMatchObject({ status: 'applied' });
    expect(existsSync(join(root, 'notes/design.md'))).toBe(false);
    const t = readFileSync(join(docs, 'api/design.md'), 'utf-8');
    expect(t).toMatch(/moved_from: notes\/design\.md/);
    expect(t).toMatch(/first commit \d{4}-\d\d-\d\d, last change\s+\d{4}-\d\d-\d\d, authors: Ann/);
    expect(t).not.toContain('last_verified');
    expect(t).not.toContain('last_validated');
    expect(t).toMatch(/last_updated: ['"]?\d{4}-\d\d-\d\d/); // git date of the original, not a stamp
    expect(t).toContain('(../../src/x.ts)'); // relative link rebased
    expect(readFileSync(join(docs, 'backend/a.md'), 'utf-8')).toContain('(../api/design.md)'); // inbound link repointed
    expect(g('status', '--porcelain')).toBe('');
    expect(g('show', '--stat', '--format=%s', 'HEAD')).toContain('notes/design.md');
    expect(g('rev-list', '--count', 'HEAD')).toBe('2');
  });

  it('never overwrites an existing doc at the target path (review fix)', async () => {
    const before = `---\ntitle: Existing\ndomains:\n  - api\n---\n\n# Existing\n\nKeep me.\n`;
    mkdirSync(join(docs, 'api'), { recursive: true });
    writeFileSync(join(docs, 'api/a.md'), before);
    put('notes/a.md', `# Another a\n\n${words(60)}\n`);
    g('add', '-A'); g('commit', '-qm', 'add');
    const res = await run([entry('notes/a.md', 'integrate', { domain: 'api' })]);
    expect(res.outcomes[0]).toMatchObject({ status: 'error' });
    expect(res.outcomes[0]!.detail).toMatch(/already exists/);
    expect(readFileSync(join(docs, 'api/a.md'), 'utf-8')).toBe(before);
    expect(existsSync(join(root, 'notes/a.md'))).toBe(true);
  });

  it('refuses to repoint links in a doc with uncommitted edits, and changes nothing (review fix)', async () => {
    writeFileSync(join(docs, 'backend/a.md'), readFileSync(join(docs, 'backend/a.md'), 'utf-8') + '\nmy unsaved edit\n');
    const res = await run([entry('notes/design.md', 'integrate', { domain: 'api' })]);
    expect(res.outcomes[0]).toMatchObject({ status: 'error' });
    expect(res.outcomes[0]!.detail).toMatch(/uncommitted/);
    expect(existsSync(join(root, 'notes/design.md'))).toBe(true);
    expect(existsSync(join(docs, 'api/design.md'))).toBe(false);
    expect(g('rev-list', '--count', 'HEAD')).toBe('1');
  });

  it('never moves or deletes a keep_in_place file, even when accepted', async () => {
    const res = await run([entry('README.md', 'integrate')]);
    expect(res.outcomes[0]).toMatchObject({ status: 'error' });
    expect(existsSync(join(root, 'README.md'))).toBe(true);
    expect(g('rev-list', '--count', 'HEAD')).toBe('1');
  });

  it('deletes only accepted entries', async () => {
    const e = entry('notes/copy.md', 'delete');
    expect((await run([e], false)).outcomes[0].status).toBe('rejected');
    expect(existsSync(join(root, 'notes/copy.md'))).toBe(true);
    expect((await run([e])).outcomes[0].status).toBe('applied');
    expect(existsSync(join(root, 'notes/copy.md'))).toBe(false);
    expect(g('status', '--porcelain')).toBe('');
  });

  it('reports a changed file as stale and leaves it', async () => {
    const e = entry('notes/copy.md', 'delete');
    put('notes/copy.md', 'edited later\n');
    expect((await run([e])).outcomes[0].status).toBe('stale');
    expect(existsSync(join(root, 'notes/copy.md'))).toBe(true);
  });

  it('resolves the project root from the docs path, so no second docs tree appears', async () => {
    mkdirSync(join(root, 'sub'));
    const before = process.cwd();
    process.chdir(join(root, 'sub'));
    try { await run([entry('notes/design.md', 'integrate', { domain: 'api' })]); } finally { process.chdir(before); }
    expect(existsSync(join(root, 'sub/.documentation'))).toBe(false);
    expect(existsSync(join(docs, 'api/design.md'))).toBe(true);
  });
});
