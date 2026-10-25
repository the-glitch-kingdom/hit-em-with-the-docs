import type { Domain, DomainDefinition } from '../../core/domains/constants.js';
import { formatDate } from '../../core/metadata/generator.js';

/**
 * Generate initial domain INDEX.md content
 */
export function generateDomainIndex(domain: Domain, def: DomainDefinition): string {
  const now = formatDate(new Date());

  return `---
title: ${def.name} Documentation Index
tier: reference
domains:
  - ${domain}
status: active
last_updated: '${now}'
version: '1.0.0'
purpose: Complete listing of ${domain} documentation
---

# ${def.name} Documentation

> ${def.description}

## Overview

- **Domain:** \`${domain}/\`
- **Category:** ${def.category}
- **Load Priority:** ${def.loadPriority}/10

## Documents

*No documents in this domain yet.*

### Adding Documents

1. Create a markdown file in this directory
2. Add YAML frontmatter with required metadata:

\`\`\`yaml
---
title: "Your Document Title"
tier: guide
domains:
  - ${domain}
status: draft
last_updated: '${now}'
version: '1.0.0'
---
\`\`\`

3. Run \`npx hit-em-with-the-docs integrate <file>\` to register

## Keywords

This domain covers topics related to:

${def.keywords.map((k) => `- ${k}`).join('\n')}

## Related Resources

- [Domain Registry](REGISTRY.md) - Quick reference
- [Root Index](../INDEX.md) - All documentation

---

*Last updated: ${now}*
`;
}
