import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, cpSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { load_plugin_config } from '../../../src/utils/config';
import { resolve_scope, find_dirty_in_scope, triage_docs, build_shards } from '../../../src/core/reconcile/triage';

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
  const config = await load_plugin_config(dir);
  return triage_docs({ root: dir, docs_root: docs, rels, config, ...(mode && { mode }) });
};

describe('triage lanes', () => {
  it('sorts each fixture into its lane and never calls a doc with a missing ref clean', async () => {
    const r = await run(await resolve_scope(docs, ['ops']));
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
    const config = await load_plugin_config(dir);
    const first = await resolve_scope(docs, [], { next: 1, ledger });
    expect(first).toEqual(['ops/clean.md']);
    await triage_docs({ root: dir, docs_root: docs, rels: first, config, ledger });
    expect(await resolve_scope(docs, [], { next: 1, ledger })).toEqual(['ops/dead.md']);
  });

  it('is deterministic and writes nothing under the docs tree', async () => {
    const rels = await resolve_scope(docs, ['ops']);
    const a = JSON.stringify(await run(rels));
    expect(JSON.stringify(await run(rels))).toBe(a);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' })).toBe('');
  });
});

describe('scope', () => {
  it('accepts a folder, a file and --next, and rejects no scope', async () => {
    expect(await resolve_scope(docs, ['ops'])).toHaveLength(5);
    expect(await resolve_scope(docs, ['ops/clean.md'])).toEqual(['ops/clean.md']);
    expect(await resolve_scope(docs, [], { next: 2 })).toEqual(['ops/clean.md', 'ops/dead.md']);
    await expect(resolve_scope(docs, [])).rejects.toThrow(/scope/);
    await expect(resolve_scope(docs, ['nope'])).rejects.toThrow(/not a file/);
  });

  it('--next skips docs the ledger already reviewed', async () => {
    const { compute_content_hash: hash_content } = await import('../../../src/core/reconcile/ledger');
    const { readFileSync: read_file_sync } = await import('fs');
    const content = read_file_sync(join(docs, 'ops/clean.md'), 'utf-8');
    const ledger = { version: 1 as const, entries: { 'ops/clean.md': { path: 'ops/clean.md', lane: 'clean', verdict: 'ok', content_hash: hash_content(content) } } };
    expect(await resolve_scope(docs, [], { next: 1, ledger })).toEqual(['ops/dead.md']);
  });

  it('flags uncommitted changes in scope only', async () => {
    put('ops/clean.md', fm() + 'edited\n');
    expect(find_dirty_in_scope(docs, ['ops/clean.md'])).toHaveLength(1);
    expect(find_dirty_in_scope(docs, ['ops/gone.md'])).toEqual([]);
  });
});

describe('team plan', () => {
  const mk = (n: number, bytes = 100) => Array.from({ length: n }, (_, i) => ({ path: `d${i % 3}/doc${String(i).padStart(2, '0')}.md`, bytes }));

  it('is serial below the thresholds and team at or above', async () => {
    expect((await run(['ops/fields.md', 'ops/gone.md'])).mode).toBe('serial');
    const r = await run(await resolve_scope(docs, ['ops']), 'team');
    expect(r.mode).toBe('team');
    expect(r.shards.length).toBeGreaterThan(0);
  });

  it('triggers on bytes alone', async () => {
    const config = await load_plugin_config(dir);
    config.reconcile.team.min_bytes = 50;
    config.reconcile.team.docs_per_agent = 1;
    const r = await triage_docs({ root: dir, docs_root: docs, rels: ['ops/gone.md', 'ops/fields.md'], config });
    expect(r.mode).toBe('team');
    expect(r.shards.length).toBe(2);
  });

  it('falls back to serial when the team plan would be a single shard', async () => {
    const config = await load_plugin_config(dir);
    config.reconcile.team.min_bytes = 50;
    const r = await triage_docs({ root: dir, docs_root: docs, rels: ['ops/gone.md'], config });
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
    const config = await load_plugin_config(dir);
    config.reconcile.team.max_agents = 3;
    const judged = mk(30);
    const shards = await build_shards(docs, judged, config);
    const all = shards.flatMap((s) => s.docs);
    expect(shards.length).toBeLessThanOrEqual(3);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(judged.map((d) => d.path).sort());
    expect(JSON.stringify(await build_shards(docs, judged, config))).toBe(JSON.stringify(shards));
  });

  it('keeps linked (clustered) docs in one shard when the cluster fits a fair share', async () => {
    const config = await load_plugin_config(dir);
    config.reconcile.team.docs_per_agent = 2;
    const names = Array.from({ length: 3 }, (_, i) => `flow/f${i}.md`);
    for (const n of names) {
      const links = names.filter((m) => m !== n).map((m) => `[x](${m.replace('flow/', '')})`).join(' ');
      put(n, `---\ntitle: ${n}\n---\n${links}\n`);
    }
    for (let i = 0; i < 6; i++) put(`other/o${i}.md`, `---\ntitle: o${i}\n---\nx\n`);
    const judged = [...names, ...Array.from({ length: 6 }, (_, i) => `other/o${i}.md`)].map((path) => ({ path, bytes: 100 }));
    const shards = await build_shards(docs, judged, config);
    const homes = new Set(shards.filter((s) => s.docs.some((d) => names.includes(d))).map((s) => s.id));
    expect(homes.size).toBe(1);
  });

  it('splits a cluster bigger than a fair share across agents', async () => {
    const config = await load_plugin_config(dir);
    const names = Array.from({ length: 24 }, (_, i) => `flow/f${String(i).padStart(2, '0')}.md`);
    for (const n of names) {
      const links = names.filter((m) => m !== n).map((m) => `[x](${m.replace('flow/', '')})`).join(' ');
      put(n, `---\ntitle: ${n}\n---\n${links}\n`);
    }
    const shards = await build_shards(docs, names.map((path) => ({ path, bytes: 100 })), config);
    expect(shards.length).toBe(3);
    expect(Math.max(...shards.map((s) => s.docs.length))).toBe(8);
    expect(shards.flatMap((s) => s.docs).sort()).toEqual(names);
  });
});

