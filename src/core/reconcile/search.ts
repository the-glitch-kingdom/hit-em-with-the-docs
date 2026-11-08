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
const BM25_B = 0.75;

export const extract_tokens = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token && !STOP.has(token));

const normalize_strings = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(normalize_strings) : value && typeof value === 'object' ? Object.values(value).flatMap(normalize_strings) : [];

async function list_markdown_files(dir_path: string, found: string[] = []): Promise<string[]> {
  for (const entry of (await readdir(dir_path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const path_text = join(dir_path, entry.name);
    if (entry.isDirectory()) await list_markdown_files(path_text, found);
    else if (entry.name.endsWith('.md') && entry.name !== 'INDEX.md' && entry.name !== 'REGISTRY.md') found.push(path_text);
  }
  return found;
}

interface Indexed { path: string; fields: Record<Field, string[]> }

async function load_search_index(docs_path: string, config?: PluginConfig): Promise<Indexed[]> {
  const found: Indexed[] = [];
  for (const abs_path of await list_markdown_files(docs_path)) {
    const raw_text = readFileSync(abs_path, 'utf-8');
    const doc_path = relative(docs_path, abs_path).split('\\').join('/');
    const { data, content } = parse_frontmatter<Record<string, unknown>>(raw_text);
    if (data.generated === true || data.tier === 'plan' || basename(doc_path) === 'INDEX.md') continue;
    if (config && find_secrets(raw_text, doc_path, config.reconcile.secrets).some((result) => result.finding.kind === 'secret')) continue;
    const lines = content.split('\n');
    found.push({
      path: doc_path,
      fields: {
        title: extract_tokens(normalize_strings(data.title).join(' ')),
        purpose: extract_tokens(normalize_strings(data.purpose).join(' ')),
        symptoms: extract_tokens(normalize_strings(data.symptoms).join(' ')),
        headings: extract_tokens(lines.filter((line) => /^#{1,6}\s/.test(line)).join(' ')),
        body: extract_tokens(content),
      },
    });
  }
  return found;
}

function run_command(template: string, query: string): string[] {
  const [bin, ...args] = template.trim().split(/\s+/).map((a) => a.split('{query}').join(query));
  const found = execFileSync(bin!, args, { encoding: 'utf-8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return found.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** BM25F-style ranking; ties break on path so the order is deterministic. */
export async function find_docs(
  docs_path: string,
  query: string,
  options: { limit?: number; config?: PluginConfig } = {}
): Promise<SearchHit[]> {
  const limit = options.limit ?? 10;
  const docs = await load_search_index(docs_path, options.config);
  const query_tokens = [...new Set(extract_tokens(query))];
  const compute_effective_weight = (doc: Indexed): number => (Object.keys(WEIGHTS) as Field[]).reduce((total, key) => total + WEIGHTS[key] * doc.fields[key].length, 0);
  const average_weight = docs.reduce((total, doc) => total + compute_effective_weight(doc), 0) / (docs.length || 1) || 1;
  const document_frequency = new Map(query_tokens.map((token) => [token, docs.filter((doc) => (Object.keys(WEIGHTS) as Field[]).some((key) => doc.fields[key].includes(token))).length]));

  const ranked: SearchHit[] = [];
  for (const doc of docs) {
    let score = 0;
    const matched = new Set<string>();
    for (const token of query_tokens) {
      let term_frequency = 0;
      for (const field_token of Object.keys(WEIGHTS) as Field[]) {
        const field_count = doc.fields[field_token].filter((field) => field === token).length;
        if (field_count) { term_frequency += WEIGHTS[field_token] * field_count; matched.add(field_token); }
      }
      if (!term_frequency) continue;
      const document_count = document_frequency.get(token)!;
      const inverse_frequency = Math.log(1 + (docs.length - document_count + 0.5) / (document_count + 0.5));
      score += inverse_frequency * ((term_frequency * (K1 + 1)) / (term_frequency + K1 * (1 - BM25_B + (BM25_B * compute_effective_weight(doc)) / average_weight)));
    }
    if (score > 0) ranked.push({ path: doc.path, score, matched: [...matched].sort() });
  }
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const search_command = options.config?.reconcile.search_command;
  const command_hits: SearchHit[] = [];
  if (search_command) {
    try {
      const known = new Set(docs.map((doc) => doc.path));
      for (const line of run_command(search_command, query)) {
        const doc_path = (isAbsolute(line) ? relative(docs_path, line) : line).split('\\').join('/').replace(/^\.\//, '');
        if (known.has(doc_path) && !command_hits.some((command_hit) => command_hit.path === doc_path)) command_hits.push({ path: doc_path, score: Infinity, matched: ['search_command'] });
      }
    } catch (error) {
      console.warn(`hewtd: reconcile.search_command failed (${(error as Error).message.split('\n')[0]}); using the built-in ranking`);
    }
  }
  return [...command_hits, ...ranked.filter((ranked_hit) => !command_hits.some((command_hit) => command_hit.path === ranked_hit.path))].slice(0, limit);
}
