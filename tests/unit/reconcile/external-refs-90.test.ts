import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import matter from 'gray-matter';
import { apply_reviews } from '../../../src/core/reconcile/apply';
import { render_review, load_review, write_review_skeletons, type ReviewEntry } from '../../../src/core/reconcile/review';
import { compute_content_hash, load_ledger, get_external_refs_status } from '../../../src/core/reconcile/ledger';
import { triage_docs } from '../../../src/core/reconcile/triage';
import { load_plugin_config } from '../../../src/utils/config';

let root: string, docs: string, ledger_file: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const read = (rel: string) => readFileSync(join(docs, rel), 'utf-8');
const put = (rel: string, text: string) => { mkdirSync(join(docs, rel, '..'), { recursive: true }); writeFileSync(join(docs, rel), text); };
const entry = (over: Partial<ReviewEntry>): ReviewEntry => ({ path: 'ops/a.md', content_hash: compute_content_hash(read('ops/a.md')), verdict: 'verify', ...over });
let n = 0;
const run = async (e: ReviewEntry) => {
  const file = join(root, '.hewtd/reconcile', `review-${++n}-1.md`);
  mkdirSync(join(root, '.hewtd/reconcile'), { recursive: true });
  writeFileSync(file, render_review({ batch: String(n), shard: 1, scope: 'ops' }, [e]).replace(/- \[ \] accept/g, '- [x] accept'));
  await apply_reviews({ root, docs_root: docs, files: [file], ledger: await load_ledger(ledger_file), ledger_file, today: '2026-11-07' });
};
const triage = async () => {
  const config = await load_plugin_config(root);
  return triage_docs({ root, docs_root: docs, rels: ['ops/a.md'], config });
};
const external = () => matter(read('ops/a.md')).data.external_refs;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ext-90-'));
  docs = join(root, '.documentation');
  ledger_file = join(root, '.hewtd/reconcile.json');
  put('ops/a.md', '---\ntitle: a\ndomains:\n  - ops\n---\n\n# A\n\nUses `vendorFetchAll` and `lib/vendor/x.py` and `otherVendorFn`.\n');
  writeFileSync(join(root, '.gitignore'), '.hewtd/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('external_refs in the review loop (#90)', () => {
  it('apply keeps a judge decision, re-triage shows no missing, a later review unions', async () => {
    expect((await triage()).docs[0]!.missing.length).toBeGreaterThan(0);
    await run(entry({ external_refs: ['vendorFetchAll', 'lib/vendor/x.py'] }));
    expect(external()).toEqual(['vendorFetchAll', 'lib/vendor/x.py']);
    expect((await triage()).docs[0]!.missing).toEqual(['otherVendorFn']);
    await run(entry({ external_refs: ['otherVendorFn', 'vendorFetchAll'] }));
    expect(external()).toEqual(['vendorFetchAll', 'lib/vendor/x.py', 'otherVendorFn']);
    expect((await triage()).docs[0]!.missing).toEqual([]);
  });

  it('frontmatter.external_refs merges too, and an entry without any leaves none behind', async () => {
    await run(entry({ patch: [{ old: 'Uses', new: 'Calls' }] }));
    expect(external()).toBeUndefined();
    await run(entry({ external_refs: ['a'] }));
    await run(entry({ frontmatter: { external_refs: ['b', 'a'] } }));
    expect(external()).toEqual(['a', 'b']);
  });

  it('an entry only adds string external_refs; non-strings already in the doc stay', async () => {
    await run(entry({ external_refs: ['a', 7 as never, { x: 1 } as never], frontmatter: { external_refs: [null, 'b'] } }));
    expect(external()).toEqual(['a', 'b']);
    put('ops/a.md', read('ops/a.md').replace(/^external_refs:\n/m, 'external_refs:\n  - 5\n'));
    await run(entry({ external_refs: ['c'] }));
    expect(external()).toContain(5);
    expect(external()).toContain('c');
  });

  it('skeleton prints missing beside an empty external_refs; load_review tolerates it', async () => {
    const triaged = await triage();
    const [file] = await write_review_skeletons({ root, docs_root: docs, triage: triaged, scope: 'ops', include_clean: true });
    const loaded = (await load_review(file!)).entries[0]!.entry as ReviewEntry & { missing?: string[] };
    expect(loaded.missing).toEqual(triaged.docs[0]!.missing);
    expect(loaded.external_refs).toEqual([]);
  });

  it('status counts covered and still-missing refs from the graph', () => {
    const graph = { docs: { 'ops/a.md': { refs: [{ target: 'x', resolved: false }, { target: 'y', resolved: true }] }, 'ops/b.md': { refs: [{ target: 'z', resolved: false }] } } };
    const frontmatters = { 'ops/a.md': { external_refs: ['q', 'r'] } };
    expect(get_external_refs_status(graph, frontmatters, ['ops/a.md'])).toEqual({ covered: 2, still_missing: 1, docs_still_missing: 1 });
  });

  it('covered counts distinct string entries; a malformed graph throws', () => {
    const graph = { docs: { 'ops/a.md': { refs: [] } } };
    expect(get_external_refs_status(graph, { 'ops/a.md': { external_refs: ['q', 'q', 3, 'r'] } }, ['ops/a.md']).covered).toBe(2);
    expect(() => get_external_refs_status({ docs: 3 }, {}, [])).toThrow(/no docs map/);
    expect(() => get_external_refs_status(null, {}, [])).toThrow(/no docs map/);
    expect(() => get_external_refs_status({ docs: { 'ops/a.md': { refs: 'x' } } }, {}, ['ops/a.md'])).toThrow(/not a list/);
  });
});
