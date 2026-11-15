/**
 * Merge and generated-reference hint (#113). Misses that resolve to the same doc, or to the same source files,
 * become one proposal listing every question it closes; a list the code already declares (routes, schedules,
 * alert rules, CLI flags, config keys) gets a "generate it" suggestion instead of prose that will go stale.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { Decision, DecisionKind } from './decide.js';
import { compile_facet, parse_position_facet, test_facet } from './facets.js';
import type { FacetHit } from './locate.js';

export interface DeclaredList { kind: 'routes' | 'schedules' | 'alert-rules' | 'cli-flags' | 'config-keys'; file: string; count: number; suggestion: string;
  /** Missing facets that are entries of this list (the hint answers them); absent: every facet. */
  covers?: string[] }
export interface Proposal {
  kind: DecisionKind;
  doc?: string;
  domain?: string;
  /** new: the folder (possibly a subfolder of the domain) holding the docs about nearby code. */
  folder?: string;
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

/** Misses on one file tie only when their lines are this close (#120): a shortcut for "same block or symbol"; upgrade to enclosing-symbol detection if it merges too much. */
const FILE_TIE_WINDOW = 30;
export interface MergeOptions {
  /** Files that declare a list (schedules, routes, alert rules, flags, keys): their entries are unrelated, so the file never ties misses. */
  declared_files?: Set<string>;
  /** Whether a doc holds one of the facets or cites one of the files: an extend doc is never given to misses it does not speak to. */
  doc_holds?: (doc: string, facets: string[], files: string[]) => boolean;
}

export function merge_decisions(decisions: Decision[], options: MergeOptions = {}): Proposal[] {
  const sorted = [...decisions].sort((a, b) => a.key.localeCompare(b.key));
  // union-find over decisions: same doc, or nearby lines of a shared source file, or the same instruction files
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const owner = new Map<string, number>();
  // the target doc of each group: two groups extending different docs never merge (each miss keeps its own doc)
  const group_doc = sorted.map((decision) => (decision.kind === 'extend' ? decision.doc : undefined));
  const group_facets = sorted.map((decision) => [...decision.missing_facets]);
  const group_files = sorted.map((decision) => [...decision.source_files]);
  const join_groups = (i: number, j: number): void => {
    const [root, other] = [find(i), find(j)];
    if (root === other) return;
    const [doc_a, doc_b] = [group_doc[root], group_doc[other]];
    if (doc_a && doc_b && doc_a !== doc_b) return;
    // a group with no doc never inherits one that holds none of its facets (#120)
    if (options.doc_holds && (doc_a ? !doc_b : !!doc_b) && !options.doc_holds((doc_a ?? doc_b)!, group_facets[doc_a ? other : root]!, group_files[doc_a ? other : root]!)) return;
    parent[root] = other;
    group_doc[other] ??= doc_a;
    group_facets[other] = [...group_facets[other]!, ...group_facets[root]!];
    group_files[other] = [...group_files[other]!, ...group_files[root]!];
  };
  const tie = (key: string, i: number): void => {
    const seen = owner.get(key);
    if (seen === undefined) return void owner.set(key, i);
    join_groups(i, seen);
  };
  const lines_in = (i: number, file: string): number[] => sorted[i]!.sources.filter((found) => found.file === file).map((found) => found.line);
  const members_of = new Map<string, number[]>();
  sorted.forEach((decision, i) => {
    if (decision.kind === 'covered') tie(`covered:${decision.doc}`, i);
    else if (decision.kind === 'instruction-only') tie(`instruction:${(decision.instruction_files ?? []).join(',')}`, i);
    else {
      if (decision.doc && !decision.hub) tie(`doc:${decision.doc}`, i);
      for (const file of decision.source_files) {
        if (options.declared_files?.has(file)) continue;
        const mine = lines_in(i, file);
        for (const j of members_of.get(file) ?? []) {
          const theirs = lines_in(j, file);
          if (!mine.length || !theirs.length || mine.some((line) => theirs.some((other) => Math.abs(line - other) <= FILE_TIE_WINDOW))) join_groups(i, j);
        }
        members_of.set(file, [...(members_of.get(file) ?? []), i]);
      }
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
    const placed = group.find((decision) => decision.domain);
    const domain = placed?.domain;
    const sources = group.flatMap((decision) => decision.sources).filter((found, i, all) => all.findIndex((other) => other.file === found.file && other.line === found.line) === i);
    return {
      kind,
      ...(doc && { doc }),
      ...(kind === 'new' && domain && { domain }),
      ...(kind === 'new' && placed?.folder && { folder: placed.folder }),
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

/** Lines around an entry's own line that still belong to it (a schedule's task name sits beside its cron string). */
const ENTRY_WINDOW = 1;

/**
 * Declared lists in the located source files, by kind then file. Counts and names only; no value is read out.
 * With `facets`, a list is reported only when some facet is one of its entries (the facet matches a line within an
 * entry, or is the position of one), and `covers` names those facets.
 */
export function detect_declared_lists(files: Map<string, string>, facets?: string[]): DeclaredList[] {
  const found: DeclaredList[] = [];
  for (const [file, text] of files) {
    const lines = text.split('\n');
    for (const list of LISTS) {
      const matches = [...text.matchAll(list.pattern)];
      const count = list.unique_names ? new Set(matches.map((match) => match[1])).size : matches.length;
      if (count < DECLARED_LIST_MIN) continue;
      const entry_lines = new Set(matches.map((match) => text.slice(0, match.index).split('\n').length));
      const near = (line: number): boolean => [...entry_lines].some((entry) => Math.abs(entry - line) <= ENTRY_WINDOW);
      const covers = facets?.filter((facet) => {
        const position = parse_position_facet(facet);
        if (position) return position.file === file && near(position.line);
        const regex = compile_facet(facet).regex;
        return !!regex && lines.some((line, i) => near(i + 1) && test_facet(regex, line));
      });
      if (covers && !covers.length) continue;
      found.push({ kind: list.kind, file, count, suggestion: `${file} declares ${count} ${list.what}: generate the reference from the code (or point the doc at it) instead of writing them out, so it cannot go stale`, ...(covers && { covers }) });
    }
  }
  return found.sort((a, b) => a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file));
}

/** Files, among those the decisions located, that declare a list (3 or more entries). */
export async function find_declared_files(repo_root: string, decisions: Decision[]): Promise<Set<string>> {
  const texts = new Map<string, string>();
  for (const file of new Set(decisions.flatMap((decision) => decision.source_files))) {
    try { texts.set(file, await readFile(join(repo_root, file), 'utf-8')); } catch { /* deleted since it was located */ }
  }
  return new Set(detect_declared_lists(texts).map((list) => list.file));
}

/** Read each proposal's located files and attach the declared lists they hold. */
export async function add_generated_references(repo_root: string, proposals: Proposal[]): Promise<Proposal[]> {
  for (const proposal of proposals) {
    const texts = new Map<string, string>();
    for (const file of proposal.source_files) {
      try { texts.set(file, await readFile(join(repo_root, file), 'utf-8')); } catch { /* deleted since it was located */ }
    }
    proposal.generated_reference = detect_declared_lists(texts, proposal.missing_facets);
  }
  return proposals;
}
