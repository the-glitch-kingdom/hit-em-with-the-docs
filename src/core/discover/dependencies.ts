import { readFile } from 'fs/promises';
import { join, relative } from 'path';
import { glob, path_exists } from '../../utils/glob.js';
import { logger } from '../../utils/logger.js';

export interface DependencyAnalysisOptions {
  rootPath: string;
  silent?: boolean;
}

export interface DependencyAnalysis {
  packages: PackageAnalysis;
  modules: ModuleAnalysis;
  security: SecurityAnalysis;
  unused: UnusedDependency[];
}

export interface PackageAnalysis {
  total: number;
  production: number;
  development: number;
  dependencies: PackageInfo[];
  devDependencies: PackageInfo[];
}

export interface PackageInfo {
  name: string;
  version: string;
  type: 'production' | 'development';
  outdated?: boolean;
  latestVersion?: string;
}

export interface ModuleAnalysis {
  totalFiles: number;
  imports: number;
  circularDependencies: CircularDependency[];
  highCoupling: HighCouplingModule[];
}

export interface CircularDependency {
  files: string[];
}

export interface HighCouplingModule {
  file: string;
  imports: number;
  importedBy: number;
}

export interface SecurityAnalysis {
  vulnerabilities: SecurityVulnerability[];
}

export interface SecurityVulnerability {
  package: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  title: string;
  recommendation: string;
}

export interface UnusedDependency {
  name: string;
  type: 'production' | 'development';
  reason: string;
}

/**
 * Analyze project dependencies
 */
export async function analyze_dependencies(
  options: DependencyAnalysisOptions
): Promise<DependencyAnalysis> {
  const { rootPath: root_path, silent = false } = options;

  if (!silent) {
    logger.header('Dependency Analysis');
    logger.info(`Analyzing: ${root_path}`);
  }

  // Analyze package.json dependencies
  const packages = await analyze_packages(root_path);

  if (!silent) {
    logger.info(`Found ${packages.total} packages (${packages.production} prod, ${packages.development} dev)`);
  }

  // Analyze module imports
  const modules = await analyze_modules(root_path);

  if (!silent) {
    logger.info(`Analyzed ${modules.totalFiles} files, ${modules.imports} imports`);
    if (modules.circularDependencies.length > 0) {
      logger.warn(`Found ${modules.circularDependencies.length} circular dependencies`);
    }
  }

  // Check for security issues (basic check)
  const security = await analyze_security_basic(packages);

  // Find unused dependencies
  const unused = await find_unused_dependencies(root_path, packages);

  if (!silent && unused.length > 0) {
    logger.warn(`Found ${unused.length} potentially unused dependencies`);
  }

  return {
    packages,
    modules,
    security,
    unused,
  };
}

/**
 * Analyze package.json
 */
async function analyze_packages(root_path: string): Promise<PackageAnalysis> {
  const result: PackageAnalysis = {
    total: 0,
    production: 0,
    development: 0,
    dependencies: [],
    devDependencies: [],
  };

  const package_json_path = join(root_path, 'package.json');

  if (!(await path_exists(package_json_path))) {
    return result;
  }

  try {
    const content = await readFile(package_json_path, 'utf-8');
    const pkg = JSON.parse(content);

    // Production dependencies
    if (pkg.dependencies) {
      for (const [name, version] of Object.entries(pkg.dependencies)) {
        result.dependencies.push({
          name,
          version: String(version),
          type: 'production',
        });
      }
      result.production = result.dependencies.length;
    }

    // Dev dependencies
    if (pkg.devDependencies) {
      for (const [name, version] of Object.entries(pkg.devDependencies)) {
        result.devDependencies.push({
          name,
          version: String(version),
          type: 'development',
        });
      }
      result.development = result.devDependencies.length;
    }

    result.total = result.production + result.development;
  } catch {
    // Invalid package.json
  }

  return result;
}

/**
 * Analyze module imports and dependencies
 */
