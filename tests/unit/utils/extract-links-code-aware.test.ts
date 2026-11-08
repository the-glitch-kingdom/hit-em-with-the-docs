import { describe, it, expect } from 'vitest';
import { extract_links } from '../../../src/utils/markdown.js';

/**
 * Link-shaped text inside a fenced block or a code span is an EXAMPLE, not a link.
 * Reporting it as broken inflates the broken-link count on docs that are correct, which
 * trains people to ignore the number.
 */
describe('extractLinks skips code', () => {
  it('ignores links inside a fenced block', () => {
    const md = [
      'Real: [a](./a.md)',
      '',
      '```markdown',
      '![img](`../assets/example.png`)',
      '[example](./not-a-real-file.md)',
      '```',
      '',
      'Also real: [b](./b.md)',
    ].join('\n');

    expect(extract_links(md).map((l) => l.url)).toEqual(['./a.md', './b.md']);
  });

  it('ignores links inside inline code spans', () => {
    const md = 'Use the `[text](./path.md)` form, e.g. [real](./real.md).';

    expect(extract_links(md).map((l) => l.url)).toEqual(['./real.md']);
  });

  it('keeps lineNumber and startIndex accurate for a real link beside a code span', () => {
    // The span is BLANKED with spaces rather than removed, so offsets still line up.
    const md = ['intro', 'see `[x](./x.md)` and [y](./y.md)'].join('\n');

    const links = extract_links(md);
    expect(links).toHaveLength(1);

    const link = links[0]!;
    expect(link.url).toBe('./y.md');
    expect(link.lineNumber).toBe(2);

    // The offset must index into the ORIGINAL line, not the blanked copy.
    const line = md.split('\n')[1]!;
    expect(line.slice(link.startIndex, link.endIndex)).toBe('[y](./y.md)');
  });

  it('handles ~~~ fences and longer backtick runs', () => {
    const md = ['~~~', '[in-tilde](./nope.md)', '~~~', '````', '[in-four](./nope2.md)', '````', '[ok](./ok.md)'].join('\n');

    expect(extract_links(md).map((l) => l.url)).toEqual(['./ok.md']);
  });
});

describe('extractLinks — indented code blocks and CommonMark fences', () => {
  // Follow-up to #22 (by @andrewcb22), whose goal — ignore links in indented
  // code — was right and is implemented here. Its rule ("any line starting with
  // four spaces is code") is not, because inside a list four columns is ordinary
  // continuation content. That would hide links that ARE broken, which is a
  // worse failure than #20's reporting of links that are not.

  const urls = (doc: string) => extract_links(doc).map((l) => l.url);

  describe('indented code blocks', () => {
    it('skips an indented code block after a blank line', () => {
      const doc = ['Real [a](./a.md)', '', '    indented code', '    [ex](./nope.md)', '', 'After [b](./b.md)'].join('\n');
      expect(urls(doc)).toEqual(['./a.md', './b.md']);
    });

    it('skips a tab-indented block', () => {
      expect(urls(['para', '', '\t[a](./nope.md)', '', 'real [b](./b.md)'].join('\n'))).toEqual(['./b.md']);
    });

    it('does NOT treat a nested list item as code', () => {
      expect(urls(['- item one', '    - nested [link](./real.md)'].join('\n'))).toEqual(['./real.md']);
    });

    it('does NOT treat list continuation content as code', () => {
      expect(urls(['1. step', '    continuation citing [another](./also.md)'].join('\n'))).toEqual([
        './also.md',
      ]);
    });

    it('does NOT treat a lazily indented paragraph line as code', () => {
      // Indented code cannot interrupt a paragraph — it needs a preceding blank line.
      expect(urls(['A paragraph', '    indented with [x](./x.md)'].join('\n'))).toEqual(['./x.md']);
    });

    it('resumes treating indentation as code once the list block ends', () => {
      const doc = ['- item', '', 'para', '', '    [code](./nope.md)', '', '[real](./r.md)'].join('\n');
      expect(urls(doc)).toEqual(['./r.md']);
    });
  });

  describe('fence delimiters', () => {
    it('closes only on a fence at least as long as the opener', () => {
      const doc = ['````', '[a](./a.md)', '```', 'still code [b](./b.md)', '````', 'real [c](./c.md)'].join('\n');
      expect(urls(doc)).toEqual(['./c.md']);
    });

    it('does not close a tilde fence with backticks', () => {
      expect(urls(['~~~', '[a](./a.md)', '```', '~~~', 'real [b](./b.md)'].join('\n'))).toEqual([
        './b.md',
      ]);
    });

    it('treats a four-column-indented ``` as code, not as a fence', () => {
      const doc = ['para', '', '    ```', '    [a](./nope.md)', '    ```', '', 'real [b](./b.md)'].join('\n');
      expect(urls(doc)).toEqual(['./b.md']);
    });
  });

  it('still preserves offsets for a real link sharing a line with a span', () => {
    const doc = 'Span `[s](./s.md)` and real [b](./b.md)';
    const link = extract_links(doc)[0]!;
    expect(doc.slice(link.startIndex, link.endIndex)).toBe('[b](./b.md)');
    expect(link.lineNumber).toBe(1);
  });
});
