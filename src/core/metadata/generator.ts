import { basename } from 'path';
import { detectDomain } from '../domains/detector.js';
import { classifyTier } from '../domains/classifier.js';
import { countWords, formatReadTime, extractTitle } from '../../utils/markdown.js';
import type { DocumentMetadata, PartialDocumentMetadata } from './schema.js';

export interface GeneratorOptions {
  filePath: string;
  content: string;
  docsRoot?: string;
  existingMetadata?: PartialDocumentMetadata;
}

export interface GeneratedMetadata extends Partial<DocumentMetadata> {
  _generated: {
    fields: string[];
    confidence: Record<string, number>;
  };
}

/**
 * Generate metadata for a document
 */
export function generateMetadata(options: GeneratorOptions): GeneratedMetadata {
  const {
    filePath,
    content,
    docsRoot = '.documentation',
    existingMetadata = {},
  } = options;

  const generated: GeneratedMetadata = {
    _generated: {
      fields: [],
      confidence: {},
    },
  };

  // Generate title if missing
  if (!existingMetadata.title) {
    const extractedTitle = extractTitle(content);
    const fileBasedTitle = formatTitleFromFileName(basename(filePath, '.md'));

    generated.title = extractedTitle ?? fileBasedTitle;
    generated._generated.fields.push('title');
    generated._generated.confidence['title'] = extractedTitle ? 0.9 : 0.7;
  }

  // Generate tier if missing
  if (!existingMetadata.tier) {
    const tierResult = classifyTier(content);
    generated.tier = tierResult.tier;
    generated._generated.fields.push('tier');
    generated._generated.confidence['tier'] = tierResult.confidence;
  }

  // Generate domains if missing
  if (!existingMetadata.domains || existingMetadata.domains.length === 0) {
    const domainResult = detectDomain(filePath, content, docsRoot);
    if (domainResult.domain) {
      generated.domains = [domainResult.domain];

      // Add alternative domains with high confidence
      for (const alt of domainResult.alternativeDomains) {
        if (alt.confidence > 0.5 && generated.domains.length < 3) {
          generated.domains.push(alt.domain);
        }
      }

      generated._generated.fields.push('domains');
      generated._generated.confidence['domains'] = domainResult.confidence;
    }
  }

  // Generate audience if missing
  if (!existingMetadata.audience || existingMetadata.audience.length === 0) {
    generated.audience = detectAudience(content);
    generated._generated.fields.push('audience');
    generated._generated.confidence['audience'] = 0.7;
  }

  // Generate tags if missing
  if (!existingMetadata.tags || existingMetadata.tags.length === 0) {
    generated.tags = extractTags(content);
    generated._generated.fields.push('tags');
    generated._generated.confidence['tags'] = 0.6;
  }

  // Generate status (default to draft for new docs)
  if (!existingMetadata.status) {
    generated.status = 'draft';
    generated._generated.fields.push('status');
    generated._generated.confidence['status'] = 1.0;
  }

  // Generate last_updated
  if (!existingMetadata.last_updated) {
    generated.last_updated = formatDate(new Date());
    generated._generated.fields.push('last_updated');
    generated._generated.confidence['last_updated'] = 1.0;
  }

  // Generate version
  if (!existingMetadata.version) {
    generated.version = '1.0.0';
    generated._generated.fields.push('version');
    generated._generated.confidence['version'] = 1.0;
  }

  // Generate word_count (always regenerate)
  generated.word_count = countWords(content);
  generated._generated.fields.push('word_count');
  generated._generated.confidence['word_count'] = 1.0;

  // Generate estimated_read_time (always regenerate)
  generated.estimated_read_time = formatReadTime(content);
  generated._generated.fields.push('estimated_read_time');
  generated._generated.confidence['estimated_read_time'] = 1.0;

  // Generate last_validated
  generated.last_validated = formatDate(new Date());
  generated._generated.fields.push('last_validated');
  generated._generated.confidence['last_validated'] = 1.0;

  // Generate purpose if missing
  if (!existingMetadata.purpose) {
    const purpose = generatePurpose(content);
    if (purpose) {
      generated.purpose = purpose;
      generated._generated.fields.push('purpose');
      generated._generated.confidence['purpose'] = 0.6;
    }
  }

  return generated;
}

/**
 * Merge generated metadata with existing metadata
 */
