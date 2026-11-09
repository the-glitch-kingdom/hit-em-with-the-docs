import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify_gaps } from '../../../src/core/reconcile/gaps.js';
import { render_gaps_report } from '../../../src/core/reconcile/gaps-report.js';
import { load_plugin_config } from '../../../src/utils/config.js';

const token = 'AK' + 'IA' + 'Q7ZR3LMP9XVB2NCK'; // runtime fragments: no secret literal in the repo
let repo: string, docs: string;
const w = (p: string, t: string): void => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'gapsc-'));
  docs = join(repo, '.documentation');
  w(join(docs, 'devops/release-flow.md'), '---\ntitle: Release\nsymptoms:\n  - release is stuck\n---\n# x\n');
  w(join(docs, 'archive/old.md'), '# old\n');
  w(join(docs, 'ops/leaky.md'), `# k\nkey ${token}\n`);
  w(join(docs, 'ops/owner.md'), '---\ntitle: Owner\nsources:\n  - src/deploy/rollbackRelease.ts\n---\n# o\n');
  w(join(repo, 'src/deploy/rollbackRelease.ts'), 'export function rollbackRelease() {}\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const run = async (gaps: Array<{ query: string; used_doc: string | null; count?: number }>) =>
  classify_gaps(gaps, { root: repo, docs_root: docs, config: await load_plugin_config(repo) });

describe('classifyGaps (#66)', () => {
  it('known used doc -> phrase proposal, counts of repeated queries added', async () => {
    const r = await run([{ query: 'how do I undo a bad release', used_doc: 'devops/release-flow.md', count: 2 }, { query: 'How do I undo a bad release?', used_doc: 'devops/release-flow.md' }].map((g) => ({ ...g, query: g.query.replace(/\?$/, '') })));
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]!.doc).toBe('devops/release-flow.md');
    expect(r.proposals[0]!.accepted.map((a) => a.count)).toEqual([3]);
    expect(r.proposals[0]!.existing).toEqual(['release is stuck']);
  });
  it('unknown doc + code identifier -> candidate with that file in sources and the owning domain', async () => {
    const r = await run([{ query: 'what does rollbackRelease do on failure', used_doc: null }]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.sources).toContain('src/deploy/rollbackRelease.ts');
    expect(r.candidates[0]!.domain).toBe('ops');
  });
  it('neither -> open question', async () => {
    const r = await run([{ query: 'why is the office wifi slow', used_doc: null }]);
    expect(r.questions.map((q) => q.query)).toEqual(['why is the office wifi slow']);
    expect(r.proposals).toEqual([]);
  });
  it('archived or secret-lane used_doc is never proposed', async () => {
    const r = await run([{ query: 'where is the old thing documented', used_doc: 'archive/old.md' }, { query: 'where is the leaky thing documented', used_doc: 'ops/leaky.md' }]);
    expect(r.proposals).toEqual([]);
    expect(r.questions).toHaveLength(2);
  });
  it('secret-shaped query is dropped and the report never shows it', async () => {
    const r = await run([{ query: `why does ${token} fail on login`, used_doc: 'devops/release-flow.md' }]);
    expect(r.dropped[0]!.reason).toBe('secret');
    const text = render_gaps_report(r, (await load_plugin_config(repo)).reconcile.secrets, '2026-11-07');
    expect(text).not.toContain(token);
    expect(text).toContain('Dropped (1)');
  });
  it('changes nothing in the docs tree', async () => {
    await run([{ query: 'how do I undo a bad release', used_doc: 'devops/release-flow.md' }]);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' })).toBe('');
    expect(existsSync(join(docs, 'devops/release-flow.md'))).toBe(true);
    expect(readFileSync(join(docs, 'devops/release-flow.md'), 'utf-8')).toContain('release is stuck');
  });
});
