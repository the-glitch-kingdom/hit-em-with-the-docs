import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { check_retrieval, retrieval_coverage, type RetrievalDoc } from '../../../src/core/audit/retrieval.js';
import { audit_documentation } from '../../../src/core/audit/auditor.js';
import { load_plugin_config } from '../../../src/utils/config.js';

const cfg = (await load_plugin_config('/nonexistent')).retrieval;
const GOOD = 'Explains how the deploy pipeline promotes builds to production safely';
const doc = (rel: string, data: Record<string, unknown>, body = 'x'): RetrievalDoc => ({
  rel,
  data: { title: `Title of ${rel}`, purpose: GOOD, ...data },
  body,
});
const codes = (docs: RetrievalDoc[], c = cfg) => check_retrieval(docs, c).map((i) => `${i.rule}:${i.file}`);

describe('retrieval rules', () => {
  it('flags missing purpose, pointing at the migration when summary exists', () => {
    const [i] = check_retrieval([doc('a/x.md', { purpose: undefined, summary: 'old' })], cfg);
    expect(i?.rule).toBe('RETRIEVAL_MISSING_PURPOSE');
    expect(i?.suggestion).toContain('hewtd fix-retrieval-fields');
    const [j] = check_retrieval([doc('a/x.md', { purpose: undefined })], cfg);
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
    expect(retrieval_coverage(docs, cfg).total).toBe(0);
  });

  it('honors config overrides and falls back on invalid values', () => {
    const body = 'x'.repeat(200);
    expect(codes([doc('a/x.md', {}, body)], { ...cfg, oversized_chars: 100 })).toHaveLength(1);
    expect(codes([doc('a/x.md', { title: 'Cookbook' })], { ...cfg, generic_titles: ['cookbook'] })).toHaveLength(1);
    expect(codes([doc('a/x.md', { purpose: undefined })], { ...cfg, disabled: ['RETRIEVAL_MISSING_PURPOSE'] })).toEqual([]);
  });

  it('computes coverage', () => {
    const c = retrieval_coverage(
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
      const r = await audit_documentation({ docs_path: dir, silent: true, project_root: dir });
      const ret = r.issues.filter((i) => i.rule.startsWith('RETRIEVAL_'));
      expect(ret.length).toBeGreaterThan(0);
      expect(ret.every((i) => i.severity === 'warning' && i.code === undefined)).toBe(true);
      expect(ret.some((i) => i.file.endsWith('INDEX.md') || i.file.endsWith('plain.md'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('near duplicates', () => {
    const para = 'The deploy pipeline promotes a build through staging before production. '.repeat(6);
    const dup = (docs: RetrievalDoc[], c = cfg) =>
      check_retrieval(docs, c).filter((i) => i.rule === 'RETRIEVAL_NEAR_DUPLICATE');

    it('one warning per pair, whitespace-insensitive, one per pair for many shared passages', () => {
      const a = doc('a/x.md', {}, `intro one\n\n${para}\n\n${para}x`);
      const b = doc('b/y.md', {}, `other\n\n${para.replace(/ /g, '  \n')}\n\n${para}x`);
      const w = dup([a, b]);
      expect(w).toHaveLength(1);
      expect(w[0]?.file).toBe('b/y.md');
      expect(w[0]?.message).toContain('Shares 2 passage(s)');
      expect(w[0]?.message).toContain('a/x.md');
    });

    it('ignores short shared text, generated docs, and the toggle', () => {
      const short = 'Shared boilerplate line.';
      expect(dup([doc('a/x.md', {}, short), doc('b/y.md', {}, short)])).toEqual([]);
      expect(dup([doc('a/x.md', {}, para), doc('b/y.md', { generated: true }, para)])).toEqual([]);
      expect(dup([doc('a/x.md', {}, para), doc('b/y.md', {}, para)], { ...cfg, near_duplicate: false })).toEqual([]);
    });

    it('stays fast on 1000 docs', () => {
      const docs = Array.from({ length: 1000 }, (_, i) => doc(`d/${i}.md`, {}, `${para}\n\nunique ${i} `.concat('z'.repeat(400))));
      const t0 = Date.now();
      const w = dup(docs);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(w.length).toBe(1000 * 999 / 2);
    });
  });
});

describe('countActionableIssues (Action fail-on-error, review fix)', () => {
  it('ignores advisory RETRIEVAL_* warnings', async () => {
    const { count_actionable_issues } = await import('../../../src/core/audit/auditor.js');
    expect(
      count_actionable_issues([
        { rule: 'RETRIEVAL_MISSING_PURPOSE' },
        { rule: 'RETRIEVAL_OVERSIZED' },
        { rule: 'metadata-validation' },
      ])
    ).toBe(1);
  });
});
