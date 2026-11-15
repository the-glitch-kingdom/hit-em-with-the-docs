/**
 * `hewtd coverage` (#117): grade every surface the code declares, then send the absent ones (and named ones that
 * carry behaviour) through the same engine as `reconcile --gaps`. A surface already has its file:line, so locating
 * is skipped. Lists the code declares (schedules, alert rules, routes, flags, config keys) get "generate the
 * reference" first instead of one draft per entry. Surfaces on the ignore list are held, never missed.
 * Read-only: it returns review entries, it writes nothing.
 */
import type { CoverageIgnore, PluginConfig } from '../../utils/config.js';
import { load_doc_texts } from './decide.js';
import { grade_surfaces, summarize_grades, type GradedSurface, type GradeSummary } from './grade.js';
import type { LocateResult, FacetHit } from './locate.js';
import { DECLARED_LIST_MIN, type DeclaredList } from './merge.js';
import { plan_coverage_misses, type CoveragePlan, type FacetGap } from './plan.js';
import { detect_surfaces, is_ignored, type Surface, type SurfaceKind } from './surfaces/index.js';

export interface HeldSurface { kind: SurfaceKind; name: string; file: string; reason?: string }
export interface GenerateReference extends DeclaredList { /** Entries in it no doc names yet. */ absent: number }
export interface CoverageReport {
  summary: GradeSummary;
  surfaces: GradedSurface[];
  held: { total: number; by_kind: Record<string, number>; entries: HeldSurface[] };
  generate_reference: GenerateReference[];
  /** Absent, or named with behaviour, and not in a declared list: what went through the engine. */
  triaged: number;
  plan?: CoveragePlan;
}

/** A named surface of these kinds still needs a sentence about what it does or holds. */
export const BEHAVIOUR_KINDS = new Set<SurfaceKind>(['scheduled-job', 'alert-rule', 'background-task', 'constant']);
const LIST_KIND: Partial<Record<SurfaceKind, { kind: DeclaredList['kind']; what: string }>> = {
  'scheduled-job': { kind: 'schedules', what: 'schedules' }, 'alert-rule': { kind: 'alert-rules', what: 'alert rules' }, 'http-route': { kind: 'routes', what: 'routes' },
  'cli-flag': { kind: 'cli-flags', what: 'CLI flags' }, 'config-key': { kind: 'config-keys', what: 'config keys' },
};
const KIND_LABEL: Record<SurfaceKind, string> = {
  'scheduled-job': 'scheduled job', 'alert-rule': 'alert rule', 'http-route': 'route', 'cli-command': 'command', 'cli-flag': 'flag', 'ci-workflow': 'CI workflow',
  'ci-job': 'CI job', 'background-task': 'background task', constant: 'constant', 'config-key': 'config key',
};

const escape_regex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Detect, split off the ignore list (held), grade the rest. */
export async function list_graded_surfaces(options: { repo_root: string; docs_root: string; config: PluginConfig }): Promise<{ graded: GradedSurface[]; held: HeldSurface[] }> {
  const { repo_root, docs_root, config } = options;
  const all = await detect_surfaces({ repo_root, docs_root, cold_root: config.reconcile.cold_root });
  const ignore: CoverageIgnore[] = config.coverage.ignore;
  const find_hold = (surface: Surface): CoverageIgnore | undefined => ignore.find((entry) => (entry.path && is_ignored(surface.file, [entry.path])) || (entry.name && entry.name === surface.name));
  const held: HeldSurface[] = [];
  const kept: Surface[] = [];
  for (const surface of all) {
    const hold = find_hold(surface);
    if (hold) held.push({ kind: surface.kind, name: surface.name, file: surface.file, ...(hold.reason && { reason: hold.reason }) });
    else kept.push(surface);
  }
  return { graded: grade_surfaces(kept, await load_doc_texts(docs_root)), held };
}

