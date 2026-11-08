import type { Domain, DomainDefinition } from '../../core/domains/constants.js';
import { format_date } from '../../core/metadata/generator.js';

/**
 * Generate initial domain INDEX.md content
 */
export function generate_domain_index(domain: Domain, definition: DomainDefinition): string {
  const today = format_date(new Date());

  return `---
title: ${definition.name} Documentation Index
tier: reference
domains:
  - ${domain}
status: active
last_updated: '${today}'
version: '1.0.0'
generated: true
purpose: Complete listing of ${domain} documentation
---

# ${definition.name} Documentation

> ${definition.description}

## Overview

- **Domain:** \`${domain}/\`
- **Category:** ${definition.category}
- **Load Priority:** ${definition.loadPriority}/10

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
last_updated: '${today}'
version: '1.0.0'
---
\`\`\`

3. Run \`npx hit-em-with-the-docs integrate <file>\` to register

## Keywords

This domain covers topics related to:

${definition.keywords.map((keyword) => `- ${keyword}`).join('\n')}

## Related Resources

- [Domain Registry](REGISTRY.md) - Quick reference
- [Root Index](../INDEX.md) - All documentation

---

*Last updated: ${today}*
`;
}
