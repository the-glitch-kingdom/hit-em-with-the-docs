import { type Domain } from '../core/domains/constants.js';
import { getAllDomains, getDomainDefinition } from '../core/domains/registry.js';
import { formatDate } from '../core/metadata/generator.js';

export interface IndexEntry {
  path: string;
  title: string;
  tier: string;
  status: string;
  lastUpdated: string;
  wordCount?: number;
  description?: string;
}

/**
 * Generate the root INDEX.md content
 */
export function generateRootIndex(entries?: Record<Domain, IndexEntry[]>): string {
  const now = formatDate(new Date());

  let content = `---
title: Documentation Index
tier: reference
domains: [root]
status: active
last_updated: '${now}'
version: '1.0.0'
purpose: Navigation hub for all documentation
---

# Documentation Index

> Complete listing of all documentation organized by domain.

## Overview

| Domain | Documents | Description |
|--------|-----------|-------------|
`;

  // Add domain rows
  for (const domain of getAllDomains()) {
    const def = getDomainDefinition(domain);
    const count = entries?.[domain]?.length ?? 0;
    content += `| [${def.name}](#${domain}) | ${count} | ${def.description} |\n`;
  }

  content += `\n---\n\n`;

  // Add domain sections
  for (const domain of getAllDomains()) {
    const def = getDomainDefinition(domain);
    const domainEntries = entries?.[domain] ?? [];

    content += `## ${def.name}\n\n`;
    content += `> ${def.description}\n\n`;
    content += `**Path:** \`${domain}/\`\n\n`;

    if (domainEntries.length === 0) {
      content += `*No documents yet.*\n\n`;
    } else {
      content += `| Document | Tier | Status | Updated |\n`;
      content += `|----------|------|--------|----------|\n`;

      for (const entry of domainEntries) {
        content += `| [${entry.title}](${entry.path}) | ${entry.tier} | ${entry.status} | ${entry.lastUpdated} |\n`;
      }
      content += `\n`;
    }

    content += `---\n\n`;
  }

  // Footer
  content += `## Maintenance\n\n`;
  content += `- **Last generated:** ${now}\n`;
  content += `- **Run maintenance:** \`npx hit-em-with-the-docs maintain\`\n`;
  content += `- **Regenerate index:** \`npx hit-em-with-the-docs index\`\n`;

  return content;
}

/**
 * Generate a domain-specific INDEX.md content
 */
export function generateDomainIndexContent(
  domain: Domain,
  entries: IndexEntry[] = [],
  /** Domains whose folder exists — only these are linked as related (#45). */
  present: Domain[] = getAllDomains()
): string {
  const def = getDomainDefinition(domain);
  const now = formatDate(new Date());

  let content = `---
title: ${def.name} Documentation Index
tier: reference
domains: [${domain}]
status: active
last_updated: '${now}'
version: '1.0.0'
purpose: Complete listing of ${domain} documentation
---

# ${def.name} Documentation

> ${def.description}

## Overview

- **Total Documents:** ${entries.length}
- **Domain:** \`${domain}/\`
- **Category:** ${def.category}
- **Load Priority:** ${def.loadPriority}/10

## Documents

`;

  if (entries.length === 0) {
    content += `*No documents in this domain yet.*\n\n`;
    content += `To add a document:\n\n`;
    content += `1. Create a markdown file in this directory\n`;
    content += `2. Add YAML frontmatter with required metadata\n`;
    content += `3. Run \`npx hit-em-with-the-docs integrate <file>\`\n`;
  } else {
    // Group by tier
    const byTier = groupByTier(entries);

    for (const [tier, tierEntries] of Object.entries(byTier)) {
      if (tierEntries.length === 0) continue;

      content += `### ${capitalize(tier)}s\n\n`;
      content += `| Document | Status | Updated | Words |\n`;
      content += `|----------|--------|---------|-------|\n`;

      for (const entry of tierEntries) {
        const words = entry.wordCount ? entry.wordCount.toLocaleString() : '-';
        content += `| [${entry.title}](${entry.path}) | ${entry.status} | ${entry.lastUpdated} | ${words} |\n`;
      }
      content += `\n`;
    }
  }

  // Keywords section
  content += `## Keywords\n\n`;
  content += `This domain covers: ${def.keywords.slice(0, 10).join(', ')}\n\n`;

  // Related domains
  const relatedDomains = findRelatedDomains(domain, present);
  if (relatedDomains.length > 0) {
    content += `## Related Domains\n\n`;
    for (const related of relatedDomains) {
      const relatedDef = getDomainDefinition(related);
      content += `- [${relatedDef.name}](../${related}/) - ${relatedDef.description}\n`;
    }
    content += `\n`;
  }

  // Footer
  content += `---\n\n`;
  content += `*Last updated: ${now}*\n`;

  return content;
}

/**
 * Group entries by tier
 */
function groupByTier(entries: IndexEntry[]): Record<string, IndexEntry[]> {
  const grouped: Record<string, IndexEntry[]> = {
    guide: [],
    standard: [],
    example: [],
    reference: [],
    admin: [],
  };

  for (const entry of entries) {
    const tier = entry.tier.toLowerCase();
    if (tier in grouped) {
      grouped[tier]!.push(entry);
    } else {
      grouped['guide']!.push(entry);
    }
  }

  return grouped;
}

/**
 * Find related domains based on shared keywords
 */
function findRelatedDomains(domain: Domain, present: Domain[]): Domain[] {
  const def = getDomainDefinition(domain);
  const related: { domain: Domain; score: number }[] = [];

  for (const other of present) {
    if (other === domain) continue;

    const otherDef = getDomainDefinition(other);
    let score = 0;

    // Check keyword overlap
    for (const keyword of def.keywords) {
      if (otherDef.keywords.includes(keyword)) {
        score++;
      }
    }

    // Check category match
    if (def.category === otherDef.category) {
      score += 2;
    }

    if (score > 0) {
      related.push({ domain: other, score });
    }
  }

  // Sort by score and return top 3
  return related
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((r) => r.domain);
}

/**
 * Capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
