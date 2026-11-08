import type { Domain } from '../../core/domains/constants.js';
import type { Tier } from '../../core/domains/classifier.js';
import { format_date } from '../../core/metadata/generator.js';

export interface DocumentTemplateOptions {
  title: string;
  tier?: Tier;
  domain?: Domain;
  author?: string;
  tags?: string[];
  /** One sentence: the question this doc answers. Omitted -> commented guidance. */
  purpose?: string;
}

/**
 * Generate a new document template with frontmatter
 */
export function generate_document_template(options: DocumentTemplateOptions): string {
  const {
    title,
    tier = 'guide',
    domain = 'features',
    author,
    tags = [],
    purpose,
  } = options;

  const today = format_date(new Date());

  let frontmatter = `---
title: "${title}"
tier: ${tier}
domains:
  - ${domain}
audience:
  - all
tags:
${tags.length > 0 ? tags.map((tag) => `  - ${tag}`).join('\n') : '  []'}
status: draft
last_updated: '${today}'
version: '1.0.0'
${
  purpose
    ? `purpose: ${JSON.stringify(purpose)}\n`
    : `# purpose: One sentence naming the question this doc answers.\n`
}# symptoms:   # optional: how someone describes the problem, or literal error text
#   - "plain phrase or error message"
`;

  if (author) {
    frontmatter += `author: "${author}"\n`;
  }

  frontmatter += `---`;

  const body = get_template_body(tier, title);

  return `${frontmatter}\n\n${body}`;
}

/**
 * Get tier-specific template body
 */
function get_template_body(tier: Tier, title: string): string {
  switch (tier) {
    case 'guide':
      return get_guide_template(title);
    case 'standard':
      return get_standard_template(title);
    case 'example':
      return get_example_template(title);
    case 'reference':
      return get_reference_template(title);
    case 'admin':
      return get_admin_template(title);
    default:
      return get_guide_template(title);
  }
}

function get_guide_template(title: string): string {
  return `# ${title}

## Overview

[Brief description of what this guide covers and who it's for.]

## Prerequisites

- [ ] Prerequisite 1
- [ ] Prerequisite 2

## Steps

### Step 1: [First Step Title]

[Instructions for the first step.]

\`\`\`bash
# Example command
\`\`\`

### Step 2: [Second Step Title]

[Instructions for the second step.]

### Step 3: [Third Step Title]

[Instructions for the third step.]

## Verification

To verify the setup is correct:

1. [Verification step 1]
2. [Verification step 2]

## Troubleshooting

### Common Issue 1

**Problem:** [Description]

**Solution:** [How to fix]

### Common Issue 2

**Problem:** [Description]

**Solution:** [How to fix]

## Related Documentation

- [Related Doc 1](path/to/doc1.md)
- [Related Doc 2](path/to/doc2.md)
`;
}

function get_standard_template(title: string): string {
  return `# ${title}

## Overview

[Description of what this standard covers and why it exists.]

## Rules

### Rule 1: [Rule Name]

**DO:**
- [Correct approach]

**DON'T:**
- [Incorrect approach]

**Example:**

\`\`\`typescript
// Good
const example = 'correct';

// Bad
const example = 'incorrect';
\`\`\`

### Rule 2: [Rule Name]

[Rule description and rationale.]

## Exceptions

[Any exceptions to these rules and when they apply.]

## Enforcement

- [ ] Automated by linter
- [ ] Checked in code review
- [ ] Manual verification required

## References

- [External Reference 1](https://example.com)
- [Related Standard](path/to/standard.md)
`;
}

function get_example_template(title: string): string {
  return `# ${title}

## Overview

[Brief description of what this example demonstrates.]

## Use Case

[When you would use this pattern/approach.]

## Code Example

\`\`\`typescript
// Example implementation
function example() {
  // Your code here
}
\`\`\`

## Explanation

1. **Line X:** [Explanation of what this part does]
2. **Line Y:** [Explanation of what this part does]

## Variations

### Variation 1: [Name]

\`\`\`typescript
// Alternative approach
\`\`\`

## Related Examples

- [Related Example 1](path/to/example1.md)
- [Related Example 2](path/to/example2.md)
`;
}

function get_reference_template(title: string): string {
  return `# ${title}

## Overview

[Description of what this reference documents.]

## API Reference

### Method/Function Name

\`\`\`typescript
function methodName(param1: Type, param2: Type): ReturnType
\`\`\`

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| param1 | Type | Yes | Description |
| param2 | Type | No | Description |

**Returns:**

\`ReturnType\` - Description of return value.

**Example:**

\`\`\`typescript
const result = methodName('value1', 'value2');
\`\`\`

## Types

### TypeName

\`\`\`typescript
interface TypeName {
  property1: string;
  property2: number;
}
\`\`\`

## Constants

| Name | Value | Description |
|------|-------|-------------|
| CONSTANT_1 | 'value' | Description |

## See Also

- [Related Reference](path/to/reference.md)
`;
}

function get_admin_template(title: string): string {
  return `# ${title}

## Overview

[Description of this administrative procedure.]

## Prerequisites

- [ ] Required access/permissions
- [ ] Required tools installed

## Configuration

### Setting 1

\`\`\`yaml
# Configuration example
setting: value
\`\`\`

## Procedures

### Procedure 1: [Name]

1. [Step 1]
2. [Step 2]
3. [Step 3]

### Procedure 2: [Name]

1. [Step 1]
2. [Step 2]

## Monitoring

[How to monitor this system/service.]

## Backup & Recovery

### Backup Procedure

1. [Backup step 1]
2. [Backup step 2]

### Recovery Procedure

1. [Recovery step 1]
2. [Recovery step 2]

## Troubleshooting

| Symptom | Cause | Resolution |
|---------|-------|------------|
| [Symptom] | [Cause] | [Fix] |

## Related Documentation

- [Related Admin Doc](path/to/admin.md)
`;
}
