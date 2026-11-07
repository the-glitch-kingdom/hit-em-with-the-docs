import type { Domain, DomainDefinition } from '../../core/domains/constants.js';
import { formatDate } from '../../core/metadata/generator.js';

/**
 * Generate initial domain REGISTRY.md content
 */
export function generateDomainRegistry(domain: Domain, def: DomainDefinition): string {
  const now = formatDate(new Date());

  return `---
title: ${def.name} Registry
tier: reference
domains:
  - ${domain}
status: active
last_updated: '${now}'
version: '1.0.0'
generated: true
purpose: Quick reference for ${domain} documentation
---

# ${def.name} Registry

> Quick reference for ${def.description.toLowerCase()}.

## At a Glance

| Metric | Value |
|--------|-------|
| Documents | 0 |
| Category | ${def.category} |
| Load Priority | ${def.loadPriority}/10 |

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

\`${def.keywords.slice(0, 8).join('` `')}\`

## See Also

- [Full Index](INDEX.md) - Complete document listing
- [Root Index](../INDEX.md) - All domains
- [Root Registry](../REGISTRY.md) - All quick references

---

*Last updated: ${now}*
`;
}