describe('triage cited files (#58)', () => {
  it('a symbol living in a large data file adds no bytes and no staleness', async () => {
    put('src/data.json', JSON.stringify({ v: 'widgetRetry ' + 'y'.repeat(3 * 1024 * 1024) }));
    g('add', '-A');
    g('commit', '-m', 'data');
    const r = await run(['ops/clean.md']);
    expect(r.docs[0]!.bytes).toBeLessThan(10000);
    expect(r.schemaFiles).toEqual([]);
  });

  it('--next 3 style small docs stay serial', async () => {
    const r = await run(['ops/clean.md', 'ops/fields.md', 'ops/gone.md']);
    expect(r.mode).toBe('serial');
  });
});

describe('secret lane (#59)', () => {
  // Built at runtime so the repo never holds a scannable literal.
  const tok = () => 'hv' + 's.' + 'q7Zr3LmP9xVb2NcK5tYw8HdJ';
  const key = () => 'sk' + '_live_' + 'q7Zr3LmP9xVb2NcK5tYw8HdJ';
  const lanes = async (rels: string[], mode?: 'serial' | 'team') => run(rels, mode);

  it('a doc holding a token goes to the secret lane, masked, in no shard', async () => {
    put('ops/leak.md', fm() + `See \`src/a.ts\`. token ${tok()}\n`);
    const r = await lanes(['ops/leak.md', 'ops/clean.md', 'ops/fields.md'], 'team');
    const d = r.docs.find((x) => x.path === 'ops/leak.md')!;
    expect(d.lane).toBe('secret');
    expect(d.findings![0]).toMatchObject({ rule: 'vault-token', masked: 'hvs.…28' });
    expect(JSON.stringify(r)).not.toContain(tok());
    expect(r.shards.flatMap((s) => s.docs)).not.toContain('ops/leak.md');
    expect(r.totals.byLane.secret).toBe(1);
    expect(r.totals.judgmentDocs).toBe(1);
    expect(r.docs.find((x) => x.path === 'ops/clean.md')!.lane).toBe('clean');
  });

  it('a clean doc citing a file with a key is blocked and the file is not cited', async () => {
    put('src/prod.env', `STRIPE=${key()}\n`);
    g('add', '-A');
    g('commit', '-m', 'env');
    put('ops/cites.md', fm().replace('[src/a.ts]', '[src/a.ts, src/prod.env]') + 'See `src/a.ts`.\n');
    const r = await lanes(['ops/cites.md']);
    const d = r.docs[0]!;
    expect(d.lane).toBe('secret');
    expect(d.blocked_files).toEqual(['src/prod.env']);
    expect(d.reasons.join()).toContain('stripe-key');
    expect(JSON.stringify(r)).not.toContain(key());
    // not counted as read: only the doc's own bytes plus src/a.ts
    expect(d.bytes).toBeLessThan(400);
  });

  it('a doc citing a markdown file with a finding keeps its own lane; the cited doc is withheld (#72)', async () => {
    put('src/leaky.md', `token ${tok()}\n`);
    g('add', '-A');
    g('commit', '-m', 'leaky doc');
    put('ops/links.md', fm().replace('[src/a.ts]', '[src/a.ts, src/leaky.md]') + 'See `src/a.ts`.\n');
    const r = await lanes(['ops/links.md']);
    const d = r.docs[0]!;
    expect(d.lane).not.toBe('secret');
    expect(d.blocked_files).toEqual(['src/leaky.md']);
    expect(d.reasons.join()).toContain('cited file withheld: src/leaky.md');
    expect(JSON.stringify(r)).not.toContain(tok());
  });

  it('weak findings in cited code withhold the file; known shapes and own findings still block (#69)', async () => {
    put('src/settings.py', 'VAULT_TOKEN = settings.VAULT_TOKEN_PATH\nDB_PASSWORD = "' + 'q7Zr3LmP9xVb2NcK5tYw8HdJ' + '"\n');
    put('src/known.py', `X = "${key()}"\n`);
    put('ops/mail.md', fm() + 'See `src/a.ts`. ADMIN_PASSWORD = "admin@corp.io"\n');
    g('add', '-A');
    g('commit', '-m', 'env');
    put('ops/weak.md', fm().replace('[src/a.ts]', '[src/a.ts, src/settings.py]') + 'See `src/a.ts`.\n');
    put('ops/strong.md', fm().replace('[src/a.ts]', '[src/a.ts, src/known.py]') + 'See `src/a.ts`.\n');
    const r = await lanes(['ops/weak.md', 'ops/strong.md', 'ops/mail.md']);
    const by = (p: string) => r.docs.find((x) => x.path === p)!;
    expect(by('ops/weak.md').lane).not.toBe('secret');
    expect(by('ops/weak.md').blocked_files).toEqual(['src/settings.py']);
    expect(by('ops/weak.md').reasons.join()).toContain('cited file withheld: src/settings.py');
    expect(by('ops/strong.md').lane).toBe('secret');
    expect(by('ops/mail.md').lane).not.toBe('secret');
    expect(JSON.stringify(r)).not.toContain('q7Zr3LmP9xVb2NcK5tYw8HdJ');
  });

  it('archive/, outside markdown and .hewtd/ are scanned and reported', async () => {
    put('archive/old.md', `token ${tok()}\n`);
    writeFileSync(join(dir, 'notes.md'), `key ${key()}\n`);
    mkdirSync(join(dir, '.hewtd'), { recursive: true });
    writeFileSync(join(dir, '.hewtd', 'x.txt'), `token ${tok()}\n`);
    g('add', 'notes.md');
    const r = await lanes(['ops/clean.md']);
    expect(r.peripheral.map((f) => f.file).sort()).toEqual(['.documentation/archive/old.md', '.hewtd/x.txt', 'notes.md']);
    expect(r.docs[0]!.lane).toBe('clean');
    const { scan_secrets } = await import('../../../src/core/reconcile/triage');
    const all = await scan_secrets({ root: dir, docs_root: docs, config: await load_plugin_config(dir) });
    expect(all).toHaveLength(3);
    expect(JSON.stringify(all)).not.toContain(tok());
  });
});

