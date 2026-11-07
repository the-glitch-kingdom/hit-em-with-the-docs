import { describe, it, expect } from 'vitest';
import matter from 'gray-matter';
import { generateRootIndex, generateDomainIndexContent } from '../../../src/generators/index-generator.js';
import { generateRootRegistry, generateDomainRegistryContent } from '../../../src/generators/registry-generator.js';
import { generateDomainIndex } from '../../../src/generators/templates/domain-index.js';
import { generateDomainRegistry } from '../../../src/generators/templates/domain-registry.js';
import { getDomainDefinition } from '../../../src/core/domains/registry.js';
import { validatePartialMetadata } from '../../../src/core/metadata/schema.js';

const entry = (purpose?: string) => ({
  path: 'a.md',
  title: 'A',
  tier: 'guide',
  status: 'active',
  lastUpdated: '2026-01-01',
  ...(purpose !== undefined && { purpose }),
});

describe('generated: true marker (#50)', () => {
  const outputs: Record<string, string> = {
    rootIndex: generateRootIndex(),
    domainIndex: generateDomainIndexContent('api', []),
    rootRegistry: generateRootRegistry(),
    domainRegistry: generateDomainRegistryContent('api', []),
    domainIndexTemplate: generateDomainIndex('api', getDomainDefinition('api')),
    domainRegistryTemplate: generateDomainRegistry('api', getDomainDefinition('api')),
  };
  for (const [name, out] of Object.entries(outputs)) {
    it(`${name} carries generated: true and passes validation`, () => {
      const fm = matter(out).data;
      expect(fm.generated).toBe(true);
      expect(validatePartialMetadata(fm).valid).toBe(true);
    });
  }
});

describe('INDEX purpose column (#50)', () => {
  it('renders a purpose with | and newlines as one row', () => {
    const out = generateDomainIndexContent('api', [entry('a | b\nc')]);
    const row = out.split('\n').filter((l) => l.includes('[A](a.md)'));
    expect(row).toHaveLength(1);
    expect(row[0]).toContain('a \\| b c');
  });

  it('leaves the cell empty when purpose is missing (domain + root)', () => {
    expect(generateDomainIndexContent('api', [entry()])).toMatch(/\| - \| {2}\|/);
    const root = generateRootIndex({ api: [entry()] } as never);
    expect(root).toContain('| Purpose |');
    expect(root).toMatch(/\| 2026-01-01 \| {2}\|/);
  });
});
