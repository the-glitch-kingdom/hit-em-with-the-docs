import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadPluginConfig } from '../../../src/utils/config.js';
import {
  loadLedger, saveLedger, recordEntry, isReviewed, ledgerStatus, hashContent,
} from '../../../src/core/reconcile/ledger.js';
import { MetadataSchema } from '../../../src/core/metadata/schema.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'recon-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('reconcile config', () => {
  it('defaults', async () => {
    const c = (await loadPluginConfig(dir)).reconcile;
    expect(c.ledger_path).toBe('.hewtd/reconcile.json');
    expect(c.keep_in_place).toContain('README.md');
    expect(c.team).toEqual({ min_docs: 12, min_bytes: 250000, max_agents: 4, docs_per_agent: 8 });
  });
  it('bad values fall back per key', async () => {
    await mkdir(join(dir, '.claude'));
    await writeFile(join(dir, '.claude/hit-em-with-the-docs.json'),
      JSON.stringify({ reconcile: { ledger_path: 5, team: { min_docs: -1, max_agents: 2 } } }));
    const c = (await loadPluginConfig(dir)).reconcile;
    expect(c.ledger_path).toBe('.hewtd/reconcile.json');
    expect(c.team.min_docs).toBe(12);
    expect(c.team.max_agents).toBe(2);
  });
});

describe('ledger', () => {
  const file = () => join(dir, '.hewtd/reconcile.json');
  it('round-trips and tolerates missing/corrupt files', async () => {
    expect((await loadLedger(file())).entries).toEqual({});
    const l = await loadLedger(file());
    recordEntry(l, { path: 'a.md', lane: 'judge', verdict: 'keep', content_hash: 'h1' });
    await saveLedger(file(), l);
    expect((await loadLedger(file())).entries['a.md'].verdict).toBe('keep');
    await writeFile(file(), '{nope');
    expect((await loadLedger(file())).entries).toEqual({});
  });
  it('concurrent saves leave valid JSON and no temp files', async () => {
    const ls = Array.from({ length: 10 }, (_, i) => {
      const l = { version: 1 as const, entries: {} };
      recordEntry(l, { path: `${i}.md`, lane: 'x', content_hash: 'h' });
      return l;
    });
    await Promise.all(ls.map((l) => saveLedger(file(), l)));
    expect(Object.keys((await loadLedger(file())).entries)).toHaveLength(1);
    expect(await readdir(join(dir, '.hewtd'))).toEqual(['reconcile.json']);
  });
  it('changed content resets the entry', () => {
    const l = { version: 1 as const, entries: {} };
    recordEntry(l, { path: 'a.md', lane: 'judge', verdict: 'keep', applied_commit: 'abc', content_hash: hashContent('v1') });
    expect(isReviewed(l.entries['a.md'], hashContent('v1'))).toBe(true);
    expect(isReviewed(l.entries['a.md'], hashContent('v2'))).toBe(false);
    const e = recordEntry(l, { path: 'a.md', lane: 'judge', content_hash: hashContent('v2') });
    expect(e.verdict).toBeUndefined();
    expect(e.applied_commit).toBeUndefined();
  });
  it('status counts and lists next unreviewed', () => {
    const l = { version: 1 as const, entries: {} };
    recordEntry(l, { path: 'a.md', lane: 'judge', verdict: 'keep', content_hash: 'h' });
    recordEntry(l, { path: 'b.md', lane: 'judge', verdict: 'keep', content_hash: 'old' });
    const st = ledgerStatus(l, [{ path: 'a.md', hash: 'h' }, { path: 'b.md', hash: 'new' }, { path: 'c.md', hash: 'z' }], 5);
    expect(st).toMatchObject({ total: 3, reviewed: 1, byVerdict: { keep: 1 }, nextUnreviewed: ['b.md', 'c.md'] });
  });
});

describe('schema moved_from', () => {
  it('accepts moved_from, sources, last_verified, confidence on a non-fact tier', () => {
    const r = MetadataSchema.safeParse({
      title: 'T', tier: 'guide', domains: ['api'], purpose: 'x', version: '1.0.0', status: 'active', last_updated: '2026-01-01',
      moved_from: 'docs/old.md', sources: ['src/a.ts'], last_verified: '2026-01-01', confidence: 'high',
    });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as any).moved_from).toBe('docs/old.md');
  });
});
