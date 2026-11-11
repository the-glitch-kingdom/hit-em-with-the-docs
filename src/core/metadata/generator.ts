import { basename } from 'path';
import { detect_domain } from '../domains/detector.js';
import { classify_tier } from '../domains/classifier.js';
import { count_words, format_read_time, extract_title } from '../../utils/markdown.js';
import type { DocumentMetadata, PartialDocumentMetadata } from './schema.js';

export interface GeneratorOptions {
  file_path: string;
  content: string;
  docs_root?: string;
  existing_metadata?: PartialDocumentMetadata;
  /** Copy the first paragraph into a missing `purpose` (default true). `integrate` passes false: a purpose is the question the doc answers, not its opening line (#98). */
  infer_purpose?: boolean;
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
export function generate_metadata(options: GeneratorOptions): GeneratedMetadata {
  const {
    file_path,
    content,
    docs_root = '.documentation',
    existing_metadata = {},
    infer_purpose = true,
  } = options;

  const generated: GeneratedMetadata = {
    _generated: {
      fields: [],
      confidence: {},
    },
  };

  // Generate title if missing
  if (!existing_metadata.title) {
    const extracted_title = extract_title(content);
    const file_based_title = format_title_from_file_name(basename(file_path, '.md'));

    generated.title = extracted_title ?? file_based_title;
    generated._generated.fields.push('title');
    generated._generated.confidence['title'] = extracted_title ? 0.9 : 0.7;
  }

  // Generate tier if missing
  if (!existing_metadata.tier) {
    const tier_result = classify_tier(content);
    generated.tier = tier_result.tier;
    generated._generated.fields.push('tier');
    generated._generated.confidence['tier'] = tier_result.confidence;
  }

  // Generate domains if missing
  if (!existing_metadata.domains || existing_metadata.domains.length === 0) {
    const domain_result = detect_domain(file_path, content, docs_root);
    if (domain_result.domain) {
      generated.domains = [domain_result.domain];

      // Add alternative domains with high confidence
      for (const alt of domain_result.alternative_domains) {
        if (alt.confidence > 0.5 && generated.domains.length < 3) {
          generated.domains.push(alt.domain);
        }
      }

      generated._generated.fields.push('domains');
      generated._generated.confidence['domains'] = domain_result.confidence;
    }
  }

  // Generate audience if missing
  if (!existing_metadata.audience || existing_metadata.audience.length === 0) {
    generated.audience = detect_audience(content);
    generated._generated.fields.push('audience');
    generated._generated.confidence['audience'] = 0.7;
  }

  // Generate tags if missing
  if (!existing_metadata.tags || existing_metadata.tags.length === 0) {
    generated.tags = extract_tags(content);
    generated._generated.fields.push('tags');
    generated._generated.confidence['tags'] = 0.6;
  }

  // Generate status (default to draft for new docs)
  if (!existing_metadata.status) {
    generated.status = 'draft';
    generated._generated.fields.push('status');
    generated._generated.confidence['status'] = 1.0;
  }

  // Generate last_updated
  if (!existing_metadata.last_updated) {
    generated.last_updated = format_date(new Date());
    generated._generated.fields.push('last_updated');
    generated._generated.confidence['last_updated'] = 1.0;
  }

  // Generate version
  if (!existing_metadata.version) {
    generated.version = '1.0.0';
    generated._generated.fields.push('version');
    generated._generated.confidence['version'] = 1.0;
  }

  // Generate word_count (always regenerate)
  generated.word_count = count_words(content);
  generated._generated.fields.push('word_count');
  generated._generated.confidence['word_count'] = 1.0;

  // Generate estimated_read_time (always regenerate)
  generated.estimated_read_time = format_read_time(content);
  generated._generated.fields.push('estimated_read_time');
  generated._generated.confidence['estimated_read_time'] = 1.0;

  // Generate last_validated
  generated.last_validated = format_date(new Date());
  generated._generated.fields.push('last_validated');
  generated._generated.confidence['last_validated'] = 1.0;

  // Generate purpose if missing
  if (infer_purpose && !existing_metadata.purpose) {
    const purpose = generate_purpose(content);
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
export function merge_metadata(
  existing: PartialDocumentMetadata,
  generated: GeneratedMetadata
): DocumentMetadata {
  const { _generated, ...generated_fields } = generated;

  return {
    // Keep keys the schema does not model (kind, generated, symptoms, ...): dropping them corrupted docs on --fix.
    ...existing,

    // Core Identity
    title: existing.title ?? generated_fields.title ?? 'Untitled',
    tier: existing.tier ?? generated_fields.tier ?? 'guide',
    domains: existing.domains ?? generated_fields.domains ?? ['features'],
    audience: existing.audience ?? generated_fields.audience ?? ['all'],
    tags: existing.tags ?? generated_fields.tags ?? [],

    // Status & Lifecycle
    status: existing.status ?? generated_fields.status ?? 'draft',
    last_updated: existing.last_updated ?? generated_fields.last_updated ?? format_date(new Date()),
    version: existing.version ?? generated_fields.version ?? '1.0.0',

    // Discovery & Navigation
    purpose: existing.purpose ?? generated_fields.purpose,
    related_docs: existing.related_docs ?? generated_fields.related_docs,
    load_priority: existing.load_priority ?? generated_fields.load_priority,

    // Ownership & Maintenance
    author: existing.author ?? generated_fields.author,
    maintainer: existing.maintainer ?? generated_fields.maintainer,
    review_frequency: existing.review_frequency ?? generated_fields.review_frequency,

    // Implementation
    implementation_status: existing.implementation_status ?? generated_fields.implementation_status,
    tested: existing.tested ?? generated_fields.tested,
    production_ready: existing.production_ready ?? generated_fields.production_ready,

    // Auto-generated (always use generated values)
    estimated_read_time: generated_fields.estimated_read_time,
    word_count: generated_fields.word_count,
    last_validated: generated_fields.last_validated,
    backlinks: existing.backlinks ?? [],
  };
}

/**
 * Format a date as YYYY-MM-DD
 */
export function format_date(date: Date): string {
  return date.toISOString().split('T')[0] ?? '';
}

/**
 * Format a title from file name
 */
function format_title_from_file_name(file_name: string): string {
  return file_name
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Detect target audience from content
 */
function detect_audience(content: string): Array<'all' | 'developers' | 'devops' | 'admin'> {
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
function extract_tags(content: string): string[] {
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
function generate_purpose(content: string): string | undefined {
  // Try to extract from first paragraph
  const paragraphs = content
    .replace(/^---[\s\S]*?---\n*/m, '') // Remove frontmatter
    .replace(/^#+\s+.*$/gm, '') // Remove headings
    .split(/\n\n+/)
    .filter((paragraph) => paragraph.trim().length > 0);

  const first_paragraph = paragraphs[0];
  if (first_paragraph && first_paragraph.length > 20 && first_paragraph.length < 200) {
    // Clean up the paragraph
    const cleaned = first_paragraph
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