export function mergeMetadata(
  existing: PartialDocumentMetadata,
  generated: GeneratedMetadata
): DocumentMetadata {
  const { _generated, ...generatedFields } = generated;

  return {
    // Core Identity
    title: existing.title ?? generatedFields.title ?? 'Untitled',
    tier: existing.tier ?? generatedFields.tier ?? 'guide',
    domains: existing.domains ?? generatedFields.domains ?? ['features'],
    audience: existing.audience ?? generatedFields.audience ?? ['all'],
    tags: existing.tags ?? generatedFields.tags ?? [],

    // Status & Lifecycle
    status: existing.status ?? generatedFields.status ?? 'draft',
    last_updated: existing.last_updated ?? generatedFields.last_updated ?? formatDate(new Date()),
    version: existing.version ?? generatedFields.version ?? '1.0.0',

    // Discovery & Navigation
    purpose: existing.purpose ?? generatedFields.purpose,
    related_docs: existing.related_docs ?? generatedFields.related_docs,
    load_priority: existing.load_priority ?? generatedFields.load_priority,

    // Ownership & Maintenance
    author: existing.author ?? generatedFields.author,
    maintainer: existing.maintainer ?? generatedFields.maintainer,
    review_frequency: existing.review_frequency ?? generatedFields.review_frequency,

    // Implementation
    implementation_status: existing.implementation_status ?? generatedFields.implementation_status,
    tested: existing.tested ?? generatedFields.tested,
    production_ready: existing.production_ready ?? generatedFields.production_ready,

    // Auto-generated (always use generated values)
    estimated_read_time: generatedFields.estimated_read_time,
    word_count: generatedFields.word_count,
    last_validated: generatedFields.last_validated,
    backlinks: existing.backlinks ?? [],
  };
}

/**
 * Format a date as YYYY-MM-DD
 */
export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0] ?? '';
}

/**
 * Format a title from file name
 */
function formatTitleFromFileName(fileName: string): string {
  return fileName
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Detect target audience from content
 */
function detectAudience(content: string): Array<'all' | 'developers' | 'devops' | 'admin'> {
  const lower = content.toLowerCase();
  const audiences: Array<'all' | 'developers' | 'devops' | 'admin'> = [];

  if (lower.includes('developer') || lower.includes('coding') || lower.includes('api')) {
    audiences.push('developers');
  }

  if (lower.includes('devops') || lower.includes('deploy') || lower.includes('infrastructure')) {
    audiences.push('devops');
  }

  if (lower.includes('admin') || lower.includes('configuration') || lower.includes('management')) {
    audiences.push('admin');
  }

  return audiences.length > 0 ? audiences : ['all'];
}

/**
 * Extract tags from content using keyword frequency
 */
function extractTags(content: string): string[] {
  const lower = content.toLowerCase();
  const tags: string[] = [];

  // Common technical keywords to look for
  const keywords = [
    'api', 'rest', 'graphql', 'database', 'postgres', 'mysql', 'redis',
    'docker', 'kubernetes', 'aws', 'gcp', 'azure', 'ci/cd', 'testing',
    'security', 'authentication', 'authorization', 'oauth', 'jwt',
    'react', 'vue', 'angular', 'node', 'python', 'typescript', 'javascript',
    'fastapi', 'express', 'django', 'flask', 'nextjs', 'migration',
    'deployment', 'monitoring', 'logging', 'caching', 'performance',
  ];

  for (const keyword of keywords) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
    const matches = lower.match(regex);
    if (matches && matches.length >= 2) {
      tags.push(keyword);
    }
  }

  // Limit to top 10 tags
  return tags.slice(0, 10);
}

/**
 * Generate a one-sentence purpose from content
 */
function generatePurpose(content: string): string | undefined {
  // Try to extract from first paragraph
  const paragraphs = content
    .replace(/^---[\s\S]*?---\n*/m, '') // Remove frontmatter
    .replace(/^#+\s+.*$/gm, '') // Remove headings
    .split(/\n\n+/)
    .filter((p) => p.trim().length > 0);

  const firstParagraph = paragraphs[0];
  if (firstParagraph && firstParagraph.length > 20 && firstParagraph.length < 200) {
    // Clean up the paragraph
    const cleaned = firstParagraph
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // If it looks like a good purpose statement, use it
    if (!cleaned.startsWith('```') && !cleaned.startsWith('|') && !cleaned.startsWith('-')) {
      return cleaned;
    }
  }

  // No usable first paragraph: leave purpose missing so the audit flags it
  // (a title echo is noise for retrieval).
  return undefined;
}
