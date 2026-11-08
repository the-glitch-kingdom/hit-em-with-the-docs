import { describe, it, expect } from 'vitest';
import {
  generate_metadata,
  merge_metadata,
  format_date,
} from '../../../src/core/metadata/generator.js';

describe('Metadata Generator', () => {
  describe('formatDate', () => {
    it('should format date as YYYY-MM-DD', () => {
      const date = new Date('2025-06-15T12:00:00Z');
      expect(format_date(date)).toBe('2025-06-15');
    });

    it('should handle current date', () => {
      const result = format_date(new Date());
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('generateMetadata', () => {
    it.each([
      ['code block', '```bash\nnpm install something-long-enough-here\n```'],
      ['table', '| a | b | c | d |\n| - | - | - | - |\n| 1 | 2 | 3 | 4 |'],
      ['list', '- first item of a long enough list entry\n- second item'],
      ['long paragraph', 'word '.repeat(60)],
    ])('omits purpose (no title echo) when first paragraph is a %s', (_n, first) => {
      const result = generate_metadata({
        content: `# Some Title\n\n${first}\n\n## More\n\nText.\n`,
        file_path: 'docs/some-title.md',
      });
      expect(result.purpose).toBeUndefined();
    });

    it('should generate metadata with title from content', () => {
      const content = `
# Getting Started Guide

This is a quick start guide for the project.

## Prerequisites

- Node.js installed
`;
      const result = generate_metadata({
        file_path: '.documentation/quickstart/getting-started.md',
        content,
      });

      expect(result.title).toBe('Getting Started Guide');
      expect(result._generated.fields).toContain('title');
    });

    it('should generate title from filename if no H1', () => {
      const content = `Some content without a heading.`;
      const result = generate_metadata({
        file_path: '.documentation/security/auth-setup-guide.md',
        content,
      });

      expect(result.title).toBe('Auth Setup Guide');
    });

    it('should generate tier from content structure', () => {
      const guide_content = `
# How to Setup Authentication

## Step 1: Install dependencies
## Step 2: Configure settings
## Step 3: Test the setup
`;
      const result = generate_metadata({
        file_path: '.documentation/security/auth-setup.md',
        content: guide_content,
      });

      expect(result.tier).toBeDefined();
      expect(result._generated.fields).toContain('tier');
    });

    it('should generate domains from file path', () => {
      const content = '# Test Document\n\nContent here.';
      const result = generate_metadata({
        file_path: '.documentation/security/test-doc.md',
        content,
      });

      expect(result.domains).toContain('security');
    });

    it('should generate status as draft for new documents', () => {
      const result = generate_metadata({
        file_path: 'test.md',
        content: '# Test\n\nContent',
      });

      expect(result.status).toBe('draft');
    });

    it('should generate version as 1.0.0 for new documents', () => {
      const result = generate_metadata({
        file_path: 'test.md',
        content: '# Test\n\nContent',
      });

      expect(result.version).toBe('1.0.0');
    });

    it('should set last_updated to current date', () => {
      const result = generate_metadata({
        file_path: 'test.md',
        content: '# Test\n\nContent',
      });

      const date_regex = /^\d{4}-\d{2}-\d{2}$/;
      expect(result.last_updated).toMatch(date_regex);
    });

    it('should generate word_count', () => {
      const content = '# Test\n\nThis is a simple test with some words.';
      const result = generate_metadata({
        file_path: 'test.md',
        content,
      });

      expect(result.word_count).toBeGreaterThan(0);
    });

    it('should not override existing metadata', () => {
      const result = generate_metadata({
        file_path: 'test.md',
        content: '# Test\n\nContent',
        existing_metadata: {
          title: 'Existing Title',
          tier: 'reference',
        },
      });

      // Should not generate title since it exists
      expect(result._generated.fields).not.toContain('title');
      expect(result._generated.fields).not.toContain('tier');
    });
  });

  describe('mergeMetadata', () => {
    it('should merge existing and generated metadata', () => {
      const existing = {
        title: 'Existing Title',
        author: 'John Doe',
      };

      const generated = generate_metadata({
        file_path: '.documentation/security/test.md',
        content: '# Test\n\nContent',
        existing_metadata: existing,
      });

      const merged = merge_metadata(existing, generated);

      expect(merged.title).toBe('Existing Title');
      expect(merged.author).toBe('John Doe');
      expect(merged.status).toBe('draft');
      expect(merged.version).toBe('1.0.0');
    });

    it('should use generated values for missing fields', () => {
      const merged = merge_metadata(
        {},
        generate_metadata({
          file_path: 'test.md',
          content: '# Test\n\nContent',
        })
      );

      expect(merged.title).toBe('Test');
      expect(merged.status).toBe('draft');
      expect(merged.version).toBe('1.0.0');
    });

    it('should always use generated auto-fields', () => {
      const merged = merge_metadata(
        { word_count: 999 },
        generate_metadata({
          file_path: 'test.md',
          content: '# Test\n\nA few words here.',
        })
      );

      // word_count should be regenerated, not use existing
      expect(merged.word_count).not.toBe(999);
    });
  });
});

describe('mergeMetadata keeps unmodelled keys', () => {
  it('preserves kind, generated and other extra frontmatter keys', () => {
    const existing = { title: 'T', kind: 'overview', generated: true, symptoms: ['x'] } as never;
    const merged = merge_metadata(existing, { _generated: true } as never) as unknown as Record<string, unknown>;
    expect(merged.kind).toBe('overview');
    expect(merged.generated).toBe(true);
    expect(merged.symptoms).toEqual(['x']);
    expect(merged.title).toBe('T');
  });
});
