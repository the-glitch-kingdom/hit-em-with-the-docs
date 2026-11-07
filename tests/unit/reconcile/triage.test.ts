import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadPluginConfig } from '../../../src/utils/config';
import { resolveScope, dirtyInScope, triage, planShards } from '../../../src/core/reconcile/triage';

let dir: string;
let docs: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'ignore' });
const put = (rel: string, body: string) => {
  mkdirSync(join(rel.startsWith('src') ? dir : docs, rel, '..'), { recursive: true });
  writeFileSync(join(rel.startsWith('src') ? dir : docs, rel), body);
};
const fm = (extra = '') =>
  `---\ntitle: T\npurpose: Explains how the widget pipeline retries failed jobs after a timeout\nsources: [src/a.ts]\nlast_verified: 2026-01-01\n${extra}---\n`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'triage-'));
  docs = join(dir, '.documentation');
  g('init', '-q');
  put('src/a.ts', 'export const widgetRetry = 1;\n');
  put('ops/clean.md', fm() + 'See `src/a.ts` and `widgetRetry`.\n');
  put('ops/fields.md', fm().replace(/purpose:.*\n/, '') + 'See `src/a.ts`.\n');
  put('ops/unattributed.md', '---\ntitle: U\n---\nSee `src/a.ts`.\n');
  put('ops/gone.md', fm() + 'See `src/a.ts` and `src/nope.ts`.\n');
  put('ops/dead.md', fm() + 'See `src/x.ts`, `src/y.ts`, `src/z.ts`, `src/a.ts`.\n');
  g('add', '-A');
  g('commit', '-m', 'init');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = async (rels: string[], mode?: 'serial' | 'team') => {
  const config = await loadPluginConfig(dir);
  return triage({ root: dir, docsPath: docs, rels, config, ...(mode && { mode }) });
};

describe('triage lanes', () => {
  it('sorts each fixture into its lane and never calls a doc with a missing ref clean', async () => {
    const r = await run(await resolveScope(docs, ['ops']));
    const lane = Object.fromEntries(r.docs.map((d) => [d.path, d.lane]));
    expect(lane).toEqual({
      'ops/clean.md': 'clean',
      'ops/fields.md': 'fields-only',
      'ops/unattributed.md': 'check',
      'ops/gone.md': 'check',
      'ops/dead.md': 'archive-candidate',
    });
    expect(r.docs.find((d) => d.path === 'ops/gone.md')!.missing).toContain('src/nope.ts');
    expect(r.totals.judgmentDocs).toBe(3);
    expect(r.docs.find((d) => d.path === 'ops/clean.md')!.bytes).toBeGreaterThan(30);
  });

  it('a frontmatter source that no longer exists keeps a doc out of clean (review fix)', async () => {
    put('ops/srcgone.md', fm().replace('[src/a.ts]', '[src/a.ts, src/removed.ts, "https://example.com/spec"]') + 'Plain prose only.\n');
    const r = await run(['ops/srcgone.md']);
    expect(r.docs[0]!.lane).toBe('check');
    expect(r.docs[0]!.missing).toEqual(['src/removed.ts']);
  });

  it('--next moves past docs triage found clean (review fix)', async () => {
    const ledger = { version: 1 as const, entries: {} };
    const config = await loadPluginConfig(dir);
    const first = await resolveScope(docs, [], { next: 1, ledger });
    expect(first).toEqual(['ops/clean.md']);
    await triage({ root: dir, docsPath: docs, rels: first, config, ledger });
    expect(await resolveScope(docs, [], { next: 1, ledger })).toEqual(['ops/dead.md']);
  });

  it('is deterministic and writes nothing under the docs tree', async () => {
    const rels = await resolveScope(docs, ['ops']);
    const a = JSON.stringify(await run(rels));
    expect(JSON.stringify(await run(rels))).toBe(a);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' })).toBe('');
  });
});

describe('scope', () => {
  it('accepts a folder, a file and --next, and rejects no scope', async () => {
    expect(await resolveScope(docs, ['ops'])).toHaveLength(5);
    expect(await resolveScope(docs, ['ops/clean.md'])).toEqual(['ops/clean.md']);
    expect(await resolveScope(docs, [], { next: 2 })).toEqual(['ops/clean.md', 'ops/dead.md']);
    await expect(resolveScope(docs, [])).rejects.toThrow(/scope/);
    await expect(resolveScope(docs, ['nope'])).rejects.toThrow(/not a file/);
  });

  it('--next skips docs the ledger already reviewed', async () => {
    const { hashContent } = await import('../../../src/core/reconcile/ledger');
    const { readFileSync } = await import('fs');
    const content = readFileSync(join(docs, 'ops/clean.md'), 'utf-8');
    const ledger = { version: 1 as const, entries: { 'ops/clean.md': { path: 'ops/clean.md', lane: 'clean', verdict: 'ok', content_hash: hashContent(content) } } };
    expect(await resolveScope(docs, [], { next: 1, ledger })).toEqual(['ops/dead.md']);
  });

  it('flags uncommitted changes in scope only', async () => {
    put('ops/clean.md', fm() + 'edited\n');
    expect(dirtyInScope(docs, ['ops/clean.md'])).toHaveLength(1);
    expect(dirtyInScope(docs, ['ops/gone.md'])).toEqual([]);
  });
});

