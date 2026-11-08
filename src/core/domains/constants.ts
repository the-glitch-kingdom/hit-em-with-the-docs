/**
 * Domain definitions for the hierarchical documentation system.
 * The system organizes documentation into 15 specialized domains.
 */

export const DOMAINS = [
  'agents',
  'api',
  'architecture',
  'backups',
  'database',
  'devops',
  'features',
  'plans',
  'procedures',
  'quickstart',
  'security',
  'standards',
  'testing',
  'troubleshooting',
  'workflows',
] as const;

/**
 * The 15 compiled-in domains. These are guaranteed present in every project.
 */
export type BuiltinDomain = (typeof DOMAINS)[number];

/**
 * A domain id. Widened from the built-in union to also accept arbitrary
 * (config-supplied) custom domain ids, while preserving autocomplete and
 * compile-time safety for references to the built-ins (e.g. `'security'`).
 *
 * The active set at runtime — built-ins plus any custom domains from
 * `.claude/hit-em-with-the-docs.json` — is resolved by the registry
 * (`./registry.ts`). Use the registry's accessors (`getAllDomains`,
 * `isValidDomain`, `getDomainDefinition`, …) for the live set; the `DOMAINS`
 * and `DOMAIN_DEFINITIONS` exports below are the BUILT-INS ONLY.
 */
// `string & {}` is the idiom that keeps built-in autocomplete while accepting
// custom ids; `string` alone would swallow the union.
// eslint-disable-next-line @typescript-eslint/ban-types
export type Domain = BuiltinDomain | (string & {});

export type DomainCategory = 'core' | 'development' | 'features' | 'advanced';

export interface DomainDefinition {
  id: Domain;
  name: string;
  description: string;
  keywords: string[];
  loadPriority: number; // 1-10, higher = more important to load first
  category: DomainCategory;
}

/**
 * Built-in domain definitions ONLY. The runtime-active set (built-ins +
 * custom) lives in the registry — do not iterate this directly in feature
 * code; call `getAllDomains()` / `getDomainDefinition()` from `./registry.ts`.
 */
