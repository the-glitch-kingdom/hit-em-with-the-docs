import { describe, it, expect } from 'vitest';
import matter from 'gray-matter';
import { generateDocumentTemplate } from '../../../src/generators/templates/document.js';

describe('generateDocumentTemplate retrieval fields', () => {
  it('emits commented guidance and leaves purpose missing by default', () => {
    const data = matter(generateDocumentTemplate({ title: 'T' })).data;
    expect(data.purpose).toBeUndefined();
    expect(data.symptoms).toBeUndefined();
    expect(generateDocumentTemplate({ title: 'T' })).toContain('# purpose:');
  });

  it('writes purpose when given', () => {
    const data = matter(generateDocumentTemplate({ title: 'T', purpose: 'How do I "x"?' })).data;
    expect(data.purpose).toBe('How do I "x"?');
  });
});
