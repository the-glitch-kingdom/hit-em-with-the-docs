import { basename, relative } from 'path';
import { type Domain } from './constants.js';
import {
  get_all_domains,
  get_domain_definition,
  get_all_keywords,
  is_valid_domain,
} from './registry.js';

export interface DomainDetectionResult {
  domain: Domain | null;
  confidence: number; // 0-1
  method: 'path' | 'content' | 'keywords' | 'none';
  alternative_domains: { domain: Domain; confidence: number }[];
}

/**
 * Detect domain from file path and/or content
 */
export function detect_domain(
  file_path: string,
  content?: string,
  docs_root: string = '.documentation'
): DomainDetectionResult {
  // Priority 1: Path-based detection (highest confidence)
  const path_result = detect_domain_from_path(file_path, docs_root);
  if (path_result.domain && path_result.confidence >= 0.9) {
    return path_result;
  }

  // Priority 2: Content-based detection (if provided)
  if (content) {
    const content_result = detect_domain_from_content(content);

    // If path gave a lower confidence match, compare with content
    if (path_result.domain) {
      if (content_result.confidence > path_result.confidence) {
        // Content wins but add path result as alternative
        content_result.alternative_domains.unshift({
          domain: path_result.domain,
          confidence: path_result.confidence,
        });
        return content_result;
      }
      // Path wins
      return path_result;
    }

    return content_result;
  }

  // Return path result even if low confidence
  return path_result;
}

/**
 * Detect domain from file path
 */
export function detect_domain_from_path(
  file_path: string,
  docs_root: string = '.documentation'
): DomainDetectionResult {
  const result: DomainDetectionResult = {
    domain: null,
    confidence: 0,
    method: 'path',
    alternative_domains: [],
  };

  // Normalize path separators
  const normalized_path = file_path.replace(/\\/g, '/');
  const normalized_root = docs_root.replace(/\\/g, '/');

  // Try to get relative path from docs root
  let relative_path: string;
  try {
    relative_path = relative(normalized_root, normalized_path).replace(/\\/g, '/');
  } catch {
    relative_path = normalized_path;
  }

  // Check if path contains a domain folder
  const parts = relative_path.split('/');

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part && is_valid_domain(part)) {
      result.domain = part;
      // Higher confidence if domain is early in path
      result.confidence = i === 0 ? 1.0 : 0.9 - i * 0.1;
      break;
    }
  }

  // Also check filename for domain hints
  if (!result.domain) {
    const file_name = basename(file_path, '.md');
    for (const domain of get_all_domains()) {
      if (file_name.includes(domain)) {
        result.domain = domain;
        result.confidence = 0.6;
        break;
      }
    }
  }

  return result;
}

/**
 * Detect domain from document content
 */
export function detect_domain_from_content(content: string): DomainDetectionResult {
  const result: DomainDetectionResult = {
    domain: null,
    confidence: 0,
    method: 'content',
    alternative_domains: [],
  };

  const lower_content = content.toLowerCase();
  const keyword_map = get_all_keywords();

  // Count keyword matches per domain
  const domain_scores = new Map<Domain, number>();

  for (const [keyword, domains] of keyword_map) {
    // Count occurrences of keyword
    const regex = new RegExp(`\\b${escape_regex(keyword)}\\b`, 'gi');
    const matches = lower_content.match(regex);
    if (matches) {
      const count = matches.length;
      for (const domain of domains) {
        const current = domain_scores.get(domain) ?? 0;
        domain_scores.set(domain, current + count);
      }
    }
  }

  // Sort domains by score
  const sorted_domains = [...domain_scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);

  if (sorted_domains.length > 0) {
    const max_score = sorted_domains[0]![1];
    const top_domain = sorted_domains[0]![0];

    // Calculate confidence based on score and score difference from second place
    const second_score = sorted_domains[1]?.[1] ?? 0;
    const score_diff = max_score - second_score;
    const normalized_score = Math.min(max_score / 20, 1); // Normalize to 0-1
    const score_diff_factor = Math.min(score_diff / 10, 0.3);

    result.domain = top_domain;
    result.confidence = Math.min(0.5 + normalized_score * 0.3 + score_diff_factor, 0.95);
    result.method = 'keywords';

    // Add alternatives
    for (let i = 1; i < Math.min(sorted_domains.length, 4); i++) {
      const [domain, score] = sorted_domains[i]!;
      result.alternative_domains.push({
        domain,
        confidence: (score / max_score) * result.confidence * 0.8,
      });
    }
  }

  return result;
}

/**
 * Get suggested domains for a file based on its name
 */
export function find_domains_for_file(file_name: string): Domain[] {
  const base_name = basename(file_name, '.md').toLowerCase();
  const suggestions: Domain[] = [];

  // Check each domain's keywords against the filename
  for (const domain of get_all_domains()) {
    const definition = get_domain_definition(domain);
    for (const keyword of definition.keywords) {
      if (base_name.includes(keyword.replace(/-/g, ''))) {
        if (!suggestions.includes(domain)) {
          suggestions.push(domain);
        }
        break;
      }
    }
  }

  // Also check if domain name is in filename
  for (const domain of get_all_domains()) {
    if (base_name.includes(domain) && !suggestions.includes(domain)) {
      suggestions.unshift(domain);
    }
  }

  return suggestions;
}

/**
 * Validate that a file is in the correct domain
 */
export function validate_domain_placement(
  file_path: string,
  docs_root: string = '.documentation'
): { is_correct: boolean; current_domain: Domain | null; suggested_domain: Domain | null } {
  // Get the domain from the path
  const path_result = detect_domain_from_path(file_path, docs_root);

  // Read the file content would be needed here for full validation
  // For now, just return the path-based result
  return {
    is_correct: path_result.confidence >= 0.8,
    current_domain: path_result.domain,
    suggested_domain: path_result.domain,
  };
}

/**
 * Escape special regex characters
 */
function escape_regex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