export const DOMAIN_DEFINITIONS: Record<BuiltinDomain, DomainDefinition> = {
  security: {
    id: 'security',
    name: 'Security',
    description: 'Security, auth, Vault, Keycloak, RLS',
    keywords: [
      'security', 'auth', 'authentication', 'authorization', 'oauth', 'jwt',
      'keycloak', 'vault', 'secrets', 'rls', 'row-level-security', 'rbac',
      'permissions', 'access-control', 'encryption', 'ssl', 'tls', 'certificate',
    ],
    loadPriority: 9,
    category: 'core',
  },
  devops: {
    id: 'devops',
    name: 'DevOps',
    description: 'Deployment, CI/CD, Docker, environments, infrastructure',
    keywords: [
      'devops', 'deployment', 'deploy', 'ci', 'cd', 'ci/cd', 'pipeline',
      'docker', 'container', 'kubernetes', 'k8s', 'infrastructure', 'terraform',
      'ansible', 'aws', 'gcp', 'azure', 'cloud', 'environment', 'production',
      'staging', 'development', 'nginx', 'load-balancer', 'monitoring',
    ],
    loadPriority: 8,
    category: 'core',
  },
  database: {
    id: 'database',
    name: 'Database',
    description: 'Schema, migrations, RLS, queries, procedures',
    keywords: [
      'database', 'db', 'postgres', 'postgresql', 'mysql', 'sql', 'schema',
      'migration', 'migrations', 'alembic', 'query', 'queries', 'table',
      'index', 'indexes', 'rls', 'procedure', 'function', 'trigger',
      'transaction', 'orm', 'sqlalchemy', 'prisma',
    ],
    loadPriority: 8,
    category: 'core',
  },
  api: {
    id: 'api',
    name: 'API',
    description: 'API endpoints, routes, specifications, contracts',
    keywords: [
      'api', 'endpoint', 'endpoints', 'route', 'routes', 'rest', 'restful',
      'graphql', 'grpc', 'openapi', 'swagger', 'specification', 'contract',
      'request', 'response', 'http', 'fastapi', 'express', 'flask', 'django',
    ],
    loadPriority: 8,
    category: 'core',
  },
  standards: {
    id: 'standards',
    name: 'Standards',
    description: 'Coding standards (backend, frontend, database, devops, security)',
    keywords: [
      'standard', 'standards', 'convention', 'conventions', 'pattern', 'patterns',
      'best-practice', 'best-practices', 'guideline', 'guidelines', 'style',
      'style-guide', 'coding', 'naming', 'formatting', 'linting', 'rules',
    ],
    loadPriority: 10,
    category: 'development',
  },
  testing: {
    id: 'testing',
    name: 'Testing',
    description: 'Test strategies, fixtures, patterns, integration/e2e',
    keywords: [
      'test', 'testing', 'tests', 'unit', 'unit-test', 'integration',
      'integration-test', 'e2e', 'end-to-end', 'fixture', 'fixtures', 'mock',
      'mocking', 'stub', 'pytest', 'jest', 'vitest', 'playwright', 'cypress',
      'coverage', 'tdd', 'bdd',
    ],
    loadPriority: 7,
    category: 'development',
  },
  architecture: {
    id: 'architecture',
    name: 'Architecture',
    description: 'System design, AI coach, project registry, patterns',
    keywords: [
      'architecture', 'design', 'system', 'system-design', 'pattern', 'patterns',
      'microservices', 'monolith', 'serverless', 'event-driven', 'cqrs',
      'ddd', 'domain-driven', 'clean-architecture', 'hexagonal', 'decision',
      'adr', 'registry', 'diagram',
    ],
    loadPriority: 7,
    category: 'development',
  },
  features: {
    id: 'features',
    name: 'Features',
    description: 'Feature implementation guides, admin docs',
    keywords: [
      'feature', 'features', 'implementation', 'guide', 'how-to', 'tutorial',
      'admin', 'administration', 'dashboard', 'ui', 'component', 'module',
      'functionality', 'capability',
    ],
    loadPriority: 6,
    category: 'features',
  },
  quickstart: {
    id: 'quickstart',
    name: 'Quickstart',
    description: 'Setup guides, dev workflow, onboarding',
    keywords: [
      'quickstart', 'quick-start', 'getting-started', 'setup', 'install',
      'installation', 'onboarding', 'developer', 'dev', 'workflow', 'start',
      'begin', 'intro', 'introduction', 'new-developer',
    ],
    loadPriority: 9,
    category: 'features',
  },
  procedures: {
    id: 'procedures',
    name: 'Procedures',
    description: 'Step-by-step operational procedures (SOP)',
    keywords: [
      'procedure', 'procedures', 'sop', 'standard-operating-procedure', 'step',
      'steps', 'operational', 'operation', 'operations', 'runbook', 'playbook',
      'checklist', 'process', 'manual',
    ],
    loadPriority: 6,
    category: 'features',
  },
  workflows: {
    id: 'workflows',
    name: 'Workflows',
    description: 'Process documentation, multi-step operations',
    keywords: [
      'workflow', 'workflows', 'process', 'processes', 'flow', 'flowchart',
      'sequence', 'pipeline', 'automation', 'automated', 'multi-step',
      'orchestration', 'state-machine',
    ],
    loadPriority: 5,
    category: 'features',
  },
  agents: {
    id: 'agents',
    name: 'Agents',
    description: 'Expert agent documentation, specialty matrix',
    keywords: [
      'agent', 'agents', 'ai', 'assistant', 'expert', 'specialist', 'llm',
      'langchain', 'rag', 'retrieval', 'embedding', 'vector', 'prompt',
      'orchestration', 'chain', 'tool',
    ],
    loadPriority: 5,
    category: 'advanced',
  },
  backups: {
    id: 'backups',
    name: 'Backups',
    description: 'Backup/restore guides, disaster recovery',
    keywords: [
      'backup', 'backups', 'restore', 'recovery', 'disaster', 'disaster-recovery',
      'dr', 'snapshot', 'archive', 'retention', 'replication', 'failover',
    ],
    loadPriority: 4,
    category: 'advanced',
  },
  troubleshooting: {
    id: 'troubleshooting',
    name: 'Troubleshooting',
    description: 'Debug guides, common issues, solutions',
    keywords: [
      'troubleshooting', 'troubleshoot', 'debug', 'debugging', 'issue', 'issues',
      'problem', 'problems', 'error', 'errors', 'fix', 'solution', 'solutions',
      'resolve', 'diagnose', 'diagnosis', 'log', 'logs', 'faq',
    ],
    loadPriority: 6,
    category: 'advanced',
  },
  plans: {
    id: 'plans',
    name: 'Plans',
    description: 'Planning documents, roadmaps, proposals',
    keywords: [
      'plan', 'plans', 'planning', 'roadmap', 'proposal', 'proposals', 'rfc',
      'design-doc', 'specification', 'spec', 'milestone', 'timeline', 'schedule',
      'project', 'initiative',
    ],
    loadPriority: 3,
    category: 'advanced',
  },
};

/**
 * Check whether a string is one of the 15 BUILT-IN domains. This is a pure,
 * registry-independent check used where built-in-ness specifically matters
 * (e.g. `hewtd domain remove` refusing to remove a built-in). For "is this a
 * valid domain in the active set (built-in OR custom)", use `isValidDomain()`
 * from `./registry.ts`.
 */
export function is_builtin_domain(value: string): value is BuiltinDomain {
  return (DOMAINS as readonly string[]).includes(value);
}
