import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect_declared_lists } from '../../../src/core/coverage/merge.js';
import { plan_coverage_misses } from '../../../src/core/coverage/plan.js';
import { load_plugin_config } from '../../../src/utils/config.js';

describe('detect_declared_lists with facets (#120 section 2)', () => {
  const files = new Map([['src/app.ts', "app.get('/a', h);\napp.post('/b', h);\napp.get('/c', h);\n\n\nclass GZipMiddleware {}\n"]]);
  it('without facets every declared list is reported, as before', () => {
    expect(detect_declared_lists(files)).toHaveLength(1);
  });
  it('a facet that is no entry of the list drops the hint', () => {
    expect(detect_declared_lists(files, ['GZipMiddleware', 'minimum_size'])).toEqual([]);
  });
  it('a facet matching an entry keeps the hint and records what it covers', () => {
    const [list] = detect_declared_lists(files, ['GZipMiddleware', "'/b'"]);
    expect(list!.covers).toEqual(["'/b'"]);
  });
  it('a position facet on an entry line is covered', () => {
    const [list] = detect_declared_lists(files, ['position src/app.ts:2']);
    expect(list!.covers).toEqual(['position src/app.ts:2']);
  });
});

let repo: string;
const w = (p: string, t: string): void => { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), t); };
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'hint120-'));
  w('src/main.ts', "app.get('/a', h);\napp.get('/b', h);\napp.get('/c', h);\napp.get('/d', h);\n\nexport class SkipGzip {}\nexport const MIN_SIZE = 500;\n");
  w('src/cli.ts', ".option('--verbose')\n.option('--quiet')\n.option('--dry')\n\nexport const MAX_ROWS = 100;\nexport const batch_note = 1;\n");
  w('ops/alerts.yml', '- alert: HighErrors\n- alert: SlowQueue\n- alert: Down\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const run = async (gaps: Parameters<typeof plan_coverage_misses>[0]['gaps']) => plan_coverage_misses({ repo_root: repo, docs_root: join(repo, '.documentation'), config: await load_plugin_config(repo), gaps, today: '2026-11-15' });

describe('plan: the reference hint sits beside the draft (#120 section 2)', () => {
  it('facets that are no route get a draft and no route hint', async () => {
    const r = await run([{ query: 'what does the compression middleware skip', used_doc: null, id: 'q', facets: ['SkipGzip', 'MIN_SIZE'] }]);
    expect(r.proposals[0]!.generated_reference).toEqual([]);
    expect(r.drafts.skipped).toEqual([]);
    expect(r.drafts.entries).toHaveLength(1);
  });
  it('one facet a CLI flag: hint for it, the other facets drafted', async () => {
    const r = await run([{ query: 'what does the capture script do', used_doc: null, id: 'q', facets: ['--verbose', 'MAX_ROWS'] }]);
    expect(r.proposals[0]!.generated_reference.map((list) => list.kind)).toEqual(['cli-flags']);
    expect(r.drafts.skipped).toEqual([]);
    expect(r.drafts.entries).toHaveLength(1);
    expect(r.drafts.entries[0]!.draft).toContain('MAX_ROWS');
    expect(r.drafts.entries[0]!.draft).not.toContain('--verbose');
    expect(r.drafts.entries[0]!.reasons!.join(' ')).toMatch(/generated reference suggested/);
  });
  it('the alerts pair still gets the hint and no prose', async () => {
    const r = await run([{ query: 'which alerts exist', used_doc: null, id: 'q', facets: ['HighErrors', 'SlowQueue'] }]);
    expect(r.drafts.skipped[0]!.reason).toMatch(/generated reference suggested/);
    expect(r.drafts.entries).toEqual([]);
  });
});