describe('triage refs and resolveDocs (#65)', () => {
  it('refs carry resolved and missing entries that match `missing`', async () => {
    const r = await run(['ops/gone.md']);
    const d = r.docs[0]!;
    expect(d.refs.find((x) => x.ref === 'src/a.ts')).toMatchObject({ kind: 'path', status: 'ok', where: 'src/a.ts' });
    expect(d.refs.filter((x) => x.status === 'missing').map((x) => x.ref)).toEqual(d.missing);
  });

  it('resolveDocs returns the same docs, writes no ledger and ignores a dirty tree', async () => {
    put('ops/gone.md', fm() + 'See `src/a.ts` and `src/nope.ts`. dirty\n');
    const config = await load_plugin_config(dir);
    const { resolve_docs } = await import('../../../src/core/reconcile/triage');
    const out = await resolve_docs({ root: dir, docs_root: docs, rels: ['ops/gone.md'], config });
    expect(out[0]!.lane).toBe('check');
    expect(out[0]!.refs.some((x) => x.ref === 'src/nope.ts' && x.status === 'missing')).toBe(true);
    expect(existsSync(join(dir, '.hewtd'))).toBe(false);
  });
});

describe('staged triage keeps the git staleness signal (#97 review)', () => {
  it('the same fixture gets the same lane and staleCommits live and staged; a new staged doc gets no history', async () => {
    put('ops/old.md', fm() + 'See `src/a.ts`.\n');
    g('add', '-A'); g('commit', '-m', 'doc');
    for (let i = 0; i < 11; i++) { writeFileSync(join(dir, 'src/a.ts'), `export const widgetRetry = ${i + 2};\n`); g('commit', '-am', `change ${i}`); }
    const live = (await run(['ops/old.md'])).docs[0]!;
    expect(live.lane).toBe('check');
    expect(live.staleCommits).toBeGreaterThanOrEqual(10);

    const stage_docs = join(dir, '.hewtd/stage/docs');
    mkdirSync(join(dir, '.hewtd/stage'), { recursive: true });
    cpSync(docs, stage_docs, { recursive: true });
    writeFileSync(join(stage_docs, 'ops/brand-new.md'), fm() + 'See `src/a.ts`.\n');
    const config = await load_plugin_config(dir);
    const staged = await triage_docs({ root: dir, docs_root: stage_docs, rels: ['ops/old.md', 'ops/brand-new.md'], config, history_docs_root: docs });
    const old = staged.docs.find((doc) => doc.path === 'ops/old.md')!;
    expect(old.lane).toBe(live.lane);
    expect(old.staleCommits).toBe(live.staleCommits);
    const fresh = staged.docs.find((doc) => doc.path === 'ops/brand-new.md')!;
    expect(fresh.staleCommits).toBeUndefined();
  });
});