async function analyze_modules(root_path: string): Promise<ModuleAnalysis> {
  const result: ModuleAnalysis = {
    totalFiles: 0,
    imports: 0,
    circularDependencies: [],
    highCoupling: [],
  };

  // Find all source files
  const files = await glob('**/*.{ts,tsx,js,jsx}', {
    cwd: root_path,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/build/**'],
  });

  result.totalFiles = files.length;

  // Build import graph
  const import_graph = new Map<string, Set<string>>();
  const imported_by = new Map<string, Set<string>>();

  for (const file of files) {
    try {
      const content = await readFile(file, 'utf-8');
      const rel_path = relative(root_path, file);

      // Extract imports
      const import_matches = content.matchAll(/import\s+.*?from\s+['"]([^'"]+)['"]/g);
      const imports = new Set<string>();

      for (const match of import_matches) {
        const import_path = match[1];
        if (import_path?.startsWith('.')) {
          // Resolve relative import
          const resolved = resolve_import(rel_path, import_path);
          imports.add(resolved);
          result.imports++;

          // Track imported by
          if (!imported_by.has(resolved)) {
            imported_by.set(resolved, new Set());
          }
          imported_by.get(resolved)!.add(rel_path);
        }
      }

      import_graph.set(rel_path, imports);
    } catch {
      // Skip unreadable files
    }
  }

  // Detect circular dependencies
  result.circularDependencies = detect_circular_dependencies(import_graph);

  // Find high coupling modules
  for (const [file, imports] of import_graph) {
    const import_count = imports.size;
    const imported_by_count = imported_by.get(file)?.size ?? 0;

    if (import_count > 10 || imported_by_count > 10) {
      result.highCoupling.push({
        file,
        imports: import_count,
        importedBy: imported_by_count,
      });
    }
  }

  // Sort by total coupling
  result.highCoupling.sort((a, b) =>
    (b.imports + b.importedBy) - (a.imports + a.importedBy)
  );

  return result;
}

/**
 * Resolve relative import path
 */
function resolve_import(from_file: string, import_path: string): string {
  const from_dir = from_file.split('/').slice(0, -1).join('/');
  const parts = import_path.split('/');
  const result: string[] = from_dir ? from_dir.split('/') : [];

  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      result.pop();
    } else {
      result.push(part);
    }
  }

  let resolved = result.join('/');

  // Add extension if not present
  if (!resolved.match(/\.[jt]sx?$/)) {
    resolved += '.ts';
  }

  return resolved;
}

/**
 * Detect circular dependencies using DFS
 */
function detect_circular_dependencies(
  graph: Map<string, Set<string>>
): CircularDependency[] {
  const cycles: CircularDependency[] = [];
  const visited = new Set<string>();
  const recursion_stack = new Set<string>();

  function dfs(node: string, path: string[]): boolean {
    if (recursion_stack.has(node)) {
      // Found a cycle
      const cycle_start = path.indexOf(node);
      if (cycle_start !== -1) {
        cycles.push({ files: path.slice(cycle_start) });
      }
      return true;
    }

    if (visited.has(node)) {
      return false;
    }

    visited.add(node);
    recursion_stack.add(node);
    path.push(node);

    const imports = graph.get(node) ?? new Set();
    for (const imported of imports) {
      dfs(imported, [...path]);
    }

    recursion_stack.delete(node);
    return false;
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }

  // Deduplicate cycles (same cycle can be detected from different starting points)
  const unique_cycles: CircularDependency[] = [];
  const seen = new Set<string>();

  for (const cycle of cycles) {
    const key = [...cycle.files].sort().join('->');
    if (!seen.has(key)) {
      seen.add(key);
      unique_cycles.push(cycle);
    }
  }

  return unique_cycles.slice(0, 10); // Limit to first 10
}

/**
 * Basic security check (pattern-based)
 */
async function analyze_security_basic(
  packages: PackageAnalysis
): Promise<SecurityAnalysis> {
  const vulnerabilities: SecurityVulnerability[] = [];

  // Known vulnerable packages (simplified - real implementation would use a vulnerability database)
  const known_vulnerable: Record<string, { severity: SecurityVulnerability['severity']; title: string; fix: string }> = {
    'lodash': {
      severity: 'high',
      title: 'Prototype Pollution in lodash < 4.17.21',
      fix: 'Upgrade to lodash@4.17.21 or higher',
    },
    'minimist': {
      severity: 'moderate',
      title: 'Prototype Pollution in minimist < 1.2.6',
      fix: 'Upgrade to minimist@1.2.6 or higher',
    },
    'node-fetch': {
      severity: 'moderate',
      title: 'Exposure of Sensitive Information in node-fetch < 2.6.7',
      fix: 'Upgrade to node-fetch@2.6.7 or higher',
    },
  };

  const all_packages = [...packages.dependencies, ...packages.devDependencies];

  for (const pkg of all_packages) {
    const vuln = known_vulnerable[pkg.name];
    if (vuln) {
      // Check version (simplified - real implementation would do proper semver comparison)
      vulnerabilities.push({
        package: pkg.name,
        severity: vuln.severity,
        title: vuln.title,
        recommendation: vuln.fix,
      });
    }
  }

  return { vulnerabilities };
}

/**
 * Find potentially unused dependencies
 */
async function find_unused_dependencies(
  root_path: string,
  packages: PackageAnalysis
): Promise<UnusedDependency[]> {
  const unused: UnusedDependency[] = [];

  // Get all source files
  const files = await glob('**/*.{ts,tsx,js,jsx,json}', {
    cwd: root_path,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**'],
  });

  // Read all file contents
  let all_content = '';
  for (const file of files) {
    try {
      const content = await readFile(file, 'utf-8');
      all_content += content + '\n';
    } catch {
      // Skip
    }
  }

  // Check each dependency
  const all_packages = [...packages.dependencies, ...packages.devDependencies];

  for (const pkg of all_packages) {
    const name = pkg.name;

    // Skip common false positives
    if (['typescript', '@types/', 'eslint', 'prettier', 'vitest', 'jest'].some((p) => name.includes(p))) {
      continue;
    }

    // Check if package is imported
    const import_patterns = [
      `from '${name}'`,
      `from "${name}"`,
      `require('${name}')`,
      `require("${name}")`,
      `from '${name}/`,
      `from "${name}/`,
    ];

    const is_used = import_patterns.some((p) => all_content.includes(p));

    if (!is_used) {
      unused.push({
        name,
        type: pkg.type,
        reason: 'No import found in source files',
      });
    }
  }

  return unused;
}
