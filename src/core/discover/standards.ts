import { readFile } from 'fs/promises';
import { relative, basename } from 'path';
import { glob } from '../../utils/glob.js';
import { logger } from '../../utils/logger.js';

export interface StandardsDiscoveryOptions {
  root_path: string;
  silent?: boolean;
}

export interface DiscoveredStandards {
  naming: NamingStandards;
  file_organization: FileOrganizationStandards;
  code_style: CodeStyleStandards;
  documentation: DocumentationStandards;
  testing: TestingStandards;
}

export interface NamingStandards {
  functions: ConventionCompliance;
  classes: ConventionCompliance;
  constants: ConventionCompliance;
  variables: ConventionCompliance;
  files: ConventionCompliance;
}

export interface ConventionCompliance {
  convention: string;
  compliance: number;
  examples: { name: string; file: string; compliant: boolean }[];
}

export interface FileOrganizationStandards {
  patterns: { pattern: string; files: number; examples: string[] }[];
  root_folders: string[];
}

export interface CodeStyleStandards {
  max_line_length: number;
  indentation: 'spaces' | 'tabs' | 'mixed';
  indent_size?: number;
  semicolons: 'always' | 'never' | 'mixed';
  quotes: 'single' | 'double' | 'mixed';
  trailing_commas: 'always' | 'never' | 'mixed';
}

export interface DocumentationStandards {
  docstring_style: string;
  coverage: number;
  type_hint_coverage: number;
}

export interface TestingStandards {
  pattern: string;
  coverage?: number;
  fixture_pattern?: string;
}

/**
 * Discover implicit standards from codebase
 */
export async function discover_standards(
  options: StandardsDiscoveryOptions
): Promise<DiscoveredStandards> {
  const { root_path, silent = false } = options;

  if (!silent) {
    logger.header('Standards Discovery');
    logger.info(`Analyzing: ${root_path}`);
  }

  // Find all source files
  const ts_files = await glob('**/*.{ts,tsx}', {
    cwd: root_path,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**'],
  });

  const js_files = await glob('**/*.{js,jsx,mjs}', {
    cwd: root_path,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**'],
  });

  const all_files = [...new Set([...ts_files, ...js_files])];

  if (!silent) {
    logger.info(`Analyzing ${all_files.length} source files...`);
  }

  // Discover each category
  const naming = await discover_naming_standards(all_files, root_path);
  const file_organization = await discover_file_organization(root_path);
  const code_style = await discover_code_style(all_files);
  const documentation = await discover_documentation_standards(all_files);
  const testing = await discover_testing_standards(root_path);

  const standards: DiscoveredStandards = {
    naming,
    file_organization,
    code_style,
    documentation,
    testing,
  };

  if (!silent) {
    logger.newline();
    logger.success('Standards discovered:');
    logger.info(`  Functions: ${naming.functions.convention} (${naming.functions.compliance.toFixed(0)}% compliance)`);
    logger.info(`  Classes: ${naming.classes.convention} (${naming.classes.compliance.toFixed(0)}% compliance)`);
    logger.info(`  Indentation: ${code_style.indentation}${code_style.indent_size ? ` (${code_style.indent_size} spaces)` : ''}`);
    logger.info(`  Type hints: ${documentation.type_hint_coverage.toFixed(0)}% coverage`);
  }

  return standards;
}

/**
 * Discover naming conventions
 */
async function discover_naming_standards(
  files: string[],
  root_path: string
): Promise<NamingStandards> {
  const function_names: { name: string; file: string }[] = [];
  const class_names: { name: string; file: string }[] = [];
  const constant_names: { name: string; file: string }[] = [];
  const variable_names: { name: string; file: string }[] = [];

  for (const file of files.slice(0, 100)) {
    try {
      const content = await readFile(file, 'utf-8');
      const rel_path = relative(root_path, file);

      // Extract function names
      const func_matches = content.matchAll(/(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)/g);
      for (const match of func_matches) {
        const name = match[1] ?? match[2];
        if (name) function_names.push({ name, file: rel_path });
      }

      // Extract class names
      const class_matches = content.matchAll(/class\s+(\w+)/g);
      for (const match of class_matches) {
        if (match[1]) class_names.push({ name: match[1], file: rel_path });
      }

      // Extract constants (UPPER_SNAKE_CASE)
      const const_matches = content.matchAll(/const\s+([A-Z][A-Z0-9_]+)\s*=/g);
      for (const match of const_matches) {
        if (match[1]) constant_names.push({ name: match[1], file: rel_path });
      }

      // Extract regular variables
      const var_matches = content.matchAll(/(?:const|let|var)\s+([a-z][a-zA-Z0-9]*)\s*=/g);
      for (const match of var_matches) {
        if (match[1]) variable_names.push({ name: match[1], file: rel_path });
      }
    } catch {
      // Skip
    }
  }

  // Analyze file naming
  const file_name_examples = files.slice(0, 20).map((f) => ({
    name: basename(f),
    file: relative(root_path, f),
  }));

  return {
    functions: analyze_naming_convention(function_names, 'camelCase'),
    classes: analyze_naming_convention(class_names, 'PascalCase'),
    constants: analyze_naming_convention(constant_names, 'UPPER_SNAKE_CASE'),
    variables: analyze_naming_convention(variable_names, 'camelCase'),
    files: analyze_file_naming(file_name_examples),
  };
}

