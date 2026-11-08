import { describe, it, expect } from 'vitest';
import matter from 'gray-matter';
import { generate_root_index, generate_domain_index_content } from '../../../src/generators/index-generator.js';
import { generate_root_registry, generate_domain_registry_content } from '../../../src/generators/registry-generator.js';
import { generate_domain_index } from '../../../src/generators/templates/domain-index.js';
import { generate_domain_registry } from '../../../src/generators/templates/domain-registry.js';
import { get_domain_definition } from '../../../src/core/domains/registry.js';
import { validate_partial_metadata } from '../../../src/core/metadata/schema.js';

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
    rootIndex: generate_root_index(),
    domainIndex: generate_domain_index_content('api', []),
    rootRegistry: generate_root_registry(),
    domainRegistry: generate_domain_registry_content('api', []),
    domainIndexTemplate: generate_domain_index('api', get_domain_definition('api')),
    domainRegistryTemplate: generate_domain_registry('api', get_domain_definition('api')),
  };
  for (const [name, out] of Object.entries(outputs)) {
    it(`${name} carries generated: true and passes validation`, () => {
      const fm = matter(out).data;
      expect(fm.generated).toBe(true);
      expect(validate_partial_metadata(fm).valid).toBe(true);
    });
  }
});

describe('INDEX purpose column (#50)', () => {
  it('renders a purpose with | and newlines as one row', () => {
    const out = generate_domain_index_content('api', [entry('a | b\nc')]);
    const row = out.split('\n').filter((l) => l.includes('[A](a.md)'));
    expect(row).toHaveLength(1);
    expect(row[0]).toContain('a \\| b c');
  });

  it('keeps a purpose containing a backslash-pipe in one cell (review fix)', () => {
    const out = generate_domain_index_content('api', [entry('Match a \\| b')]);
    const row = out.split('\n').find((l) => l.includes('[A](a.md)'))!;
    // GFM: unescaped pipes split cells; every pipe in the purpose must be preceded by an odd run of backslashes.
    expect(row).toContain('Match a \\\\\\| b');
  });

  it('leaves the cell empty when purpose is missing (domain + root)', () => {
    expect(generate_domain_index_content('api', [entry()])).toMatch(/\| - \| {2}\|/);
    const root = generate_root_index({ api: [entry()] } as never);
    expect(root).toContain('| Purpose |');
    expect(root).toMatch(/\| 2026-01-01 \| {2}\|/);
  });
});
