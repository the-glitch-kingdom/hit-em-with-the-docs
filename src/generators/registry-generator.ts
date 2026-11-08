import { type Domain } from '../core/domains/constants.js';
import {
  get_all_domains,
  get_domain_definition,
  get_domains_by_category,
} from '../core/domains/registry.js';
import { format_date } from '../core/metadata/generator.js';
import type { IndexEntry } from './index-generator.js';

const COMMON_TASKS: [string, Domain][] = [
  ['New developer setup', 'quickstart'],
  ['Coding standards', 'standards'],
  ['API development', 'api'],
  ['Security implementation', 'security'],
  ['Database changes', 'database'],
  ['Deployment', 'devops'],
  ['Troubleshooting', 'troubleshooting'],
];

/**
 * Generate the root REGISTRY.md content (quick reference)
 */
export function generate_root_registry(
  /** Domains whose folder exists — only these are linked (#45). */
  present: Domain[] = get_all_domains()
): string {
  const now = format_date(new Date());

  let content = `---
title: Documentation Registry
tier: reference
domains: [root]
status: active
last_updated: '${now}'
version: '1.0.0'
generated: true
purpose: Quick reference for all documentation domains
---

# Documentation Registry

> Quick reference tables for fast navigation.

## Domain Quick Reference

| Domain | Category | Priority | Keywords |
|--------|----------|----------|----------|
`;

  for (const domain of present) {
    const def = get_domain_definition(domain);
    const keywords = def.keywords.slice(0, 3).join(', ');
    content += `| [${def.name}](${domain}/) | ${def.category} | ${def.loadPriority}/10 | ${keywords} |\n`;
  }

  content += `\n## By Category\n\n`;

  // Group by category
  const categories = ['core', 'development', 'features', 'advanced'] as const;

  for (const category of categories) {
    const category_domains = get_domains_by_category(category).filter((d) => present.includes(d));
    if (category_domains.length === 0) continue;

    content += `### ${capitalize(category)}\n\n`;

    for (const domain of category_domains) {
      const def = get_domain_definition(domain);
      content += `- **[${def.name}](${domain}/)** - ${def.description}\n`;
    }
    content += `\n`;
  }

  const tasks = COMMON_TASKS.filter(([, domain]) => present.includes(domain));
  if (tasks.length > 0) {
    content += `## Common Tasks\n\n`;
    content += `| Task | Start Here |\n`;
    content += `|------|------------|\n`;
    for (const [task, domain] of tasks) {
      content += `| ${task} | [${domain}/](${domain}/) |\n`;
    }
  }

  content += `\n---\n\n`;
  content += `*Last updated: ${now}*\n`;

  return content;
}

/**
 * Generate domain-specific REGISTRY.md content
 */
export function generate_domain_registry_content(
  domain: Domain,
  entries: IndexEntry[] = []
): string {
  const def = get_domain_definition(domain);
  const now = format_date(new Date());

  let content = `---
title: ${def.name} Registry
tier: reference
domains: [${domain}]
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
| Documents | ${entries.length} |
| Category | ${def.category} |
| Load Priority | ${def.loadPriority}/10 |

`;

  if (entries.length > 0) {
    // Quick links to most important docs
    const active_entries = entries.filter((e) => e.status === 'active');
    const recent_entries = [...entries]
      .sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated))
      .slice(0, 5);

    if (active_entries.length > 0) {
      content += `## Active Documents\n\n`;
      for (const entry of active_entries.slice(0, 10)) {
        content += `- [${entry.title}](${entry.path})\n`;
      }
      content += `\n`;
    }

    if (recent_entries.length > 0) {
      content += `## Recently Updated\n\n`;
      for (const entry of recent_entries) {
        content += `- [${entry.title}](${entry.path}) - ${entry.lastUpdated}\n`;
      }
      content += `\n`;
    }

    // By status
    content += `## By Status\n\n`;
    const by_status = group_by_status(entries);
    content += `| Status | Count |\n`;
    content += `|--------|-------|\n`;
    for (const [status, status_entries] of Object.entries(by_status)) {
      content += `| ${status} | ${status_entries.length} |\n`;
    }
    content += `\n`;
  } else {
    content += `## Documents\n\n`;
    content += `*No documents in this domain yet.*\n\n`;
  }

  // Keywords
  content += `## Keywords\n\n`;
  content += `\`${def.keywords.join('` `')}\`\n\n`;

  // See also
  content += `## See Also\n\n`;
  content += `- [Full Index](INDEX.md) - Complete document listing\n`;
  content += `- [Root Index](../INDEX.md) - All domains\n`;

  content += `\n---\n\n`;
  content += `*Last updated: ${now}*\n`;

  return content;
}

/**
 * Group entries by status
 */
function group_by_status(entries: IndexEntry[]): Record<string, IndexEntry[]> {
  const grouped: Record<string, IndexEntry[]> = {
    active: [],
    draft: [],
    deprecated: [],
    archived: [],
  };

  for (const entry of entries) {
    const status = entry.status.toLowerCase();
    if (status in grouped) {
      grouped[status]!.push(entry);
    }
  }

  return grouped;
}

/**
 * Capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
