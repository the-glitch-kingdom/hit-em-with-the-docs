import { basename, relative } from 'path';
import { detect_domain_from_path } from '../domains/detector.js';
import { is_valid_domain } from '../domains/registry.js';
import { ARCHIVE_DIR } from '../../utils/glob.js';

export interface AuditRule {
  id: string;
  name: string;
  description: string;
  severity: 'error' | 'warning' | 'info';
  check: (file_path: string, docs_path: string) => RuleCheckResult;
}

export interface RuleCheckResult {
  valid: boolean;
  message?: string;
  suggestion?: string;
}

/**
 * Check if file name follows naming convention (kebab-case)
 */
export function check_naming_convention(file_path: string): RuleCheckResult {
  const file_name = basename(file_path, '.md');

  // Allow special files
  if (['INDEX', 'REGISTRY', 'README', 'CHANGELOG', 'CONTRIBUTING'].includes(file_name)) {
    return { valid: true };
  }

  // Check for kebab-case
  const kebab_case_regex = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

  if (!kebab_case_regex.test(file_name)) {
    // Determine what's wrong
    const issues: string[] = [];

    if (/[A-Z]/.test(file_name)) {
      issues.push('contains uppercase letters');
    }
    if (/_/.test(file_name)) {
      issues.push('contains underscores');
    }
    if (/\s/.test(file_name)) {
      issues.push('contains spaces');
    }
    if (/^[0-9]/.test(file_name)) {
      issues.push('starts with a number');
    }
    if (/--/.test(file_name)) {
      issues.push('contains consecutive hyphens');
    }

    const suggestion = file_name
      .toLowerCase()
      .replace(/[_\s]+/g, '-')
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/--+/g, '-')
      .replace(/^-|-$/g, '');

    return {
      valid: false,
      message: `File name ${issues.join(', ')}`,
      suggestion: `Rename to: ${suggestion}.md`,
    };
  }

  return { valid: true };
}

/**
 * Check if file is in the correct domain folder
 */
export function check_file_placement(
  file_path: string,
  docs_path: string,
  declared_domain?: string
): RuleCheckResult {
  const detected_result = detect_domain_from_path(file_path, docs_path);
  const detected_domain = detected_result.domain;

  // If no domain detected from path, and no domain declared, it's an issue
  if (!detected_domain && !declared_domain) {
    return {
      valid: false,
      message: 'File is not in a domain folder',
      suggestion: 'Move file to appropriate domain folder (e.g., security/, api/, etc.)',
    };
  }

  // If domain is declared but file is in different folder
  if (declared_domain && detected_domain && declared_domain !== detected_domain) {
    return {
      valid: false,
      message: `File declares domain '${declared_domain}' but is in '${detected_domain}/' folder`,
      suggestion: `Move to ${declared_domain}/ or update domains in frontmatter`,
    };
  }

  // If file is in root (not in any domain folder)
  if (!detected_domain) {
    const rel = relative(docs_path, file_path);
    const path_parts = rel.split(/[/\\]/);

    // Check if it's in root
    if (path_parts.length === 1) {
      return {
        valid: false,
        message: 'File is in documentation root, not in a domain folder',
        suggestion: declared_domain
          ? `Move to ${declared_domain}/`
          : 'Move file to appropriate domain folder',
      };
    }

    // Check if it's in an unknown folder
    const folder = path_parts[0];
    if (folder && !is_valid_domain(folder) && !['drafts', 'reports', ARCHIVE_DIR].includes(folder)) {
      return {
        valid: false,
        message: `File is in unknown folder '${folder}'`,
        suggestion: 'Move to a standard domain folder or add as custom domain',
      };
    }
  }

  return { valid: true };
}

/**
 * Check file size is within acceptable range
 */
export function check_file_size(
  _file_path: string,
  file_size: number,
  tier?: string
): RuleCheckResult {
  const size_kb = file_size / 1024;

  // Size limits by tier
  const limits: Record<string, { min: number; max: number }> = {
    guide: { min: 1, max: 50 },
    standard: { min: 1, max: 30 },
    example: { min: 0.5, max: 20 },
    reference: { min: 5, max: 100 },
    admin: { min: 1, max: 40 },
  };

  const limit = tier && limits[tier] ? limits[tier] : { min: 0.5, max: 100 };

  if (size_kb < limit.min) {
    return {
      valid: false,
      message: `File is very small (${size_kb.toFixed(1)} KB)`,
      suggestion: 'Consider adding more content or merging with related document',
    };
  }

  if (size_kb > limit.max) {
    return {
      valid: false,
      message: `File is very large (${size_kb.toFixed(1)} KB)`,
      suggestion: 'Consider splitting into multiple documents',
    };
  }

  return { valid: true };
}

/**
 * Check for required sections based on tier
 */
export function check_required_sections(
  content: string,
  tier?: string
): RuleCheckResult {
  const required_sections: Record<string, string[]> = {
    guide: ['overview', 'prerequisites', 'steps'],
    standard: ['rules', 'examples'],
    example: ['code', 'explanation'],
    reference: ['api', 'parameters'],
    admin: ['configuration', 'procedures'],
  };

  if (!tier || !required_sections[tier]) {
    return { valid: true };
  }

  const lower_content = content.toLowerCase();
  const sections = required_sections[tier]!;
  const missing_sections: string[] = [];

  for (const section of sections) {
    // Check for heading containing the section name
    const patterns = [
      new RegExp(`^#+\\s*${section}`, 'mi'),
      new RegExp(`^#+\\s*.*${section}`, 'mi'),
    ];

    const found = patterns.some((p) => p.test(lower_content));
    if (!found) {
      missing_sections.push(section);
    }
  }

  if (missing_sections.length > 0) {
    return {
      valid: false,
      message: `Missing recommended sections for ${tier}: ${missing_sections.join(', ')}`,
      suggestion: `Consider adding sections: ${missing_sections.map((s) => `## ${capitalize(s)}`).join(', ')}`,
    };
  }

  return { valid: true };
}

/**
 * Check for broken relative links within content
 */
export function check_relative_links(
  content: string,
  _file_path: string
): RuleCheckResult {
  // Extract markdown links
  const link_regex = /\[([^\]]*)\]\(([^)]+)\)/g;
  const suspicious_links: string[] = [];

  let match;
  while ((match = link_regex.exec(content)) !== null) {
    const url = match[2] ?? '';

    // Check for common issues in relative links
    if (url.startsWith('/') && !url.startsWith('/http')) {
      // Absolute path from docs root - might be wrong
      if (url.includes('..')) {
        suspicious_links.push(url);
      }
    }

    // Check for Windows-style paths
    if (url.includes('\\')) {
      suspicious_links.push(url);
    }

    // Check for links with spaces not encoded
    if (url.includes(' ') && !url.includes('%20')) {
      suspicious_links.push(url);
    }
  }

  if (suspicious_links.length > 0) {
    return {
      valid: false,
      message: `Found ${suspicious_links.length} suspicious links`,
      suggestion: 'Review and fix link paths',
    };
  }

  return { valid: true };
}

/**
 * Capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * All built-in audit rules
 */
export const AUDIT_RULES: AuditRule[] = [
  {
    id: 'naming-convention',
    name: 'Naming Convention',
    description: 'Check if file names follow kebab-case convention',
    severity: 'warning',
    check: (file_path) => check_naming_convention(file_path),
  },
  {
    id: 'placement',
    name: 'File Placement',
    description: 'Check if files are in the correct domain folders',
    severity: 'warning',
    check: (file_path, docs_path) => check_file_placement(file_path, docs_path),
  },
];
