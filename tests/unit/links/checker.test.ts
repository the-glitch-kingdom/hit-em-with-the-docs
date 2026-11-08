import { describe, it, expect } from 'vitest';
import {
  extract_links,
  extract_internal_links,
  extract_headings,
  extract_title,
  count_words,
  compute_read_time,
} from '../../../src/utils/markdown.js';

describe('Markdown Link Utilities', () => {
  describe('extractLinks', () => {
    it('should extract markdown links', () => {
      const content = `
# Document

See [another doc](./other-doc.md) for details.
Also check [external](https://example.com).
`;
      const links = extract_links(content);
      expect(links).toHaveLength(2);
    });

    it('should extract link with line numbers', () => {
      const content = `Line 1
Line 2
[Link](./path.md)
Line 4`;
      const links = extract_links(content);
      expect(links[0]?.line_number).toBe(3);
    });

    it('should extract multiple links on same line', () => {
      const content = 'See [one](./one.md) and [two](./two.md) here.';
      const links = extract_links(content);
      expect(links).toHaveLength(2);
    });

    it('should identify internal vs external links', () => {
      const content = `
[internal](./doc.md)
[external](https://example.com)
`;
      const links = extract_links(content);
      expect(links[0]?.is_internal).toBe(true);
      expect(links[1]?.is_internal).toBe(false);
    });

    it('should extract link text and url', () => {
      const content = '[My Link Text](./path/to/doc.md)';
      const links = extract_links(content);
      expect(links[0]?.text).toBe('My Link Text');
      expect(links[0]?.url).toBe('./path/to/doc.md');
    });
  });

  describe('extractInternalLinks', () => {
    it('should only return internal links', () => {
      const content = `
[internal1](./doc1.md)
[external](https://example.com)
[internal2](../doc2.md)
`;
      const links = extract_internal_links(content);
      expect(links).toHaveLength(2);
      expect(links.every(l => l.is_internal)).toBe(true);
    });
  });

  describe('extractHeadings', () => {
    it('should extract all headings', () => {
      const content = `
# Title

## Section 1

### Subsection

## Section 2
`;
      const headings = extract_headings(content);
      expect(headings).toHaveLength(4);
    });

    it('should include heading level and text', () => {
      const content = `
# Main Title

## Section
`;
      const headings = extract_headings(content);
      expect(headings[0]?.level).toBe(1);
      expect(headings[0]?.text).toBe('Main Title');
      expect(headings[1]?.level).toBe(2);
    });
  });

  describe('extractTitle', () => {
    it('should extract title from H1 heading', () => {
      const content = '# My Document Title\n\nSome content here.';
      const title = extract_title(content);
      expect(title).toBe('My Document Title');
    });

    it('should return null if no H1 found', () => {
      const content = '## Second Level Heading\n\nNo H1 here.';
      const title = extract_title(content);
      expect(title).toBeNull();
    });

    it('should extract first H1 only', () => {
      const content = '# First Title\n\n# Second Title';
      const title = extract_title(content);
      expect(title).toBe('First Title');
    });
  });

  describe('countWords', () => {
    it('should count words correctly', () => {
      const content = 'This is a simple sentence with eight words here.';
      const count = count_words(content);
      expect(count).toBe(9);
    });

    it('should exclude code blocks', () => {
      const content = `
Some text here.

\`\`\`javascript
const x = 1;
const y = 2;
\`\`\`

More text here.
`;
      const count = count_words(content);
      // Code block should be excluded
      expect(count).toBeLessThan(20);
    });

    it('should handle empty content', () => {
      const count = count_words('');
      expect(count).toBe(0);
    });
  });

  describe('calculateReadTime', () => {
    it('should calculate read time based on content', () => {
      // Create content with ~400 words
      const words = Array(400).fill('word').join(' ');
      const content = `# Title\n\n${words}`;
      const read_time = compute_read_time(content);
      // Should be approximately 2-3 minutes at 200 wpm (rounds up)
      expect(read_time).toBeGreaterThanOrEqual(2);
      expect(read_time).toBeLessThanOrEqual(3);
    });

    it('should return minimum 1 minute', () => {
      const content = 'Just a few words.';
      const read_time = compute_read_time(content);
      expect(read_time).toBe(1);
    });
  });
});
