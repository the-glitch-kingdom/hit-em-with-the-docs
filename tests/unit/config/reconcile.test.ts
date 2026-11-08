import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { load_plugin_config } from '../../../src/utils/config.js';
import {
  load_ledger, write_ledger, build_ledger_entry, is_reviewed, get_ledger_status, compute_content_hash,
} from '../../../src/core/reconcile/ledger.js';
import { metadata_schema } from '../../../src/core/metadata/schema.js';

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
    build_ledger_entry(l, { path: 'a.md', lane: 'judge', verdict: 'keep', content_hash: 'h1' });
    await write_ledger(file(), l);
    expect((await load_ledger(file())).entries['a.md'].verdict).toBe('keep');
    await writeFile(file(), '{nope');
    expect((await load_ledger(file())).entries).toEqual({});
  });
  it('concurrent saves leave valid JSON and no temp files', async () => {
    const ls = Array.from({ length: 10 }, (_, i) => {
      const l = { version: 1 as const, entries: {} };
      build_ledger_entry(l, { path: `${i}.md`, lane: 'x', content_hash: 'h' });
      return l;
    });
    await Promise.all(ls.map((l) => write_ledger(file(), l)));
    expect(Object.keys((await load_ledger(file())).entries)).toHaveLength(1);
    expect(await readdir(join(dir, '.hewtd'))).toEqual(['reconcile.json']);
  });
  it('changed content resets the entry', () => {
    const l = { version: 1 as const, entries: {} };
    build_ledger_entry(l, { path: 'a.md', lane: 'judge', verdict: 'keep', applied_commit: 'abc', content_hash: compute_content_hash('v1') });
    expect(is_reviewed(l.entries['a.md'], compute_content_hash('v1'))).toBe(true);
    expect(is_reviewed(l.entries['a.md'], compute_content_hash('v2'))).toBe(false);
    const e = build_ledger_entry(l, { path: 'a.md', lane: 'judge', content_hash: compute_content_hash('v2') });
    expect(e.verdict).toBeUndefined();
    expect(e.applied_commit).toBeUndefined();
  });
  it('status counts and lists next unreviewed', () => {
    const l = { version: 1 as const, entries: {} };
    build_ledger_entry(l, { path: 'a.md', lane: 'judge', verdict: 'keep', content_hash: 'h' });
    build_ledger_entry(l, { path: 'b.md', lane: 'judge', verdict: 'keep', content_hash: 'old' });
    const st = get_ledger_status(l, [{ path: 'a.md', hash: 'h' }, { path: 'b.md', hash: 'new' }, { path: 'c.md', hash: 'z' }], 5);
    expect(st).toMatchObject({ total: 3, reviewed: 1, by_verdict: { keep: 1 }, next_unreviewed: ['b.md', 'c.md'] });
  });
});

describe('schema moved_from', () => {
  it('accepts moved_from, sources, last_verified, confidence on a non-fact tier', () => {
    const r = metadata_schema.safeParse({
      title: 'T', tier: 'guide', domains: ['api'], purpose: 'x', version: '1.0.0', status: 'active', last_updated: '2026-01-01',
      moved_from: 'docs/old.md', sources: ['src/a.ts'], last_verified: '2026-01-01', confidence: 'high',
    });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as any).moved_from).toBe('docs/old.md');
  });
});
