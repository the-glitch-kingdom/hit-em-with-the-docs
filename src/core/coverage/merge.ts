/**
 * Merge and generated-reference hint (#113). Misses that resolve to the same doc, or to the same source files,
 * become one proposal listing every question it closes; a list the code already declares (routes, schedules,
 * alert rules, CLI flags, config keys) gets a "generate it" suggestion instead of prose that will go stale.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { Decision, DecisionKind } from './decide.js';
import type { FacetHit } from './locate.js';

export interface DeclaredList { kind: 'routes' | 'schedules' | 'alert-rules' | 'cli-flags' | 'config-keys'; file: string; count: number; suggestion: string }
export interface Proposal {
  kind: DecisionKind;
  doc?: string;
  domain?: string;
  /** Every question this proposal closes. */
  closes: { key: string; query: string; count: number }[];
  count: number;
  missing_facets: string[];
  sources: FacetHit[];
  source_files: string[];
  cited_by: string[];
  instruction_files: string[];
  flags: string[];
  notes: string[];
  blind?: boolean;
  generated_reference: DeclaredList[];
}

const unique = <T>(items: T[]): T[] => [...new Set(items)];

export function merge_decisions(decisions: Decision[]): Proposal[] {
  const sorted = [...decisions].sort((a, b) => a.key.localeCompare(b.key));
  // union-find over decisions: same doc, or a shared source file, or the same instruction files
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const owner = new Map<string, number>();
  // the target doc of each group: two groups extending different docs never merge (each miss keeps its own doc)
  const group_doc = sorted.map((decision) => (decision.kind === 'extend' ? decision.doc : undefined));
  const tie = (key: string, i: number): void => {
    const seen = owner.get(key);
    if (seen === undefined) return void owner.set(key, i);
    const [root, other] = [find(i), find(seen)];
    if (root === other || (group_doc[root] && group_doc[other] && group_doc[root] !== group_doc[other])) return;
    parent[root] = other;
    group_doc[other] ??= group_doc[root];
  };
  sorted.forEach((decision, i) => {
    if (decision.kind === 'covered') tie(`covered:${decision.doc}`, i);
    else if (decision.kind === 'instruction-only') tie(`instruction:${(decision.instruction_files ?? []).join(',')}`, i);
    else {
      if (decision.doc) tie(`doc:${decision.doc}`, i);
      for (const file of decision.source_files) tie(`file:${file}`, i);
      if (!decision.doc && !decision.source_files.length) tie(`alone:${decision.key}`, i);
    }
  });
  const groups = new Map<number, Decision[]>();
  sorted.forEach((decision, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), decision]));

  return [...groups.values()].map((group): Proposal => {
    const extends_in_group = group.filter((decision) => decision.kind === 'extend');
    const kind: DecisionKind = group[0]!.kind === 'covered' || group[0]!.kind === 'instruction-only' ? group[0]!.kind : extends_in_group.length ? 'extend' : 'new';
    const doc_votes = new Map<string, number>();
    for (const decision of extends_in_group) doc_votes.set(decision.doc!, (doc_votes.get(decision.doc!) ?? 0) + 1);
    const doc = kind === 'covered' ? group[0]!.doc : [...doc_votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    const domain = group.find((decision) => decision.domain)?.domain;
    const sources = group.flatMap((decision) => decision.sources).filter((found, i, all) => all.findIndex((other) => other.file === found.file && other.line === found.line) === i);
    return {
      kind,
      ...(doc && { doc }),
      ...(kind === 'new' && domain && { domain }),
      closes: group.map((decision) => ({ key: decision.key, query: decision.query, count: decision.count })),
      count: group.reduce((sum, decision) => sum + decision.count, 0),
      missing_facets: unique(group.flatMap((decision) => decision.missing_facets)),
      sources,
      source_files: unique(sources.map((found) => found.file)).sort(),
      cited_by: unique(group.flatMap((decision) => decision.cited_by)).sort(),
      instruction_files: unique(group.flatMap((decision) => decision.instruction_files ?? [])).sort(),
      flags: unique(group.flatMap((decision) => decision.flags)),
      notes: unique(group.flatMap((decision) => decision.notes)),
      ...(group.some((decision) => decision.blind) && { blind: true }),
      generated_reference: [],
    };
  }).sort((a, b) => b.count - a.count || a.closes[0]!.key.localeCompare(b.closes[0]!.key));
}

/** Fewer entries than this are prose; from here a generated reference stays right when the code changes. */
export const DECLARED_LIST_MIN = 3;
const LISTS: Array<{ kind: DeclaredList['kind']; pattern: RegExp; what: string; unique_names?: boolean }> = [
  { kind: 'routes', pattern: /(?:\b(?:app|router|server)\.(?:get|post|put|patch|delete)\s*\(\s*['"`]\/|@(?:app|router)\.(?:route|get|post|put|delete)\(|@(?:Get|Post|Put|Delete|Patch)\()/g, what: 'routes' },
  { kind: 'schedules', pattern: /['"`]\s*[\d*/,-]+\s+[\d*/,-]+\s+[\d*?/,-]+\s+[\d*A-Za-z/,-]+\s+[\d*?A-Za-z/,-]+\s*['"`]/g, what: 'schedules' },
  { kind: 'alert-rules', pattern: /^\s*-?\s*alert:\s*\S+/gm, what: 'alert rules' },
  { kind: 'cli-flags', pattern: /(?:\.option\(\s*['"]-|add_argument\(\s*['"]--)/g, what: 'CLI flags' },
  { kind: 'config-keys', pattern: /(?:process\.env\.|os\.environ(?:\.get)?[[(]\s*['"]?)([A-Z][A-Z0-9_]{2,})/g, what: 'config keys', unique_names: true },
];

/** Declared lists in the located source files, by kind then file. Counts and names only; no value is read out. */
export function detect_declared_lists(files: Map<string, string>): DeclaredList[] {
  const found: DeclaredList[] = [];
  for (const [file, text] of files) {
    for (const list of LISTS) {
      const matches = [...text.matchAll(list.pattern)];
      const count = list.unique_names ? new Set(matches.map((match) => match[1])).size : matches.length;
      if (count >= DECLARED_LIST_MIN) found.push({ kind: list.kind, file, count, suggestion: `${file} declares ${count} ${list.what}: generate the reference from the code (or point the doc at it) instead of writing them out, so it cannot go stale` });
    }
  }
  return found.sort((a, b) => a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file));
}

/** Read each proposal's located files and attach the declared lists they hold. */
export async function add_generated_references(repo_root: string, proposals: Proposal[]): Promise<Proposal[]> {
  for (const proposal of proposals) {
    const texts = new Map<string, string>();
    for (const file of proposal.source_files) {
      try { texts.set(file, await readFile(join(repo_root, file), 'utf-8')); } catch { /* deleted since it was located */ }
    }
    proposal.generated_reference = detect_declared_lists(texts);
  }
  return proposals;
}