/**
 * Analyze naming convention compliance
 */
function analyze_naming_convention(
  names: { name: string; file: string }[],
  expected_convention: string
): ConventionCompliance {
  const checks = {
    camelCase: (n: string) => /^[a-z][a-zA-Z0-9]*$/.test(n),
    PascalCase: (n: string) => /^[A-Z][a-zA-Z0-9]*$/.test(n),
    UPPER_SNAKE_CASE: (n: string) => /^[A-Z][A-Z0-9_]*$/.test(n),
    'kebab-case': (n: string) => /^[a-z][a-z0-9-]*$/.test(n),
    snake_case: (n: string) => /^[a-z][a-z0-9_]*$/.test(n),
  };

  const check = checks[expected_convention as keyof typeof checks] ?? checks.camelCase;

  const compliant = names.filter((n) => check(n.name));
  const compliance = names.length > 0 ? (compliant.length / names.length) * 100 : 100;

  // Detect actual convention used
  let detected_convention = expected_convention;
  let max_compliance = compliance;

  for (const [convention, check_fn] of Object.entries(checks)) {
    const convention_compliance = names.filter((n) => check_fn(n.name)).length / Math.max(names.length, 1) * 100;
    if (convention_compliance > max_compliance) {
      max_compliance = convention_compliance;
      detected_convention = convention;
    }
  }

  return {
    convention: detected_convention,
    compliance: max_compliance,
    examples: names.slice(0, 5).map((n) => ({
      ...n,
      compliant: check(n.name),
    })),
  };
}

/**
 * Analyze file naming convention
 */
function analyze_file_naming(
  files: { name: string; file: string }[]
): ConventionCompliance {
  const kebab_case = files.filter((f) => /^[a-z][a-z0-9-]*\./.test(f.name)).length;
  const camel_case = files.filter((f) => /^[a-z][a-zA-Z0-9]*\./.test(f.name)).length;
  const pascal_case = files.filter((f) => /^[A-Z][a-zA-Z0-9]*\./.test(f.name)).length;
  const snake_case = files.filter((f) => /^[a-z][a-z0-9_]*\./.test(f.name)).length;

  const total = files.length || 1;
  const conventions = [
    { name: 'kebab-case', count: kebab_case },
    { name: 'camelCase', count: camel_case },
    { name: 'PascalCase', count: pascal_case },
    { name: 'snake_case', count: snake_case },
  ];

  const best = conventions.sort((a, b) => b.count - a.count)[0]!;

  return {
    convention: best.name,
    compliance: (best.count / total) * 100,
    examples: files.slice(0, 5).map((f) => ({
      ...f,
      compliant: best.name === 'kebab-case' ? /^[a-z][a-z0-9-]*\./.test(f.name) : true,
    })),
  };
}

/**
 * Discover file organization patterns
 */
async function discover_file_organization(
  root_path: string
): Promise<FileOrganizationStandards> {
  const patterns: { pattern: string; files: number; examples: string[] }[] = [];

  // Common folder patterns to check
  const folder_patterns = [
    { pattern: 'src/', glob: 'src/**/*' },
    { pattern: 'lib/', glob: 'lib/**/*' },
    { pattern: 'components/', glob: '**/components/**/*' },
    { pattern: 'services/', glob: '**/services/**/*' },
    { pattern: 'models/', glob: '**/models/**/*' },
    { pattern: 'utils/', glob: '**/utils/**/*' },
    { pattern: 'hooks/', glob: '**/hooks/**/*' },
    { pattern: 'api/', glob: '**/api/**/*' },
    { pattern: 'routes/', glob: '**/routes/**/*' },
    { pattern: 'routers/', glob: '**/routers/**/*' },
    { pattern: 'tests/', glob: '**/tests/**/*' },
    { pattern: '__tests__/', glob: '**/__tests__/**/*' },
  ];

  for (const { pattern: name, glob: glob_pattern } of folder_patterns) {
    const files = await glob(glob_pattern, {
      cwd: root_path,
      ignore: ['**/node_modules/**', '**/dist/**'],
    });

    if (files.length > 0) {
      patterns.push({
        pattern: name,
        files: files.length,
        examples: files.slice(0, 3),
      });
    }
  }

  // Get root folders
  const root_entries = await glob('*', { cwd: root_path });
  const root_folders = root_entries.filter((e) => !e.includes('.'));

  return {
    patterns: patterns.sort((a, b) => b.files - a.files),
    root_folders,
  };
}

/**
 * Discover code style preferences
 */
