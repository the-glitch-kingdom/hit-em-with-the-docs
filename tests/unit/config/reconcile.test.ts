import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { load_plugin_config } from '../../../src/utils/config.js';
import {
  load_ledger, save_ledger, record_entry, is_reviewed, ledger_status, hash_content,
} from '../../../src/core/reconcile/ledger.js';
import { MetadataSchema } from '../../../src/core/metadata/schema.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'recon-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('reconcile config', () => {
  it('defaults', async () => {
    const c = (await load_plugin_config(dir)).reconcile;
    expect(c.ledger_path).toBe('.hewtd/reconcile.json');
    expect(c.keep_in_place).toContain('README.md');
    expect(c.team).toEqual({ min_docs: 12, min_bytes: 250000, max_agents: 4, docs_per_agent: 8 });
  });
  it('bad values fall back per key', async () => {
    await mkdir(join(dir, '.claude'));
    await writeFile(join(dir, '.claude/hit-em-with-the-docs.json'),
      JSON.stringify({ reconcile: { ledger_path: 5, team: { min_docs: -1, max_agents: 2 } } }));
    const c = (await load_plugin_config(dir)).reconcile;
    expect(c.ledger_path).toBe('.hewtd/reconcile.json');
    expect(c.team.min_docs).toBe(12);
    expect(c.team.max_agents).toBe(2);
  });
});

describe('ledger', () => {
  const file = () => join(dir, '.hewtd/reconcile.json');
  it('round-trips and tolerates missing/corrupt files', async () => {
    expect((await load_ledger(file())).entries).toEqual({});
    const l = await load_ledger(file());
    record_entry(l, { path: 'a.md', lane: 'judge', verdict: 'keep', content_hash: 'h1' });
    await save_ledger(file(), l);
    expect((await load_ledger(file())).entries['a.md'].verdict).toBe('keep');
    await writeFile(file(), '{nope');
    expect((await load_ledger(file())).entries).toEqual({});
  });
  it('concurrent saves leave valid JSON and no temp files', async () => {
    const ls = Array.from({ length: 10 }, (_, i) => {
      const l = { version: 1 as const, entries: {} };
      record_entry(l, { path: `${i}.md`, lane: 'x', content_hash: 'h' });
      return l;
    });
    await Promise.all(ls.map((l) => save_ledger(file(), l)));
    expect(Object.keys((await load_ledger(file())).entries)).toHaveLength(1);
    expect(await readdir(join(dir, '.hewtd'))).toEqual(['reconcile.json']);
  });
  it('changed content resets the entry', () => {
    const l = { version: 1 as const, entries: {} };
    record_entry(l, { path: 'a.md', lane: 'judge', verdict: 'keep', applied_commit: 'abc', content_hash: hash_content('v1') });
    expect(is_reviewed(l.entries['a.md'], hash_content('v1'))).toBe(true);
    expect(is_reviewed(l.entries['a.md'], hash_content('v2'))).toBe(false);
    const e = record_entry(l, { path: 'a.md', lane: 'judge', content_hash: hash_content('v2') });
    expect(e.verdict).toBeUndefined();
    expect(e.applied_commit).toBeUndefined();
  });
  it('status counts and lists next unreviewed', () => {
    const l = { version: 1 as const, entries: {} };
    record_entry(l, { path: 'a.md', lane: 'judge', verdict: 'keep', content_hash: 'h' });
    record_entry(l, { path: 'b.md', lane: 'judge', verdict: 'keep', content_hash: 'old' });
    const st = ledger_status(l, [{ path: 'a.md', hash: 'h' }, { path: 'b.md', hash: 'new' }, { path: 'c.md', hash: 'z' }], 5);
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
