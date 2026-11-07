import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadPluginConfig } from '../../../src/utils/config';
import { triage } from '../../../src/core/reconcile/triage';
import { checkDocReferences, buildRepoIndex, type RelatedRepo } from '../../../src/core/reconcile/references';
import { discoverOutside } from '../../../src/core/reconcile/outside';

let base: string;
let proj: string;
let sib: string;
const gi = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf-8' });
const put = (root: string, p: string, c: string) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), c); };
const fm = (sources = '[src/a.ts]') => `---\ntitle: T\npurpose: Explains how the widget pipeline retries failed jobs after a timeout\nsources: ${sources}\nlast_verified: 2026-01-01\n---\n`;
const related = (): RelatedRepo[] => [{ name: 'api', root: sib }];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'related-'));
  proj = join(base, 'proj');
  sib = join(base, 'api');
  for (const r of [proj, sib]) { mkdirSync(r); gi(r, 'init', '-q'); }
  put(proj, 'src/a.ts', 'export const widgetRetry = 1;\n');
  put(proj, '.claude/hit-em-with-the-docs.json', JSON.stringify({ reconcile: { related_repos: [{ name: 'api', path: '../api' }, { name: 'ghost', path: '../ghost' }, { bad: true }] } }));
  put(sib, 'lib/server.ts', 'export function handleSibling() {}\n');
  put(sib, 'package.json', JSON.stringify({ scripts: { 'sib-script': 'x' } }));
  put(sib, '.documentation/ops/auth.md', '# auth\n');
  gi(sib, 'add', '-A'); gi(sib, 'commit', '-qm', 'init');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('related repos: references', () => {
  const resolve = async (body: string, rel: RelatedRepo[] = related()) => {
    put(proj, 'docs/x.md', body);
    gi(proj, 'add', '-A');
    return checkDocReferences(buildRepoIndex(proj), body, { docFile: join(proj, 'docs/x.md'), docsPath: join(proj, 'docs'), related: rel });
  };

  it('finds refs only a sibling has, with a <name>: where; read-only', async () => {
    const rs = await resolve('`lib/server.ts` `handleSibling()` `npm run sib-script` `lib/nope.ts`');
    const by = Object.fromEntries(rs.map((r) => [r.ref, r]));
    expect(by['lib/server.ts']).toMatchObject({ status: 'ok', where: 'api:lib/server.ts' });
    expect(by['handleSibling']).toMatchObject({ status: 'ok', where: 'api:lib/server.ts' });
    expect(by['npm run sib-script']).toMatchObject({ status: 'ok', where: 'api:package.json' });
    expect(by['lib/nope.ts']!.status).toBe('missing');
    expect(gi(sib, 'status', '--porcelain')).toBe('');
  });

  it('an unavailable sibling leaves unresolved refs unknown, not missing', async () => {
    const rs = await resolve('`lib/server.ts`', [{ name: 'api', root: join(base, 'gone') }]);
    expect(rs[0]!.status).toBe('unknown');
  });

  it('cross-links into a sibling .documentation are checked; other outside links are unknown', async () => {
    const rs = await resolve('[a](../../api/.documentation/ops/auth.md) [b](../../api/.documentation/ops/no.md) [c](../../elsewhere/x.md)');
    expect(rs.map((r) => [r.status, r.where])).toEqual([
      ['ok', 'api:.documentation/ops/auth.md'],
      ['missing', 'api:.documentation/ops/no.md'],
      ['unknown', undefined],
    ]);
  });
});

describe('related repos: triage', () => {
  const run = async (rel: string) => triage({ root: proj, docsPath: join(proj, '.documentation'), rels: [rel], config: await loadPluginConfig(proj) });
  const commit = () => { gi(proj, 'add', '-A'); gi(proj, 'commit', '-qm', 'c'); };

  it('resolves <name>: sources, warns for a missing checkout, ignores invalid config entries', async () => {
    put(proj, '.documentation/ops/s.md', fm('[src/a.ts, "api:lib/server.ts", "api:lib/gone.ts"]') + 'Plain.\n');
    commit();
    const r = await run('ops/s.md');
    expect(r.docs[0]!.missing).toEqual(['api:lib/gone.ts']);
    expect(r.warnings.some((w) => w.includes('"ghost"'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('"api"'))).toBe(false);
    expect(r.docs[0]!.bytes).toBeGreaterThan(Buffer.byteLength('export function handleSibling() {}\n'));
  });

  it('counts sibling commits after the doc body change; bytes include sibling files', async () => {
    put(proj, '.documentation/ops/s.md', fm('[src/a.ts, "api:lib/server.ts"]') + 'Plain.\n');
    commit();
    for (let i = 0; i < 10; i++) { put(sib, 'lib/server.ts', `export function handleSibling() { return ${i + 1}; }\n`); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-aqm', `c${i}`], { cwd: sib, env: { ...process.env, GIT_COMMITTER_DATE: '2099-01-01T00:00:00Z' } }); }
    const r = await run('ops/s.md');
    expect(r.docs[0]!.staleCommits).toBeGreaterThanOrEqual(10);
    expect(r.docs[0]!.lane).toBe('check');
    expect(gi(sib, 'status', '--porcelain')).toBe('');
  });

  it('ownership hint fires, then clears once the doc cross-links into the sibling docs', async () => {
    const body = 'See `lib/server.ts`, `handleSibling()` and `src/a.ts`.\n';
    put(proj, '.documentation/ops/o.md', fm() + body);
    commit();
    let d = (await run('ops/o.md')).docs[0]!;
    expect(d.owner).toBe('api');
    expect(d.lane).toBe('check');
    expect(d.reasons).toContain('details owned by api: summarize and cross-link');
    put(proj, '.documentation/ops/o.md', fm() + body + '\nOwner docs: [auth](../../../api/.documentation/ops/auth.md)\n');
    commit();
    d = (await run('ops/o.md')).docs[0]!;
    expect(d.owner).toBeUndefined();
    expect(d.lane).toBe('clean');
  });
});

describe('outside lane', () => {
  it('only scans the project, never a related repo', async () => {
    put(sib, 'NOTES.md', '# sibling notes\n');
    gi(sib, 'add', '-A'); gi(sib, 'commit', '-qm', 'n');
    put(proj, '.documentation/ops/a.md', '# a\n');
    put(proj, 'loose.md', '# loose\n');
    gi(proj, 'add', '-A'); gi(proj, 'commit', '-qm', 'p');
    const found = (await discoverOutside(join(proj, '.documentation'), [])).map((d) => d.path);
    expect(found.some((p) => p.includes('NOTES') || p.includes('api'))).toBe(false);
    expect(found).toContain('loose.md');
  });
});
