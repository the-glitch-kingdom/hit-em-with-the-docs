import { readFile } from 'fs/promises';
import { relative } from 'path';
import { glob } from '../../utils/glob.js';
import { logger } from '../../utils/logger.js';

export interface AntiPatternDiscoveryOptions {
  root_path: string;
  silent?: boolean;
}

export interface DiscoveredAntiPattern {
  name: string;
  severity: 'high' | 'medium' | 'low';
  type: AntiPatternType;
  description: string;
  locations: AntiPatternLocation[];
  recommendation: string;
}

export interface AntiPatternLocation {
  file: string;
  line: number;
  code: string;
  context?: string;
}

export type AntiPatternType =
  | 'hardcoded-credentials'
  | 'sql-injection'
  | 'missing-error-handling'
  | 'code-duplication'
  | 'god-object'
  | 'long-function'
  | 'magic-numbers'
  | 'missing-types'
  | 'console-log'
  | 'any-type'
  | 'unused-import'
  | 'deprecated-api';

interface AntiPatternDefinition {
  name: string;
  type: AntiPatternType;
  severity: 'high' | 'medium' | 'low';
  description: string;
  patterns: RegExp[];
  recommendation: string;
  exclude?: RegExp[];
}

const ANTI_PATTERN_DEFINITIONS: AntiPatternDefinition[] = [
  // High severity
  {
    name: 'Hardcoded Credentials',
    type: 'hardcoded-credentials',
    severity: 'high',
    description: 'Sensitive credentials hardcoded in source code',
    patterns: [
      /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]+['"]/gi,
      /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]+['"]/gi,
      /(?:secret|token)\s*[:=]\s*['"][a-zA-Z0-9]{20,}['"]/gi,
      /(?:auth|bearer)\s*[:=]\s*['"][^'"]+['"]/gi,
    ],
    recommendation: 'Move credentials to environment variables or a secrets manager',
    exclude: [/\.test\.|\.spec\.|mock|fixture|example/i],
  },
  {
    name: 'Potential SQL Injection',
    type: 'sql-injection',
    severity: 'high',
    description: 'String interpolation in SQL queries',
    patterns: [
      /`SELECT\s+.+\$\{/gi,
      /`INSERT\s+.+\$\{/gi,
      /`UPDATE\s+.+\$\{/gi,
      /`DELETE\s+.+\$\{/gi,
      /['"]SELECT\s+.+['"]\s*\+/gi,
    ],
    recommendation: 'Use parameterized queries or prepared statements',
  },
  {
    name: 'Missing Error Handling',
    type: 'missing-error-handling',
    severity: 'high',
    description: 'Async operations without try-catch or .catch()',
    patterns: [
      /await\s+[^;]+;(?!\s*}\s*catch)/g,
    ],
    recommendation: 'Wrap async operations in try-catch blocks',
  },

  // Medium severity
  {
    name: 'Console.log in Production Code',
    type: 'console-log',
    severity: 'medium',
    description: 'Debug console statements left in code',
    patterns: [
      /console\.log\s*\(/g,
      /console\.debug\s*\(/g,
      /console\.info\s*\(/g,
    ],
    recommendation: 'Remove console statements or use a proper logging library',
    exclude: [/\.test\.|\.spec\./i],
  },
  {
    name: 'TypeScript "any" Type',
    type: 'any-type',
    severity: 'medium',
    description: 'Using "any" type defeats TypeScript benefits',
    patterns: [
      /:\s*any\s*[;,)=]/g,
      /as\s+any/g,
      /<any>/g,
    ],
    recommendation: 'Use proper types or "unknown" with type guards',
  },
  {
    name: 'Magic Numbers',
    type: 'magic-numbers',
    severity: 'medium',
    description: 'Unexplained numeric literals in code',
    patterns: [
      /(?:if|while|for).*[<>=]+\s*\d{2,}/g,
      /setTimeout\s*\([^,]+,\s*\d{4,}\)/g,
      /setInterval\s*\([^,]+,\s*\d{4,}\)/g,
    ],
    recommendation: 'Extract to named constants with descriptive names',
    exclude: [/\b(?:0|1|2|100|1000)\b/],
  },
  {
    name: 'Long Function',
    type: 'long-function',
    severity: 'medium',
    description: 'Functions exceeding recommended length',
    patterns: [
      // This is detected differently - by line count
    ],
    recommendation: 'Break down into smaller, focused functions',
  },

  // Low severity
  {
    name: 'Unused Imports',
    type: 'unused-import',
    severity: 'low',
    description: 'Imported modules that are not used',
    patterns: [
      // This requires more complex analysis
    ],
    recommendation: 'Remove unused imports to reduce bundle size',
  },
  {
    name: 'Deprecated API Usage',
    type: 'deprecated-api',
    severity: 'low',
    description: 'Using deprecated methods or APIs',
    patterns: [
      /@deprecated/gi,
      /\.substr\s*\(/g, // Use slice instead
      /new\s+Buffer\s*\(/g, // Use Buffer.from()
    ],
    recommendation: 'Update to use current API versions',
  },
];

/**
 * Discover anti-patterns in codebase
 */
export async function discover_anti_patterns(
  options: AntiPatternDiscoveryOptions
): Promise<DiscoveredAntiPattern[]> {
  const { root_path, silent = false } = options;

  const discovered: DiscoveredAntiPattern[] = [];

  if (!silent) {
    logger.header('Anti-Pattern Discovery');
    logger.info(`Scanning: ${root_path}`);
  }

  // Find all source files
  const patterns = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'];
  let files: string[] = [];

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: root_path,
      absolute: true,
      ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**'],
    });
    files.push(...matches);
  }

  files = [...new Set(files)];

  if (!silent) {
    logger.info(`Scanning ${files.length} files...`);
  }

  // Check for each anti-pattern
  for (const definition of ANTI_PATTERN_DEFINITIONS) {
    if (definition.patterns.length === 0) continue;

    const anti_pattern = await scan_for_anti_pattern(files, root_path, definition);
    if (anti_pattern.locations.length > 0) {
      discovered.push(anti_pattern);
    }
  }

  // Check for long functions
  const long_functions = await find_long_functions(files, root_path);
  if (long_functions.locations.length > 0) {
    discovered.push(long_functions);
  }

  // Check for god objects
  const god_objects = await find_god_objects(files, root_path);
  if (god_objects.locations.length > 0) {
    discovered.push(god_objects);
  }

  // Sort by severity
  const severity_order = { high: 0, medium: 1, low: 2 };
  discovered.sort((a, b) => severity_order[a.severity] - severity_order[b.severity]);

  if (!silent) {
    logger.newline();
    logger.success(`Found ${discovered.length} anti-pattern types`);

    const high = discovered.filter((d) => d.severity === 'high');
    const medium = discovered.filter((d) => d.severity === 'medium');
    const low = discovered.filter((d) => d.severity === 'low');

    if (high.length > 0) {
      logger.error(`High severity: ${high.length} types, ${high.reduce((s, d) => s + d.locations.length, 0)} occurrences`);
    }
    if (medium.length > 0) {
      logger.warn(`Medium severity: ${medium.length} types, ${medium.reduce((s, d) => s + d.locations.length, 0)} occurrences`);
    }
    if (low.length > 0) {
      logger.info(`Low severity: ${low.length} types, ${low.reduce((s, d) => s + d.locations.length, 0)} occurrences`);
    }
  }

  return discovered;
}

/**
 * Scan for a specific anti-pattern
 */
async function scan_for_anti_pattern(
  files: string[],
  root_path: string,
  definition: AntiPatternDefinition
): Promise<DiscoveredAntiPattern> {
  const locations: AntiPatternLocation[] = [];

  for (const file of files) {
    // Check exclusions
    if (definition.exclude?.some((ex) => ex.test(file))) {
      continue;
    }

    try {
      const content = await readFile(file, 'utf-8');
      const lines = content.split('\n');

      for (const pattern of definition.patterns) {
        pattern.lastIndex = 0;

        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
          // Check if excluded pattern
          if (definition.exclude?.some((ex) => ex.test(match![0]))) {
            continue;
          }

          const before_match = content.slice(0, match.index);
          const line_number = (before_match.match(/\n/g) ?? []).length + 1;
          const code_line = lines[line_number - 1] ?? '';

          // Skip if in comments
          if (code_line.trim().startsWith('//') || code_line.trim().startsWith('*')) {
            continue;
          }

          locations.push({
            file: relative(root_path, file),
            line: line_number,
            code: code_line.trim().slice(0, 100),
          });

          // Limit locations per anti-pattern
          if (locations.length >= 20) break;
        }

        if (locations.length >= 20) break;
      }
    } catch {
      // Skip unreadable files
    }
  }

  return {
    name: definition.name,
    severity: definition.severity,
    type: definition.type,
    description: definition.description,
    locations,
    recommendation: definition.recommendation,
  };
}

/**
 * Find long functions (> 50 lines)
 */
async function find_long_functions(
  files: string[],
  root_path: string
): Promise<DiscoveredAntiPattern> {
  const locations: AntiPatternLocation[] = [];
  const threshold = 50;

  for (const file of files) {
    try {
      const content = await readFile(file, 'utf-8');
      const lines = content.split('\n');

      // Simple heuristic: count lines between function declarations and closing braces
      const function_pattern = /(?:function\s+\w+|(?:async\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|(?:async\s+)?\w+\s*\([^)]*\)\s*{)/g;

      let match;
      while ((match = function_pattern.exec(content)) !== null) {
        const start_line = (content.slice(0, match.index).match(/\n/g) ?? []).length + 1;

        // Count function length (simple brace counting)
        let brace_count = 0;
        let started = false;
        let end_line = start_line;

        for (let i = start_line - 1; i < lines.length; i++) {
          const line = lines[i] ?? '';

          if (line.includes('{')) {
            brace_count += (line.match(/{/g) ?? []).length;
            started = true;
          }
          if (line.includes('}')) {
            brace_count -= (line.match(/}/g) ?? []).length;
          }

          if (started && brace_count === 0) {
            end_line = i + 1;
            break;
          }
        }

        const length = end_line - start_line;
        if (length > threshold) {
          locations.push({
            file: relative(root_path, file),
            line: start_line,
            code: `Function spans ${length} lines`,
          });

          if (locations.length >= 10) break;
        }
      }
    } catch {
      // Skip
    }
  }

  return {
    name: 'Long Function',
    severity: 'medium',
    type: 'long-function',
    description: `Functions exceeding ${threshold} lines`,
    locations,
    recommendation: 'Break down into smaller, focused functions',
  };
}

/**
 * Find god objects (classes > 500 lines)
 */
async function find_god_objects(
  files: string[],
  root_path: string
): Promise<DiscoveredAntiPattern> {
  const locations: AntiPatternLocation[] = [];
  const threshold = 500;

  for (const file of files) {
    try {
      const content = await readFile(file, 'utf-8');
      const lines = content.split('\n');

      // Find class declarations
      const class_pattern = /class\s+(\w+)/g;

      let match;
      while ((match = class_pattern.exec(content)) !== null) {
        const class_name = match[1];
        const start_line = (content.slice(0, match.index).match(/\n/g) ?? []).length + 1;

        // Count class length
        let brace_count = 0;
        let started = false;
        let end_line = start_line;

        for (let i = start_line - 1; i < lines.length; i++) {
          const line = lines[i] ?? '';

          if (line.includes('{')) {
            brace_count += (line.match(/{/g) ?? []).length;
            started = true;
          }
          if (line.includes('}')) {
            brace_count -= (line.match(/}/g) ?? []).length;
          }

          if (started && brace_count === 0) {
            end_line = i + 1;
            break;
          }
        }

        const length = end_line - start_line;
        if (length > threshold) {
          locations.push({
            file: relative(root_path, file),
            line: start_line,
            code: `Class ${class_name} spans ${length} lines`,
          });

          if (locations.length >= 10) break;
        }
      }
    } catch {
      // Skip
    }
  }

  return {
    name: 'God Object',
    severity: 'medium',
    type: 'god-object',
    description: `Classes exceeding ${threshold} lines with too many responsibilities`,
    locations,
    recommendation: 'Split into smaller classes with single responsibilities',
  };
}
