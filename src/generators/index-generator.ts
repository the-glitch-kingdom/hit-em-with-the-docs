import { type Domain } from '../core/domains/constants.js';
import { get_all_domains, get_domain_definition } from '../core/domains/registry.js';
import { format_date } from '../core/metadata/generator.js';

export interface IndexEntry {
  path: string;
  title: string;
  tier: string;
  status: string;
  last_updated: string;
  word_count?: number;
  description?: string;
  purpose?: string;
}

/** One-line, pipe-safe table cell; empty when missing. */
function format_purpose_cell(purpose?: string): string {
  return (purpose ?? '').replace(/\s+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/**
 * Generate the root INDEX.md content
 */
export function generate_root_index(entries?: Record<Domain, IndexEntry[]>): string {
  const today = format_date(new Date());

  let content = `---
title: Documentation Index
tier: reference
domains: [root]
status: active
last_updated: '${today}'
version: '1.0.0'
generated: true
purpose: Navigation hub for all documentation
---

# Documentation Index

> Complete listing of all documentation organized by domain.

## Overview

| Domain | Documents | Description |
|--------|-----------|-------------|
`;

  // Add domain rows
  for (const domain of get_all_domains()) {
    const definition = get_domain_definition(domain);
    const count = entries?.[domain]?.length ?? 0;
    content += `| [${definition.name}](#${domain}) | ${count} | ${definition.description} |\n`;
  }

  content += `\n---\n\n`;

  // Add domain sections
  for (const domain of get_all_domains()) {
    const definition = get_domain_definition(domain);
    const domain_entries = entries?.[domain] ?? [];

    content += `## ${definition.name}\n\n`;
    content += `> ${definition.description}\n\n`;
    content += `**Path:** \`${domain}/\`\n\n`;

    if (domain_entries.length === 0) {
      content += `*No documents yet.*\n\n`;
    } else {
      content += `| Document | Tier | Status | Updated | Purpose |\n`;
      content += `|----------|------|--------|----------|---------|\n`;

      for (const entry of domain_entries) {
        content += `| [${entry.title}](${entry.path}) | ${entry.tier} | ${entry.status} | ${entry.last_updated} | ${format_purpose_cell(entry.purpose)} |\n`;
      }
      content += `\n`;
    }

    content += `---\n\n`;
  }

  // Footer
  content += `## Maintenance\n\n`;
  content += `- **Last generated:** ${today}\n`;
  content += `- **Run maintenance:** \`npx hit-em-with-the-docs maintain\`\n`;
  content += `- **Regenerate index:** \`npx hit-em-with-the-docs index\`\n`;

  return content;
}

/**
 * Generate a domain-specific INDEX.md content
 */
export function generate_domain_index_content(
  domain: Domain,
  entries: IndexEntry[] = [],
  /** Domains whose folder exists — only these are linked as related (#45). */
  present: Domain[] = get_all_domains()
): string {
  const definition = get_domain_definition(domain);
  const today = format_date(new Date());

  let content = `---
title: ${definition.name} Documentation Index
tier: reference
domains: [${domain}]
status: active
last_updated: '${today}'
version: '1.0.0'
generated: true
purpose: Complete listing of ${domain} documentation
---

# ${definition.name} Documentation

> ${definition.description}

## Overview

- **Total Documents:** ${entries.length}
- **Domain:** \`${domain}/\`
- **Category:** ${definition.category}
- **Load Priority:** ${definition.loadPriority}/10

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
    const by_tier = group_by_tier(entries);

    for (const [tier, tier_entries] of Object.entries(by_tier)) {
      if (tier_entries.length === 0) continue;

      content += `### ${format_capitalized(tier)}s\n\n`;
      content += `| Document | Status | Updated | Words | Purpose |\n`;
      content += `|----------|--------|---------|-------|---------|\n`;

      for (const entry of tier_entries) {
        const words = entry.word_count ? entry.word_count.toLocaleString() : '-';
        content += `| [${entry.title}](${entry.path}) | ${entry.status} | ${entry.last_updated} | ${words} | ${format_purpose_cell(entry.purpose)} |\n`;
      }
      content += `\n`;
    }
  }

  // Keywords section
  content += `## Keywords\n\n`;
  content += `This domain covers: ${definition.keywords.slice(0, 10).join(', ')}\n\n`;

  // Related domains
  const related_domains = find_related_domains(domain, present);
  if (related_domains.length > 0) {
    content += `## Related Domains\n\n`;
    for (const related_domain of related_domains) {
      const related_def = get_domain_definition(related_domain);
      content += `- [${related_def.name}](../${related_domain}/) - ${related_def.description}\n`;
    }
    content += `\n`;
  }

  // Footer
  content += `---\n\n`;
  content += `*Last updated: ${today}*\n`;

  return content;
}

/**
 * Group entries by tier
 */
function group_by_tier(entries: IndexEntry[]): Record<string, IndexEntry[]> {
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
function find_related_domains(domain: Domain, present: Domain[]): Domain[] {
  const definition = get_domain_definition(domain);
  const scored_domains: { domain: Domain; score: number }[] = [];

  for (const other of present) {
    if (other === domain) continue;

    const other_def = get_domain_definition(other);
    let score = 0;

    // Check keyword overlap
    for (const keyword of definition.keywords) {
      if (other_def.keywords.includes(keyword)) {
        score++;
      }
    }

    // Check category match
    if (definition.category === other_def.category) {
      score += 2;
    }

    if (score > 0) {
      scored_domains.push({ domain: other, score });
    }
  }

  // Sort by score and return top 3
  return scored_domains
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((scored) => scored.domain);
}

/**
 * Capitalize first letter
 */
function format_capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
