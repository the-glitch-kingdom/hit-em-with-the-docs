import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { load_plugin_config } from '../../../src/utils/config';
import { find_docs } from '../../../src/core/reconcile/search';

let dir: string;
const put = (rel: string, body: string) => {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), body);
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'search-'));
  put('ops/a.md', '---\ntitle: Deploy\nsymptoms:\n  - user_phrase: release stuck on rollback\n---\nShort.\n');
  put('ops/b.md', '---\ntitle: Notes\n---\nThe release is stuck sometimes. A rollback happens. ' + 'filler '.repeat(5) + '\n');
  put('ops/c.md', '---\ntitle: Other\nsources: [zzqx/hidden.ts]\n---\nNothing here.\n');
  put('ops/INDEX.md', '---\ntitle: release rollback stuck\n---\nrelease rollback stuck\n');
  put('ops/gen.md', '---\ntitle: release rollback stuck\ngenerated: true\n---\nx\n');
  put('archive/old.md', '---\ntitle: release rollback stuck\n---\nx\n');
  put('ops/tie1.md', '---\ntitle: Tiebreak\n---\nx\n');
  put('ops/tie2.md', '---\ntitle: Tiebreak\n---\nx\n');
  put('ops/secret.md', '---\ntitle: release rollback stuck\n---\nkey: AKIA' + 'Q7ZR3LMP9XVB2NCK\n');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('searchDocs', () => {
  it('ranks a symptoms match above a body-only mention; skips generated, archive and secret docs', async () => {
    const hits = await find_docs(dir, 'release stuck on rollback', { config: await load_plugin_config(dir) });
    expect(hits.map((h) => h.path).slice(0, 2)).toEqual(['ops/a.md', 'ops/b.md']);
    expect(hits[0]!.matched).toContain('symptoms');
    expect(hits.map((h) => h.path)).not.toContain('ops/INDEX.md');
    expect(hits.map((h) => h.path)).not.toContain('ops/gen.md');
    expect(hits.map((h) => h.path)).not.toContain('archive/old.md');
    expect(hits.map((h) => h.path)).not.toContain('ops/secret.md');
  });
  it('does not index sources', async () => {
    expect(await find_docs(dir, 'zzqx hidden')).toEqual([]);
  });
  it('breaks ties by path', async () => {
    const hits = await find_docs(dir, 'tiebreak');
    expect(hits.map((h) => h.path)).toEqual(['ops/tie1.md', 'ops/tie2.md']);
  });
  it('puts search_command results first and falls back with a warning on failure', async () => {
    const cfg = await load_plugin_config(dir);
    put('fixed.sh', '#!/bin/sh\necho ops/c.md\necho nope.md\n');
    chmodSync(join(dir, 'fixed.sh'), 0o755);
    cfg.reconcile.search_command = `${join(dir, 'fixed.sh')} {query}`;
    const hits = await find_docs(dir, 'release stuck on rollback', { config: cfg });
    expect(hits[0]).toMatchObject({ path: 'ops/c.md', matched: ['search_command'] });
    expect(hits[1]!.path).toBe('ops/a.md');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cfg.reconcile.search_command = join(dir, 'missing-binary') + ' {query}';
    const fb = await find_docs(dir, 'release stuck on rollback', { config: cfg });
    expect(fb[0]!.path).toBe('ops/a.md');
    expect(warn).toHaveBeenCalled();
  });
});
