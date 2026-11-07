import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkRetrieval, retrievalCoverage, type RetrievalDoc } from '../../../src/core/audit/retrieval.js';
import { auditDocumentation } from '../../../src/core/audit/auditor.js';
import { loadPluginConfig } from '../../../src/utils/config.js';

const cfg = (await loadPluginConfig('/nonexistent')).retrieval;
const GOOD = 'Explains how the deploy pipeline promotes builds to production safely';
const doc = (rel: string, data: Record<string, unknown>, body = 'x'): RetrievalDoc => ({
  rel,
  data: { title: `Title of ${rel}`, purpose: GOOD, ...data },
  body,
});
const codes = (docs: RetrievalDoc[], c = cfg) => checkRetrieval(docs, c).map((i) => `${i.rule}:${i.file}`);

describe('retrieval rules', () => {
  it('flags missing purpose, pointing at the migration when summary exists', () => {
    const [i] = checkRetrieval([doc('a/x.md', { purpose: undefined, summary: 'old' })], cfg);
    expect(i?.rule).toBe('RETRIEVAL_MISSING_PURPOSE');
    expect(i?.suggestion).toContain('hewtd fix-retrieval-fields');
    const [j] = checkRetrieval([doc('a/x.md', { purpose: undefined })], cfg);
    expect(j?.suggestion).not.toContain('fix-retrieval-fields');
  });

  it('flags weak purpose: title echo, short, placeholder; accepts a good one', () => {
    for (const purpose of ['Title of a/x.md', 'Too short here', 'Documentation for the deploy pipeline and many words']) {
      expect(codes([doc('a/x.md', { purpose })])).toEqual(['RETRIEVAL_WEAK_PURPOSE:a/x.md']);
    }
    expect(codes([doc('a/x.md', {})])).toEqual([]);
  });

  it('flags generic and duplicated titles', () => {
    expect(codes([doc('a/x.md', { title: 'Overview' })])).toEqual(['RETRIEVAL_GENERIC_TITLE:a/x.md']);
    expect(codes([doc('a/x.md', { title: 'Same' }), doc('b/y.md', { title: 'same' })]).sort()).toEqual([
      'RETRIEVAL_GENERIC_TITLE:a/x.md',
      'RETRIEVAL_GENERIC_TITLE:b/y.md',
    ]);
  });

  it('flags missing symptoms only on runbook-style docs', () => {
    expect(codes([doc('a/x.md', { tier: 'fact' })])).toEqual(['RETRIEVAL_MISSING_SYMPTOMS:a/x.md']);
    expect(codes([doc('troubleshooting/x.md', {})])).toEqual(['RETRIEVAL_MISSING_SYMPTOMS:troubleshooting/x.md']);
    expect(codes([doc('a/db-runbook.md', {})])).toHaveLength(1);
    expect(codes([doc('troubleshooting/x.md', { symptoms: ['it hangs'] })])).toEqual([]);
    expect(codes([doc('a/x.md', {})])).toEqual([]);
  });

  it('flags oversized docs by chars or H2 count', () => {
    expect(codes([doc('a/x.md', {}, 'x'.repeat(15001))])).toEqual(['RETRIEVAL_OVERSIZED:a/x.md']);
    expect(codes([doc('a/x.md', {}, '## h\n'.repeat(13))])).toEqual(['RETRIEVAL_OVERSIZED:a/x.md']);
    expect(codes([doc('a/x.md', {}, '## h\n'.repeat(12))])).toEqual([]);
  });

  it('skips generated, INDEX, drafts, reports, archive and plan docs', () => {
    const bad = { purpose: undefined, title: 'Overview' };
    const docs = [
      doc('a/x.md', { ...bad, generated: true }),
      doc('a/INDEX.md', bad),
      doc('drafts/x.md', bad),
      doc('reports/x.md', bad),
      doc('a/archive/x.md', bad),
      doc('a/p.md', { ...bad, tier: 'plan' }),
    ];
    expect(codes(docs)).toEqual([]);
    expect(retrievalCoverage(docs, cfg).total).toBe(0);
  });

  it('honors config overrides and falls back on invalid values', () => {
    const body = 'x'.repeat(200);
    expect(codes([doc('a/x.md', {}, body)], { ...cfg, oversized_chars: 100 })).toHaveLength(1);
    expect(codes([doc('a/x.md', { title: 'Cookbook' })], { ...cfg, generic_titles: ['cookbook'] })).toHaveLength(1);
    expect(codes([doc('a/x.md', { purpose: undefined })], { ...cfg, disabled: ['RETRIEVAL_MISSING_PURPOSE'] })).toEqual([]);
  });

  it('computes coverage', () => {
    const c = retrievalCoverage(
      [doc('a/x.md', { symptoms: ['s'] }), doc('a/y.md', { purpose: undefined })],
      cfg
    );
    expect(c).toEqual({ total: 2, withPurpose: 1, withSymptoms: 1, withUniqueTitle: 2 });
  });
});

describe('audit integration', () => {
  it('emits warnings without code, never errors, and skips a generated INDEX.md', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ret-'));
    try {
      await mkdir(join(dir, 'guides'));
      const fm = (extra: string) =>
        `---\ntitle: Overview\ntier: guide\ndomains: [guides]\nstatus: active\nversion: 1.0.0\nlast_updated: '2026-01-01'\ntags: [a]\n${extra}---\n\nbody\n`;
      await writeFile(join(dir, 'guides', 'a.md'), fm(''));
      await writeFile(join(dir, 'guides', 'INDEX.md'), fm('generated: true\n'));
      await writeFile(join(dir, 'guides', 'plain.md'), fm('generated: true\n'));
      const r = await auditDocumentation({ docsPath: dir, silent: true, projectRoot: dir });
      const ret = r.issues.filter((i) => i.rule.startsWith('RETRIEVAL_'));
      expect(ret.length).toBeGreaterThan(0);
      expect(ret.every((i) => i.severity === 'warning' && i.code === undefined)).toBe(true);
      expect(ret.some((i) => i.file.endsWith('INDEX.md') || i.file.endsWith('plain.md'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