/** One miss per surface: the facet is its escaped name, and for a constant with a stateable value, the line `NAME = value`. */
function build_miss(surface: GradedSurface): { gap: FacetGap; facet: string } {
  const name = `(?<![\\w-])${escape_regex(surface.name)}(?![\\w-])`;
  const facet = surface.kind === 'constant' && surface.value !== undefined ? `${name}\\s*[:=]\\s*${escape_regex(surface.value).replace(/\\? /g, '\\s*')}` : name;
  const query = `What does the ${KIND_LABEL[surface.kind]} ${surface.name} do?`;
  return { gap: { id: `${surface.kind}:${surface.name}@${surface.file}`, query, facets: [facet] }, facet };
}

export async function run_coverage(options: { repo_root: string; docs_root: string; config: PluginConfig; today?: string }): Promise<CoverageReport> {
  const { graded, held } = await list_graded_surfaces(options);
  const summary = summarize_grades(graded);
  const held_by_kind: Record<string, number> = {};
  for (const entry of held) held_by_kind[entry.kind] = (held_by_kind[entry.kind] ?? 0) + 1;

  const todo = graded.filter((surface) => surface.grade === 'absent' || (surface.grade === 'named' && BEHAVIOUR_KINDS.has(surface.kind)));
  // a list the code declares: from DECLARED_LIST_MIN entries in one file, generate it instead of drafting entry by entry
  const list_counts = new Map<string, number>();
  for (const surface of graded) if (LIST_KIND[surface.kind]) list_counts.set(`${surface.kind}\0${surface.file}`, (list_counts.get(`${surface.kind}\0${surface.file}`) ?? 0) + 1);
  const generate = new Map<string, GenerateReference>();
  const drafted: GradedSurface[] = [];
  for (const surface of todo) {
    const key = `${surface.kind}\0${surface.file}`;
    const count = list_counts.get(key) ?? 0;
    const list = LIST_KIND[surface.kind];
    if (list && count >= DECLARED_LIST_MIN && surface.grade === 'absent') {
      const entry = generate.get(key) ?? { kind: list.kind, file: surface.file, count, absent: 0, suggestion: `${surface.file} declares ${count} ${list.what}: generate the reference from the code (or point the doc at it) instead of writing them out, so it cannot go stale` };
      entry.absent++;
      generate.set(key, entry);
    } else drafted.push(surface);
  }

  let plan: CoveragePlan | undefined;
  if (drafted.length) {
    const code = new Map<string, FacetHit[]>();
    const gaps = drafted.map((surface) => {
      const { gap, facet } = build_miss(surface);
      code.set(facet, [...(code.get(facet) ?? []), { file: surface.file, line: surface.line }]);
      return gap;
    });
    const located: LocateResult = { code, instructions: new Map(), weak: new Set() };
    plan = await plan_coverage_misses({ ...options, gaps, located });
  }
  return {
    summary, surfaces: graded, held: { total: held.length, by_kind: held_by_kind, entries: held },
    generate_reference: [...generate.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file)),
    triaged: drafted.length, ...(plan && { plan }),
  };
}

const pad = (text: string, width: number): string => text.padEnd(width);
/** The table `hewtd coverage` prints: per kind and per code area, absent / named / explained. */
export function render_coverage_table(report: CoverageReport): string {
  const row = (label: string, counts: { total: number; absent: number; named: number; explained: number }, held = 0): string =>
    `  ${pad(label, 18)}${pad(String(counts.total), 7)}${pad(String(counts.absent), 8)}${pad(String(counts.named), 7)}${pad(String(counts.explained), 10)}${held ? `${held} held` : ''}`.trimEnd();
  const head = `  ${pad('', 18)}${pad('total', 7)}${pad('absent', 8)}${pad('named', 7)}explained`;
  const lines = ['By kind', head, ...Object.entries(report.summary.by_kind).map(([kind, counts]) => row(kind, counts, report.held.by_kind[kind])), row('all', report.summary.total, report.held.total), '', 'By code area', head, ...Object.entries(report.summary.by_area).map(([area, counts]) => row(area, counts))];
  if (report.held.total) lines.push('', `${report.held.total} surface(s) held by coverage.ignore (counted apart, never missed)`);
  for (const list of report.generate_reference) lines.push('', `generate the reference first: ${list.suggestion} (${list.absent} of ${list.count} not named in any doc)`);
  return lines.join('\n');
}
