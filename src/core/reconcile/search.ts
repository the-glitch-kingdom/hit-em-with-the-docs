/**
 * Ranked doc search (#59): BM25 over non-generated docs, field-weighted, plus an
 * optional `reconcile.search_command` whose results come first. Never indexes
 * `sources` (verification-only) or secret-lane docs.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { readdir } from 'fs/promises';
import { basename, isAbsolute, join, relative } from 'path';
import { parse_frontmatter } from '../../utils/frontmatter.js';
import type { PluginConfig } from '../../utils/config.js';
import { find_secrets } from './secrets.js';

export interface SearchHit { path: string; score: number; matched: string[] }

const STOP = new Set('a an and are as at be but by can do does for from how i if in is it its my no not of on or so that the this to was we what when where which why will with you your'.split(' '));
const SKIP_DIRS = new Set(['archive', 'drafts']);
const WEIGHTS = { title: 3, purpose: 3, symptoms: 3, headings: 2, body: 1 } as const;
type Field = keyof typeof WEIGHTS;
const K1 = 1.2;
const B = 0.75;

export const tokenize = (s: string): string[] =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t));

const strings = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.endsWith('.md') && e.name !== 'INDEX.md' && e.name !== 'REGISTRY.md') out.push(p);
  }
  return out;
}

interface Indexed { path: string; fields: Record<Field, string[]> }

async function index_docs(docs_path: string, config?: PluginConfig): Promise<Indexed[]> {
  const out: Indexed[] = [];
  for (const abs of await walk(docs_path)) {
    const raw = readFileSync(abs, 'utf-8');
    const rel = relative(docs_path, abs).split('\\').join('/');
    const { data, content } = parse_frontmatter<Record<string, unknown>>(raw);
    if (data.generated === true || data.tier === 'plan' || basename(rel) === 'INDEX.md') continue;
    if (config && find_secrets(raw, rel, config.reconcile.secrets).some((r) => r.finding.kind === 'secret')) continue;
    const lines = content.split('\n');
    out.push({
      path: rel,
      fields: {
        title: tokenize(strings(data.title).join(' ')),
        purpose: tokenize(strings(data.purpose).join(' ')),
        symptoms: tokenize(strings(data.symptoms).join(' ')),
        headings: tokenize(lines.filter((l) => /^#{1,6}\s/.test(l)).join(' ')),
        body: tokenize(content),
      },
    });
  }
  return out;
}

function run_command(template: string, query: string): string[] {
  const [bin, ...args] = template.trim().split(/\s+/).map((a) => a.split('{query}').join(query));
  const out = execFileSync(bin!, args, { encoding: 'utf-8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** BM25F-style ranking; ties break on path so the order is deterministic. */
export async function search_docs(
  docs_path: string,
  query: string,
  opts: { limit?: number; config?: PluginConfig } = {}
): Promise<SearchHit[]> {
  const limit = opts.limit ?? 10;
  const docs = await index_docs(docs_path, opts.config);
  const q = [...new Set(tokenize(query))];
  const eff = (d: Indexed): number => (Object.keys(WEIGHTS) as Field[]).reduce((n, f) => n + WEIGHTS[f] * d.fields[f].length, 0);
  const avg = docs.reduce((n, d) => n + eff(d), 0) / (docs.length || 1) || 1;
  const df = new Map(q.map((t) => [t, docs.filter((d) => (Object.keys(WEIGHTS) as Field[]).some((f) => d.fields[f].includes(t))).length]));

  const bm: SearchHit[] = [];
  for (const d of docs) {
    let score = 0;
    const matched = new Set<string>();
    for (const t of q) {
      let tf = 0;
      for (const f of Object.keys(WEIGHTS) as Field[]) {
        const c = d.fields[f].filter((x) => x === t).length;
        if (c) { tf += WEIGHTS[f] * c; matched.add(f); }
      }
      if (!tf) continue;
      const n = df.get(t)!;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * eff(d)) / avg)));
    }
    if (score > 0) bm.push({ path: d.path, score, matched: [...matched].sort() });
  }
  bm.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const cmd = opts.config?.reconcile.search_command;
  const first: SearchHit[] = [];
  if (cmd) {
    try {
      const known = new Set(docs.map((d) => d.path));
      for (const line of run_command(cmd, query)) {
        const rel = (isAbsolute(line) ? relative(docs_path, line) : line).split('\\').join('/').replace(/^\.\//, '');
        if (known.has(rel) && !first.some((h) => h.path === rel)) first.push({ path: rel, score: Infinity, matched: ['search_command'] });
      }
    } catch (e) {
      console.warn(`hewtd: reconcile.search_command failed (${(e as Error).message.split('\n')[0]}); using the built-in ranking`);
    }
  }
  return [...first, ...bm.filter((h) => !first.some((f) => f.path === h.path))].slice(0, limit);
}