describe('team plan', () => {
  const mk = (n: number, bytes = 100) => Array.from({ length: n }, (_, i) => ({ path: `d${i % 3}/doc${String(i).padStart(2, '0')}.md`, bytes }));

  it('is serial below the thresholds and team at or above', async () => {
    expect((await run(['ops/fields.md', 'ops/gone.md'])).mode).toBe('serial');
    const r = await run(await resolveScope(docs, ['ops']), 'team');
    expect(r.mode).toBe('team');
    expect(r.shards.length).toBeGreaterThan(0);
  });

  it('triggers on bytes alone', async () => {
    const config = await loadPluginConfig(dir);
    config.reconcile.team.min_bytes = 50;
    config.reconcile.team.docs_per_agent = 1;
    const r = await triage({ root: dir, docsPath: docs, rels: ['ops/gone.md', 'ops/fields.md'], config });
    expect(r.mode).toBe('team');
    expect(r.shards.length).toBe(2);
  });

  it('falls back to serial when the team plan would be a single shard', async () => {
    const config = await loadPluginConfig(dir);
    config.reconcile.team.min_bytes = 50;
    const r = await triage({ root: dir, docsPath: docs, rels: ['ops/gone.md'], config });
    expect(r.mode).toBe('serial');
    expect(r.shards).toEqual([]);
  });

  it('ignores lockfiles when estimating bytes', async () => {
    put('package-lock.json', 'x'.repeat(50000));
    put('ops/lock.md', fm() + 'See `package-lock.json` and `src/nope.ts`.\n');
    g('add', '-A'); g('commit', '-m', 'lock');
    const r = await run(['ops/lock.md']);
    expect(r.docs[0]!.bytes).toBeLessThan(5000);
  });

  it('shards are disjoint, cover every doc and respect max_agents', async () => {
    const config = await loadPluginConfig(dir);
    config.reconcile.team.max_agents = 3;
    const judged = mk(30);
    const shards = await planShards(docs, judged, config);
    const all = shards.flatMap((s) => s.docs);
    expect(shards.length).toBeLessThanOrEqual(3);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(judged.map((d) => d.path).sort());
    expect(JSON.stringify(await planShards(docs, judged, config))).toBe(JSON.stringify(shards));
  });

  it('keeps linked (clustered) docs in one shard when the cluster fits a fair share', async () => {
    const config = await loadPluginConfig(dir);
    config.reconcile.team.docs_per_agent = 2;
    const names = Array.from({ length: 3 }, (_, i) => `flow/f${i}.md`);
    for (const n of names) {
      const links = names.filter((m) => m !== n).map((m) => `[x](${m.replace('flow/', '')})`).join(' ');
      put(n, `---\ntitle: ${n}\n---\n${links}\n`);
    }
    for (let i = 0; i < 6; i++) put(`other/o${i}.md`, `---\ntitle: o${i}\n---\nx\n`);
    const judged = [...names, ...Array.from({ length: 6 }, (_, i) => `other/o${i}.md`)].map((path) => ({ path, bytes: 100 }));
    const shards = await planShards(docs, judged, config);
    const homes = new Set(shards.filter((s) => s.docs.some((d) => names.includes(d))).map((s) => s.id));
    expect(homes.size).toBe(1);
  });

  it('splits a cluster bigger than a fair share across agents', async () => {
    const config = await loadPluginConfig(dir);
    const names = Array.from({ length: 24 }, (_, i) => `flow/f${String(i).padStart(2, '0')}.md`);
    for (const n of names) {
      const links = names.filter((m) => m !== n).map((m) => `[x](${m.replace('flow/', '')})`).join(' ');
      put(n, `---\ntitle: ${n}\n---\n${links}\n`);
    }
    const shards = await planShards(docs, names.map((path) => ({ path, bytes: 100 })), config);
    expect(shards.length).toBe(3);
    expect(Math.max(...shards.map((s) => s.docs.length))).toBe(8);
    expect(shards.flatMap((s) => s.docs).sort()).toEqual(names);
  });
});
