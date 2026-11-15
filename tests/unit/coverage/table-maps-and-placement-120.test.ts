import { describe, it, expect } from 'vitest';
import { resolve_decision, is_hub_doc, type DocText } from '../../../src/core/coverage/decide.js';
import { name_new_doc } from '../../../src/core/coverage/naming.js';
import type { CoverageMiss } from '../../../src/core/coverage/facets.js';

const doc = (path: string, text: string, sources: string[] = []): DocText => ({ path, text, sources });
const miss = (query: string, facets: string[]): CoverageMiss => ({ key: 'q', query, count: 1, facets });
const code = (...entries: Array<[string, string, number]>) => new Map(entries.map(([facet, file, line]) => [facet, [{ file, line }]] as const));
const none = new Map();

describe('a file map written as tables is a hub (#120 section 5)', () => {
  const rows = Array.from({ length: 7 }, (_, i) => `| \`monitoring/part${i}.yml\` | part ${i} of the alerting setup |`);
  const table = ['| Path | Purpose |', '|---|---|', ...rows].join('\n');
  it('a doc titled File Map whose body is path tables is a hub', () => {
    expect(is_hub_doc(doc('ops/monitoring-map.md', `---\ntitle: Monitoring File Map\n---\n# Monitoring File Map\n\n${table}\n`))).toBe(true);
  });
  it('table rows with bare paths in the first cell count, even without a title signal', () => {
    const bare = ['| Path | Purpose |', '|---|---|', ...Array.from({ length: 6 }, (_, i) => `| monitoring/part${i} | part ${i} |`)].join('\n');
    expect(is_hub_doc(doc('ops/x.md', `# Things\n\n${bare}\n`))).toBe(true);
  });
  it('keywords with inventory make a hub; so does a title with file map', () => {
    expect(is_hub_doc(doc('ops/a.md', '---\ntitle: Alerts\nkeywords: [alerts, inventory]\n---\n# Alerts\n\nProse only.\n'))).toBe(true);
    expect(is_hub_doc(doc('ops/b.md', '---\ntitle: Alerts file-map\n---\n# Alerts\n\nProse only.\n'))).toBe(true);
    expect(is_hub_doc(doc('ops/c.md', '---\ntitle: Alerts runbook\nkeywords: [alerts]\n---\n# Alerts\n\nProse only.\n'))).toBe(false);
  });
  it('a runbook with one table holding a few paths is not a hub', () => {
    const runbook = ['# Runbook', '', 'When the exporter is down, restart it and check the dashboards for gaps.', 'Escalate to on-call if it stays down for more than ten minutes.', '', '| File | Why |', '|---|---|', '| `src/a.ts` | the exporter |', '| `src/b.ts` | the scraper |', '', 'Then confirm the alert clears.'].join('\n');
    expect(is_hub_doc(doc('ops/runbook.md', runbook))).toBe(false);
  });
  it('the alerts pair goes to the alerts runbook that cites the rules file, not the file map', () => {
    const map = doc('ops/monitoring-map.md', `---\ntitle: Monitoring File Map\n---\n${table}\n`, ['monitoring/rules.yml']);
    const runbook = doc('ops/alerts-runbook.md', '---\ntitle: Alerts runbook\npurpose: What each alert rule means\n---\n# Alerts runbook\n', ['monitoring/rules.yml']);
    const d = resolve_decision(miss('which alert rules fire on exporter failure', ['alert_exporter_down', 'alert_scrape_failed']), { code: code(['alert_exporter_down', 'monitoring/rules.yml', 9]), instructions: none }, [map, runbook]);
    expect(d).toMatchObject({ kind: 'extend', doc: 'ops/alerts-runbook.md' });
  });
});

describe('new-doc placement: the folder most neighbours share (#120 section 6)', () => {
  const located = { code: code(['zz_chunk_limit', 'src/uploads/chunk.ts', 3]), instructions: none };
  const q = miss('how large can a chunk be', ['zz_chunk_limit']);
  const near = (path: string): DocText => doc(path, `# ${path}`, ['src/uploads/x.ts']);
  it('a majority in the feature subfolder wins over one doc at the domain root', () => {
    const d = resolve_decision(q, located, [near('features/uploads/a.md'), near('features/uploads/b.md'), near('features/notes.md')]);
    expect(d).toMatchObject({ kind: 'new', domain: 'features', folder: 'features/uploads' });
  });
  it('a majority is the deepest subfolder holding more than half', () => {
    const d = resolve_decision(q, located, [near('features/uploads/chunks/a.md'), near('features/uploads/chunks/b.md'), near('features/uploads/c.md')]);
    expect(d.folder).toBe('features/uploads/chunks');
  });
  it('no majority: the common parent, as before', () => {
    const d = resolve_decision(q, located, [near('features/uploads/a.md'), near('features/media/b.md')]);
    expect(d.folder).toBe('features');
  });
});

describe('new-doc naming: a boolean facet does not name a doc (#120 section 6)', () => {
  it('a lone is_ identifier loses to the source module', () => {
    expect(name_new_doc({ queries: ['is the workspace a sample'], facets: ['is_sample'], source_files: ['src/workspaces/sample_workspace.py'] })).toBe('sample-workspace');
  });
  it('a non-boolean identifier beats a boolean one', () => {
    expect(name_new_doc({ queries: ['q'], facets: ['is_sample', 'has_flag', 'SampleWorkspace'], source_files: [] })).toBe('sample-workspace');
  });
  it('a boolean identifier still names the doc when nothing else does, without its prefix', () => {
    expect(name_new_doc({ queries: ['q'], facets: ['is_sample'], source_files: ['src/index.ts'] })).toBe('sample');
  });
});

describe('a new doc is titled from its subject, the question stays in symptoms (#120 section 6)', () => {
  it('title and purpose come from the subject, not the question text', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { build_drafts } = await import('../../../src/core/coverage/draft.js');
    const repo = mkdtempSync(join(tmpdir(), 'title120-'));
    try {
      mkdirSync(join(repo, 'src/upload'), { recursive: true });
      writeFileSync(join(repo, 'src/upload/limits.ts'), 'export const MAX_FILE_SIZE = 10 * 1024 * 1024;\n');
      const question = 'how large can an upload be with ChunkedUploadService';
      const result = await build_drafts({ repo_root: repo, docs_root: join(repo, '.documentation'), secrets_config: { allow: [], disabled_rules: [] }, today: '2026-11-15', proposals: [{ kind: 'new', closes: [{ key: 'q1', query: question, count: 1 }], count: 1, missing_facets: ['MAX_FILE_SIZE', 'ChunkedUploadService'], sources: [{ file: 'src/upload/limits.ts', line: 1 }], source_files: ['src/upload/limits.ts'], cited_by: [], instruction_files: [], flags: [], notes: [], generated_reference: [] }] });
      const draft = result.entries[0]!.draft!;
      expect(draft).toMatch(/^title: Chunked upload$/m);
      expect(draft).toMatch(/^purpose: Explains chunked upload/m);
      expect(draft).not.toMatch(/^(title|purpose): .*how large/m);
      expect(draft).toMatch(/symptoms:\n\s+- how large can an upload be/);
      expect(draft).toMatch(/^# Chunked upload$/m);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
