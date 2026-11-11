import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { compute_content_hash, is_reviewed, type LedgerEntry } from '../../../src/core/reconcile/ledger';
import { find_unreviewed_docs } from '../../../src/core/reconcile/triage';

// #103: since 3.1.6 (#86) an applied rewrite lands its draft, so a rewrite entry on the current content is a review.
const text = '---\ntitle: a\n---\n\n# A\n\nRewritten body.\n';
const hash = compute_content_hash(text);
const rewrite = (extra: Partial<LedgerEntry> = {}): LedgerEntry => ({ path: 'a.md', lane: 'judge', verdict: 'rewrite', reviewed_on: '2026-11-11', applied_commit: 'abc1234', content_hash: hash, ...extra });

describe('is_reviewed: a landed rewrite (#103)', () => {
  it('counts as reviewed while the content is unchanged', () => {
    expect(is_reviewed(rewrite(), hash)).toBe(true);
  });
  it('counts as reviewed after a staged apply, which makes no commit', () => {
    const { applied_commit, ...staged } = rewrite();
    expect(applied_commit).toBeDefined();
    expect(is_reviewed(staged, hash)).toBe(true);
  });
  it('is unreviewed again once the doc is edited', () => {
    expect(is_reviewed(rewrite(), compute_content_hash(text + 'edit\n'))).toBe(false);
  });
  it('a rewrite recorded before 3.1.6 never landed its draft, so it stays unreviewed', () => {
    expect(is_reviewed(rewrite({ reviewed_on: '2026-11-09' }), hash)).toBe(false);
    expect(is_reviewed(rewrite({ reviewed_on: undefined }), hash)).toBe(false);
  });
  it('other verdicts are unchanged', () => {
    expect(is_reviewed(rewrite({ verdict: 'verify', reviewed_on: '2026-11-01' }), hash)).toBe(true);
    expect(is_reviewed(rewrite({ verdict: '', lane: 'judge' }), hash)).toBe(false);
  });
});

describe('find_unreviewed_docs (--changed, audit DOCS_UNREVIEWED, pre-commit check) skips a landed rewrite (#103)', () => {
  let docs_root: string;
  beforeEach(() => { docs_root = mkdtempSync(join(tmpdir(), 'rewrite-103-')); mkdirSync(join(docs_root, 'backend')); });
  afterEach(() => rmSync(docs_root, { recursive: true, force: true }));
  it('lists it only when edited after the rewrite', async () => {
    writeFileSync(join(docs_root, 'backend/a.md'), text);
    const ledger = { version: 1 as const, entries: { 'backend/a.md': rewrite({ path: 'backend/a.md' }) } };
    expect(await find_unreviewed_docs({ docs_root, ledger })).toEqual([]);
    writeFileSync(join(docs_root, 'backend/a.md'), text + 'edit\n');
    expect(await find_unreviewed_docs({ docs_root, ledger })).toEqual(['backend/a.md']);
  });
});
