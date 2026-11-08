import type { Domain, DomainDefinition } from '../../core/domains/constants.js';
import { format_date } from '../../core/metadata/generator.js';

/**
 * Generate initial domain REGISTRY.md content
 */
export function generate_domain_registry(domain: Domain, definition: DomainDefinition): string {
  const today = format_date(new Date());

  return `---
title: ${definition.name} Registry
tier: reference
domains:
  - ${domain}
status: active
last_updated: '${today}'
version: '1.0.0'
generated: true
purpose: Quick reference for ${domain} documentation
---

# ${definition.name} Registry

> Quick reference for ${definition.description.toLowerCase()}.

## At a Glance

| Metric | Value |
|--------|-------|
| Documents | 0 |
| Category | ${definition.category} |
| Load Priority | ${definition.loadPriority}/10 |

## Quick Links

*No documents yet. Add your first document to see it listed here.*

## By Tier

| Tier | Count |
|------|-------|
| Guide | 0 |
| Standard | 0 |
| Example | 0 |
| Reference | 0 |
| Admin | 0 |

## Keywords

\`${definition.keywords.slice(0, 8).join('` `')}\`

## See Also

- [Full Index](INDEX.md) - Complete document listing
- [Root Index](../INDEX.md) - All domains
- [Root Registry](../REGISTRY.md) - All quick references

---

*Last updated: ${today}*
`;
}
