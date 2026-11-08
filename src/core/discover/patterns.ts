import { readFile } from 'fs/promises';
import { relative, extname } from 'path';
import { list_glob_matches } from '../../utils/glob.js';
import { logger } from '../../utils/logger.js';

export interface PatternDiscoveryOptions {
  root_path: string;
  language?: string;
  category?: string;
  silent?: boolean;
}

export interface DiscoveredPattern {
  name: string;
  category: PatternCategory;
  description: string;
  occurrences: number;
  examples: PatternExample[];
  suggested_documentation?: string;
}

export interface PatternExample {
  file: string;
  line: number;
  code: string;
  context?: string;
}

export type PatternCategory =
  | 'architecture'
  | 'data-access'
  | 'error-handling'
  | 'security'
  | 'testing'
  | 'api'
  | 'state-management'
  | 'utility';

export interface PatternDefinition {
  name: string;
  category: PatternCategory;
  description: string;
  patterns: RegExp[];
  file_patterns?: string[];
  languages?: string[];
}

// Built-in pattern definitions
const PATTERN_DEFINITIONS: PatternDefinition[] = [
  // Architecture patterns
  {
    name: 'Service Layer with Dependency Injection',
    category: 'architecture',
    description: 'Classes that accept dependencies via constructor',
    patterns: [
      /class\s+\w+Service\s*{[\s\S]*?constructor\s*\([^)]*\)/g,
      /class\s+\w+\s*{[\s\S]*?constructor\s*\(\s*(?:private|readonly)\s+\w+:/g,
    ],
    languages: ['typescript', 'javascript'],
  },
  {
    name: 'Repository Pattern',
    category: 'architecture',
    description: 'Data access abstraction layer',
    patterns: [
      /class\s+\w+Repository/g,
      /interface\s+I?\w+Repository/g,
    ],
    languages: ['typescript', 'javascript'],
  },
  {
    name: 'Factory Pattern',
    category: 'architecture',
    description: 'Object creation abstraction',
    patterns: [
      /class\s+\w+Factory/g,
      /function\s+create\w+\s*\(/g,
      /const\s+create\w+\s*=/g,
    ],
    languages: ['typescript', 'javascript'],
  },
  {
    name: 'Singleton Pattern',
    category: 'architecture',
    description: 'Single instance management',
    patterns: [
      /private\s+static\s+instance/g,
      /getInstance\s*\(\s*\)/g,
    ],
    languages: ['typescript', 'javascript'],
  },

  // Data access patterns
  {
    name: 'Async/Await Database Operations',
    category: 'data-access',
    description: 'Asynchronous database queries',
    patterns: [
      /async\s+\w+\s*\([^)]*\)\s*{[\s\S]*?await\s+(?:this\.)?(?:db|database|connection|pool|client)\./g,
      /await\s+(?:prisma|sequelize|typeorm|knex)\./g,
    ],
    languages: ['typescript', 'javascript'],
  },
  {
    name: 'Transaction Management',
    category: 'data-access',
    description: 'Database transaction handling',
    patterns: [
      /\.transaction\s*\(/g,
      /BEGIN\s+TRANSACTION/gi,
      /COMMIT/gi,
      /ROLLBACK/gi,
    ],
    languages: ['typescript', 'javascript', 'sql'],
  },

  // Error handling patterns
  {
    name: 'Try-Catch Error Handling',
    category: 'error-handling',
    description: 'Structured exception handling',
    patterns: [
      /try\s*{[\s\S]*?}\s*catch\s*\(/g,
    ],
    languages: ['typescript', 'javascript'],
  },
  {
    name: 'Custom Error Classes',
    category: 'error-handling',
    description: 'Domain-specific error types',
    patterns: [
      /class\s+\w+Error\s+extends\s+Error/g,
      /class\s+\w+Exception\s+extends/g,
    ],
    languages: ['typescript', 'javascript'],
  },
  {
    name: 'HTTP Exception Pattern',
    category: 'error-handling',
    description: 'HTTP error response handling',
    patterns: [
      /throw\s+new\s+Http\w*Exception/g,
      /throw\s+new\s+\w*HttpError/g,
      /throw\s+new\s+BadRequest/g,
      /throw\s+new\s+NotFound/g,
      /throw\s+new\s+Unauthorized/g,
    ],
    languages: ['typescript', 'javascript'],
  },

  // Security patterns
  {
    name: 'Authentication Middleware',
    category: 'security',
    description: 'Request authentication handling',
    patterns: [
      /(?:auth|authenticate|authorization)\s*(?:middleware|guard|handler)/gi,
      /@(?:Auth|Authorized|UseGuards)/g,
      /isAuthenticated/g,
    ],
    languages: ['typescript', 'javascript'],
  },
  {
    name: 'JWT Token Handling',
    category: 'security',
    description: 'JSON Web Token operations',
    patterns: [
      /jwt\.(?:sign|verify|decode)/g,
      /jsonwebtoken/g,
      /Bearer\s+/g,
    ],
    languages: ['typescript', 'javascript'],
  },
  {
    name: 'Input Validation',
    category: 'security',
    description: 'Request input sanitization',
    patterns: [
      /\.validate\s*\(/g,
      /zod\./g,
      /yup\./g,
      /joi\./g,
      /@IsString|@IsNumber|@IsEmail/g,
    ],
    languages: ['typescript', 'javascript'],
  },

  // Testing patterns
  {
    name: 'Unit Test Structure',
    category: 'testing',
    description: 'Test organization with describe/it blocks',
    patterns: [
      /describe\s*\(\s*['"`][^'"`]+['"`]\s*,/g,
      /it\s*\(\s*['"`][^'"`]+['"`]\s*,/g,
      /test\s*\(\s*['"`][^'"`]+['"`]\s*,/g,
    ],
    languages: ['typescript', 'javascript'],
  },
  {
    name: 'Mock/Stub Pattern',
    category: 'testing',
    description: 'Test double implementations',
    patterns: [
      /jest\.mock\s*\(/g,
      /vi\.mock\s*\(/g,
      /sinon\.stub\s*\(/g,
      /\.mockImplementation\s*\(/g,
    ],
    languages: ['typescript', 'javascript'],
  },

  // API patterns
  {
    name: 'REST Controller Pattern',
    category: 'api',
    description: 'HTTP endpoint handlers',
    patterns: [
      /@(?:Get|Post|Put|Delete|Patch)\s*\(/g,
      /router\.(?:get|post|put|delete|patch)\s*\(/g,
      /app\.(?:get|post|put|delete|patch)\s*\(/g,
    ],
    languages: ['typescript', 'javascript'],
  },
  {
    name: 'API Response Formatting',
    category: 'api',
    description: 'Consistent response structure',
    patterns: [
      /return\s*{\s*(?:data|success|message|error|status)/g,
      /res\.(?:json|send)\s*\(\s*{/g,
    ],
    languages: ['typescript', 'javascript'],
  },

  // State management patterns
  {
    name: 'React Hooks Pattern',
    category: 'state-management',
    description: 'React state and effect hooks',
    patterns: [
      /use(?:State|Effect|Context|Reducer|Callback|Memo|Ref)\s*\(/g,
    ],
    languages: ['typescript', 'javascript'],
    file_patterns: ['*.tsx', '*.jsx'],
  },
  {
    name: 'Redux/Zustand Store',
    category: 'state-management',
    description: 'Global state management',
    patterns: [
      /createSlice\s*\(/g,
      /createStore\s*\(/g,
      /create\s*\(\s*\([^)]*\)\s*=>\s*\(/g, // Zustand
    ],
    languages: ['typescript', 'javascript'],
  },
];

/**
 * Discover patterns in codebase
 */
export async function discover_patterns(
  options: PatternDiscoveryOptions
): Promise<DiscoveredPattern[]> {
  const {
    root_path,
    language,
    category,
    silent = false,
  } = options;

  const discovered: DiscoveredPattern[] = [];

  if (!silent) {
    logger.header('Pattern Discovery');
    logger.info(`Scanning: ${root_path}`);
  }

  // Determine file extensions to scan
  const extensions = get_extensions_for_language(language);
  const patterns = extensions.map((extension) => `**/*${extension}`);

  // Find all source files
  let files: string[] = [];
  for (const pattern of patterns) {
    const matches = await list_glob_matches(pattern, {
      // eslint-disable-next-line id-denylist -- child_process/glob option name
      cwd: root_path,
      absolute: true,
      ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**'],
    });
    files.push(...matches);
  }

  // Deduplicate
  files = [...new Set(files)];

  if (!silent) {
    logger.info(`Found ${files.length} source files`);
  }

  // Filter pattern definitions
  let definitions = PATTERN_DEFINITIONS;
  if (language) {
    definitions = definitions.filter(
      (definition) => !definition.languages || definition.languages.includes(language)
    );
  }
  if (category) {
    definitions = definitions.filter((definition) => definition.category === category);
  }

  // Scan for patterns
  for (const definition of definitions) {
    const pattern = await scan_for_pattern(files, root_path, definition);
    if (pattern.occurrences > 0) {
      discovered.push(pattern);
    }
  }

  // Sort by occurrences
  discovered.sort((a, b) => b.occurrences - a.occurrences);

  if (!silent) {
    logger.newline();
    logger.success(`Discovered ${discovered.length} patterns`);
    for (const pattern of discovered.slice(0, 10)) {
      logger.info(`  ${pattern.name}: ${pattern.occurrences} occurrences`);
    }
  }

  return discovered;
}

/**
 * Scan files for a specific pattern
 */
async function scan_for_pattern(
  files: string[],
  root_path: string,
  definition: PatternDefinition
): Promise<DiscoveredPattern> {
  const examples: PatternExample[] = [];
  let total_occurrences = 0;

  for (const file of files) {
    // Check file pattern filter
    if (definition.file_patterns) {
      const extension = extname(file);
      const matches = definition.file_patterns.some((file_pattern) =>
        file_pattern.endsWith(extension) || file_pattern === `*${extension}`
      );
      if (!matches) continue;
    }

    try {
      const content = await readFile(file, 'utf-8');
      const lines = content.split('\n');

      for (const pattern of definition.patterns) {
        // Reset regex
        pattern.lastIndex = 0;

        let match;
        while ((match = pattern.exec(content)) !== null) {
          total_occurrences++;

          // Only capture first 5 examples
          if (examples.length < 5) {
            // Find line number
            const before_match = content.slice(0, match.index);
            const line_number = (before_match.match(/\n/g) ?? []).length + 1;

            // Get line content
            const code_line = lines[line_number - 1] ?? '';

            examples.push({
              file: relative(root_path, file),
              line: line_number,
              code: code_line.trim().slice(0, 100),
            });
          }
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return {
    name: definition.name,
    category: definition.category,
    description: definition.description,
    occurrences: total_occurrences,
    examples,
  };
}

/**
 * Get file extensions for a language
 */
function get_extensions_for_language(language?: string): string[] {
  const extension_map: Record<string, string[]> = {
    typescript: ['.ts', '.tsx'],
    javascript: ['.js', '.jsx', '.mjs'],
    python: ['.py'],
    go: ['.go'],
    rust: ['.rs'],
    java: ['.java'],
    csharp: ['.cs'],
    ruby: ['.rb'],
    php: ['.php'],
  };

  if (language && extension_map[language]) {
    return extension_map[language]!;
  }

  // Default: TypeScript and JavaScript
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
}

/**
 * Generate documentation suggestion for a pattern
 */
export function generate_pattern_documentation(pattern: DiscoveredPattern): string {
  let doc = `# ${pattern.name}

## Overview

${pattern.description}

**Category:** ${pattern.category}
**Occurrences:** ${pattern.occurrences}

## Examples

`;

  for (const example of pattern.examples) {
    doc += `### ${example.file}:${example.line}

\`\`\`typescript
${example.code}
\`\`\`

`;
  }

  doc += `## Usage Guidelines

[Add guidelines for when and how to use this pattern]

## Related Patterns

[Add links to related patterns]
`;

  return doc;
}