async function discover_code_style(files: string[]): Promise<CodeStyleStandards> {
  let tab_count = 0;
  let space_count = 0;
  let space2_count = 0;
  let space4_count = 0;
  let semi_count = 0;
  let no_semi_count = 0;
  let single_quote_count = 0;
  let double_quote_count = 0;
  let trailing_comma_count = 0;
  let no_trailing_comma_count = 0;
  let max_line_length = 0;

  for (const file of files.slice(0, 50)) {
    try {
      const content = await readFile(file, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        // Check indentation
        if (line.startsWith('\t')) tab_count++;
        if (line.startsWith('  ')) {
          space_count++;
          if (line.startsWith('    ') && !line.startsWith('      ')) space4_count++;
          else if (line.startsWith('  ') && !line.startsWith('    ')) space2_count++;
        }

        // Check max line length
        if (line.length > max_line_length) max_line_length = line.length;

        // Check semicolons (at end of statements)
        if (/[a-zA-Z0-9)}\]'"`]\s*;$/.test(line.trim())) semi_count++;
        if (/[a-zA-Z0-9)}\]'"`]$/.test(line.trim()) && !line.trim().endsWith('{')) no_semi_count++;

        // Check quotes
        if (line.includes("'") && !line.includes('"')) single_quote_count++;
        if (line.includes('"') && !line.includes("'")) double_quote_count++;

        // Check trailing commas
        if (/,\s*[}\]]/.test(line)) trailing_comma_count++;
        if (/[^,\s]\s*[}\]]/.test(line)) no_trailing_comma_count++;
      }
    } catch {
      // Skip
    }
  }

  // Determine preferences
  const indentation: 'spaces' | 'tabs' | 'mixed' =
    tab_count > space_count * 0.8 ? 'tabs' :
    space_count > tab_count * 0.8 ? 'spaces' : 'mixed';

  const indent_size = space4_count > space2_count ? 4 : 2;

  const semicolons: 'always' | 'never' | 'mixed' =
    semi_count > no_semi_count * 2 ? 'always' :
    no_semi_count > semi_count * 2 ? 'never' : 'mixed';

  const quotes: 'single' | 'double' | 'mixed' =
    single_quote_count > double_quote_count * 2 ? 'single' :
    double_quote_count > single_quote_count * 2 ? 'double' : 'mixed';

  const trailing_commas: 'always' | 'never' | 'mixed' =
    trailing_comma_count > no_trailing_comma_count * 2 ? 'always' :
    no_trailing_comma_count > trailing_comma_count * 2 ? 'never' : 'mixed';

  const result: CodeStyleStandards = {
    max_line_length,
    indentation,
    semicolons,
    quotes,
    trailing_commas,
  };
  if (indentation === 'spaces') {
    result.indent_size = indent_size;
  }
  return result;
}

/**
 * Discover documentation standards
 */
async function discover_documentation_standards(
  files: string[]
): Promise<DocumentationStandards> {
  let total_functions = 0;
  let documented_functions = 0;
  let typed_functions = 0;
  let jsdoc_count = 0;
  let tsdoc_count = 0;

  for (const file of files.slice(0, 50)) {
    try {
      const content = await readFile(file, 'utf-8');

      // Count functions
      const functions = content.match(/(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)/g);
      total_functions += functions?.length ?? 0;

      // Count documented functions (JSDoc/TSDoc comments before functions)
      const jsdocs = content.match(/\/\*\*[\s\S]*?\*\/\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|var)/g);
      documented_functions += jsdocs?.length ?? 0;

      // Check docstring style
      if (content.includes('@param')) jsdoc_count++;
      if (content.includes('@returns')) tsdoc_count++;

      // Count typed functions (TypeScript)
      const typed = content.match(/\([^)]*:[^)]+\)\s*(?::\s*\w+)?\s*(?:=>|{)/g);
      typed_functions += typed?.length ?? 0;
    } catch {
      // Skip
    }
  }

  const docstring_style = tsdoc_count > jsdoc_count ? 'TSDoc' : 'JSDoc';
  const coverage = total_functions > 0 ? (documented_functions / total_functions) * 100 : 0;
  const type_hint_coverage = total_functions > 0 ? (typed_functions / total_functions) * 100 : 0;

  return {
    docstring_style,
    coverage,
    type_hint_coverage,
  };
}

/**
 * Discover testing standards
 */
async function discover_testing_standards(
  root_path: string
): Promise<TestingStandards> {
  // Check for test files in various patterns
  const patterns = [
    '**/*.test.ts',
    '**/*.spec.ts',
    '**/__tests__/*.ts',
    '**/test/*.ts',
    '**/tests/*.ts',
  ];

  let test_pattern = '*.test.ts';
  let max_files = 0;

  for (const pattern of patterns) {
    const files = await glob(pattern, {
      cwd: root_path,
      ignore: ['**/node_modules/**'],
    });

    if (files.length > max_files) {
      max_files = files.length;
      test_pattern = pattern.replace('**/', '').replace('/*.ts', '');
    }
  }

  // Check for fixtures
  const fixtures = await glob('**/fixtures/**/*', {
    cwd: root_path,
    ignore: ['**/node_modules/**'],
  });

  const result: TestingStandards = {
    pattern: test_pattern,
  };
  if (fixtures.length > 0) {
    result.fixture_pattern = 'fixtures/';
  }
  return result;
}
