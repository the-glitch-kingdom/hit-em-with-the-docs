import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { heading_anchors, section_of, check_links } from '../../../src/core/links/checker.js';
import { count_actionable_issues } from '../../../src/core/audit/auditor.js';

describe('heading_anchors / section_of', () => {
  const md = '# Title\n\n## Setup & Run\n\ntext\n\n## Setup & Run\n\n### Deep\n\n## Custom {#my-id}\n\n<a id="legacy"></a>\n\n```\n## Not a heading\n```\n';

  it('slugs, duplicate suffixes, {#id}, <a id>, ignores fences', () => {
    const a = heading_anchors(md);
    for (const id of ['title', 'setup--run', 'setup--run-1', 'deep', 'my-id', 'legacy']) expect(a.has(id)).toBe(true);
    expect(a.has('not-a-heading')).toBe(false);
  });

  it('section_of runs to the next heading of same or higher level', () => {
    expect(section_of(md, 'setup--run')).toBe('## Setup & Run\n\ntext\n');
    expect(section_of(md, 'setup--run-1')).toContain('### Deep');
    expect(section_of(md, 'nope')).toBeNull();
  });
});

describe('checkLinks anchors', () => {
  it('warns on missing anchors (cross and same doc) without counting broken links', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anchors-'));
    try {
      await mkdir(join(dir, 'guides'), { recursive: true });
      await writeFile(join(dir, 'guides', 'a.md'), '# A\n\n[ok](b.md#target) [old](b.md#renamed) [self](#a) [bad self](#zzz)\n');
      await writeFile(join(dir, 'guides', 'b.md'), '# B\n\n## Target\n');
      const r = await check_links({ docs_root: dir, silent: true });
      expect(r.broken_links).toHaveLength(0);
      expect(r.anchor_warnings.map((w) => w.targetPath).sort()).toEqual(['#zzz', 'b.md#renamed']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('LINK_BROKEN_ANCHOR is not actionable', () => {
    expect(count_actionable_issues([{ rule: 'LINK_BROKEN_ANCHOR' }])).toBe(0);
  });
});

describe('anchor scanning matches GitHub more closely (review fixes)', () => {
  it('setext headings, blockquoted headings and combining marks get anchors; frontmatter comments do not', async () => {
    const { extract_heading_anchors: heading_anchors } = await import('../../../src/core/links/anchors');
    const md = '---\ntitle: x\n# foo\n---\n\nTag the release\n---------------\n\nIntro\n=====\n\n> ## Quoted part\n\n# foo\n\n# Café\n';
    const a = heading_anchors(md);
    expect(a.has('tag-the-release')).toBe(true);
    expect(a.has('intro')).toBe(true);
    expect(a.has('quoted-part')).toBe(true);
    expect(a.has('foo')).toBe(true);
    expect(a.has('foo-1')).toBe(false); // the YAML comment is not a heading
    expect(a.has('café')).toBe(true);
  });
});
