/**
 * Reconcile: list the concrete things a doc claims exist (paths, symbols, env vars,
 * commands, tables/columns, internal doc links) and whether each resolves in the repo.
 * Deterministic, no LLM. "unknown" means we could not check; it never means "missing".
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative, resolve } from 'path';
import { extract_links } from '../../utils/markdown.js';
import { check_single_link } from '../links/checker.js';

export type RefKind = 'path' | 'symbol' | 'env' | 'command' | 'table' | 'column' | 'doc-link';
export type RefStatus = 'ok' | 'missing' | 'unknown';
export interface Reference {
  // eslint-disable-next-line id-denylist -- serialized key (triage/graph JSON)
  ref: string;
  kind: RefKind;
  line: number;
}
export interface ResolvedReference extends Reference {
  status: RefStatus;
  where?: string;
  /** symbol refs only: `where` defines the name, or merely mentions it */
  whereKind?: 'definition' | 'reference';
}

// ---------- extraction ----------

const EXAMPLE_FENCE = /output|example|result|sample|stdout|response/i;
const SQL_FENCE = /^(sql|psql|pgsql|mysql|sqlite)\b/i;
const FILE_EXT = /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|md|mdx|sql|prisma|py|go|rs|rb|java|sh|css|html?|env|txt|lock|cfg|ini)$/i;
const NOT_COLUMN_OWNER_EXT = /^(?:[cm]?[jt]sx?|json|ya?ml|toml|md|sql|py|go|rs|rb|java|sh|css|html?|env|txt|prisma)$/i;
const ENV_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const SYMBOL_RE = /^[A-Za-z_$][\w$]*$/;
const CMD_RES: Array<[RegExp, string]> = [
  [/\bnpm run ([\w:.-]+)/g, 'npm run '],
  [/\bnpx (?:--?\w[\w-]* )*(@?[\w][\w@/.-]*)/g, 'npx '],
  [/\bmake ([\w.-]+)/g, 'make '],
];
const SQL_TABLE_RES = [
  /\b(?:FROM|JOIN|UPDATE|INTO|ALTER\s+TABLE)\s+(?:IF\s+EXISTS\s+)?["`]?([A-Za-z_][\w.]*)["`]?/gi,
];

const ENV_ACCESS_RE = /^(?:import\.meta(?:\.env)?|process\.env|os\.environ|os\.getenv|Deno\.env|Bun\.env)(?![\w$])/;
const ENV_NAME_RE = /^(?:\.(?:get\()?|\[|\()\s*["']?([A-Za-z_]\w*)/;

// `window.location`, `req.body`: a runtime object member, unless the token ends in a file extension (`request.ts`).
const RUNTIME_OBJECT_RE = /^(?:window|document|globalThis|self|this|navigator|location|console|req|res|request|response|ctx)\.[\w$.]+$/;

/** Env access expression (`process.env.X`, `os.environ`): undefined when the token is not one, null when it names no variable, else the variable. */
function parse_runtime_expression(token: string): string | null | undefined {
  if (token.includes('/')) return undefined;
  const access = ENV_ACCESS_RE.exec(token);
  if (access) {
    const name = ENV_NAME_RE.exec(token.slice(access[0].length))?.[1];
    return name && name !== 'env' && name !== 'get' ? name : null;
  }
  return RUNTIME_OBJECT_RE.test(token) && !FILE_EXT.test(token) ? null : undefined;
}

function is_symbol(token: string): boolean {
  const name = token.replace(/\(\)$/, '');
  if (!SYMBOL_RE.test(name) || name.length < 4 || ENV_RE.test(name)) return false;
  return token.endsWith('()') || /[a-z][A-Z]/.test(name) || /^[A-Z][a-z]+[A-Z]/.test(name) || /^[a-z]+_[a-z_]+$/.test(name);
}

function is_path(token: string): boolean {
  if (/[\s*?<>{}$|=,;]/.test(token) || /^[a-z][a-z0-9+.-]*:\/\//i.test(token) || token.startsWith('~') || token.startsWith('@')) return false;
  const path_text = token.replace(/:\d+(?::\d+)?$/, '');
  return (path_text.includes('/') && (FILE_EXT.test(path_text) || path_text.endsWith('/'))) || (FILE_EXT.test(path_text) && /^[\w.-]+$/.test(path_text) && path_text.includes('.') && !/^\.\w+$/.test(path_text));
}

export function extract_references(body: string): Reference[] {
  const found: Reference[] = [];
  const seen = new Set<string>();
  const add_reference = (reference: string, kind: RefKind, line: number): void => {
    const key = `${kind}\0${reference}`;
    // eslint-disable-next-line id-denylist -- serialized key (triage/graph JSON)
    if (!seen.has(key)) { seen.add(key); found.push({ ref: reference, kind, line }); }
  };
  const scan_commands = (text: string, line: number): void => {
    for (const [re, prefix] of CMD_RES) {
      for (const match of text.matchAll(re)) add_reference(prefix + match[1], 'command', line);
    }
  };
  const scan_sql = (text: string, line: number): void => {
    for (const re of SQL_TABLE_RES) {
      for (const match of text.matchAll(re)) {
        const token = match[1]!;
        if (!/^(?:select|set|values|where|the|a|an)$/i.test(token)) add_reference(token, 'table', line);
      }
    }
    for (const match of text.matchAll(/ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi)) {
      const table_match = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?([\w.]+)/i.exec(text);
      if (table_match) add_reference(`${table_match[1]}.${match[1]}`, 'column', line);
    }
  };

  let fence: { marker: string; len: number; skip: boolean; sql: boolean } | null = null;
  body.split('\n').forEach((line_text, i) => {
    const line = i + 1;
    if (fence) {
      if (new RegExp(`^ {0,3}\\${fence.marker}{${fence.len},}\\s*$`).test(line_text)) { fence = null; return; }
      if (fence.skip) return;
      scan_commands(line_text, line);
      if (fence.sql) scan_sql(line_text, line);
      return;
    }
    const fence_open = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/.exec(line_text);
    if (fence_open) {
      const info = fence_open[2] ?? '';
      fence = { marker: fence_open[1]![0]!, len: fence_open[1]!.length, skip: EXAMPLE_FENCE.test(info), sql: SQL_FENCE.test(info) };
      return;
    }
    for (const match of line_text.matchAll(/`([^`\n]+)`/g)) {
      const token = match[1]!.trim();
      scan_commands(token, line);
      if (/^(?:SELECT|INSERT|UPDATE|DELETE|ALTER)\b/i.test(token)) { scan_sql(token, line); continue; }
      const runtime = parse_runtime_expression(token);
      if (runtime !== undefined) { if (runtime) add_reference(runtime, 'env', line); continue; }
      if (ENV_RE.test(token)) add_reference(token, 'env', line);
      else if (is_path(token)) add_reference(token.replace(/:\d+(?::\d+)?$/, ''), 'path', line);
      else if (is_symbol(token)) add_reference(token.replace(/\(\)$/, ''), 'symbol', line);
      else {
        const column_match = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/.exec(token);
        if (column_match && !NOT_COLUMN_OWNER_EXT.test(column_match[2]!)) add_reference(token, 'column', line);
      }
    }
    for (const match of line_text.matchAll(/\$([A-Z][A-Z0-9_]{2,})\b/g)) add_reference(match[1]!, 'env', line);
  });
  for (const link of extract_links(body)) {
    if (link.is_internal && !/^[a-z][a-z0-9+.-]*:/i.test(link.url)) add_reference(link.url, 'doc-link', link.line_number);
  }
  return found;
}

// ---------- repo index (built once per run) ----------

export interface Schema { tables: Map<string, Set<string>> }

export interface RepoIndex {
  root: string;
  files: Set<string>;
  /** npm script name -> directory of the first package.json defining it ('' = root) */
  scripts: Map<string, string>;
  make_targets: Set<string>;
  deps: Set<string>;
  schema: Schema;
  /** schema files actually parsed (from `schema_sources`) */
  schema_files: string[];
  /** names with no code hit that do appear in markdown (docs neither prove nor disprove them) */
  /** name -> up to two markdown files that mention it (names with no code hit only) */
  md_names: Map<string, Set<string>>;
  /** symbol -> first file it appears in (non-markdown); filled by primeSymbols */
  symbols: Map<string, string | null>;
  /** symbol -> whether `symbols` holds a defining file; filled by primeSymbols */
  symbol_kinds: Map<string, 'definition' | 'reference'>;
}

const run_git = (repo_root: string, args: string[]): string =>
  // eslint-disable-next-line id-denylist -- child_process option name
  execFileSync('git', args, { cwd: repo_root, encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

export function build_glob_regex(glob: string): RegExp {
  const text = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '(?:.*/)?');
  return new RegExp(`^${text}$`);
}

const normalize_name = (identifier: string): string => identifier.replace(/["`]/g, '').split('.').pop()!.toLowerCase();
const SQL_CONSTRAINT = /^(?:primary|foreign|unique|constraint|check|index|key|exclude|like)$/i;

export function parse_sql(sql: string, schema: Schema): void {
  const text = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of text.matchAll(/CREATE\s+(?:\w+\s+)*?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."`]+)\s*\(/gi)) {
    const cols = new Set<string>();
    let depth = 1, i = match.index! + match[0].length, start = i;
    const parts: string[] = [];
    for (; i < text.length && depth > 0; i++) {
      const character = text[i];
      if (character === '(') depth++;
      else if (character === ')') { depth--; if (depth === 0) parts.push(text.slice(start, i)); }
      else if (character === ',' && depth === 1) { parts.push(text.slice(start, i)); start = i + 1; }
    }
    for (const part of parts) {
      const word = /^\s*["`]?(\w+)["`]?/.exec(part)?.[1];
      if (word && !SQL_CONSTRAINT.test(word)) cols.add(word.toLowerCase());
    }
    const key = normalize_name(match[1]!);
    schema.tables.set(key, new Set([...(schema.tables.get(key) ?? []), ...cols]));
  }
  for (const match of text.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w."`]+)([^;]*);/gi)) {
    const key = normalize_name(match[1]!);
    const cols = schema.tables.get(key) ?? new Set<string>();
    for (const a of match[2]!.matchAll(/ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi)) {
      if (!SQL_CONSTRAINT.test(a[1]!)) cols.add(a[1]!.toLowerCase());
    }
    schema.tables.set(key, cols);
  }
}

export function parse_prisma(source: string, schema: Schema): void {
  for (const match of source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const cols = new Set<string>();
    let table = match[1]!;
    for (const line of match[2]!.split('\n')) {
      const trimmed = line.trim();
      const map_attribute = /@@map\(\s*"([^"]+)"/.exec(trimmed);
      if (map_attribute) table = map_attribute[1]!;
      else if (trimmed && !trimmed.startsWith('@@') && !trimmed.startsWith('//')) {
        const field_name = /^(\w+)\s+\w/.exec(trimmed)?.[1];
        if (field_name) cols.add((/@map\(\s*"([^"]+)"/.exec(trimmed)?.[1] ?? field_name).toLowerCase());
      }
    }
    for (const key of new Set([match[1]!, table])) schema.tables.set(key.toLowerCase(), cols);
  }
}

/** Build every per-run index: tracked files, package scripts, Makefile targets, parsed schema. */
export function build_repo_index(repo_root: string, schema_sources: string[] = []): RepoIndex {
  const files = new Set(run_git(repo_root, ['ls-files', '-z']).split('\0').filter(Boolean));
  const read_repo_file = (path_text: string): string => { try { return readFileSync(join(repo_root, path_text), 'utf-8'); } catch { return ''; } };
  let package_info: Record<string, Record<string, unknown> | string> = {};
  try { package_info = JSON.parse(read_repo_file('package.json') || '{}'); } catch { /* unreadable package.json: no scripts */ }
  const get_object_field = (key: string): Record<string, unknown> => (typeof package_info[key] === 'object' && package_info[key] ? (package_info[key] as Record<string, unknown>) : {});
  const deps = new Set([...Object.keys(get_object_field('dependencies')), ...Object.keys(get_object_field('devDependencies')), ...Object.keys(get_object_field('bin'))]);
  if (typeof package_info.name === 'string') deps.add(package_info.name);
  const make_targets = new Set<string>();
  for (const match of read_repo_file('Makefile').matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)) make_targets.add(match[1]!);
  const scripts = new Map<string, string>();
  for (const file of [...files].filter((candidate) => candidate === 'package.json' || candidate.endsWith('/package.json')).sort()) {
    try {
      const scripts_field = (JSON.parse(read_repo_file(file) || '{}') as { scripts?: Record<string, unknown> }).scripts;
      const dir_path = file === 'package.json' ? '' : file.slice(0, -'/package.json'.length);
      if (scripts_field && typeof scripts_field === 'object') for (const key of Object.keys(scripts_field)) if (!scripts.has(key)) scripts.set(key, dir_path);
    } catch { /* unreadable package.json: no scripts */ }
  }
  const schema: Schema = { tables: new Map() };
  const schema_files: string[] = [];
  const schema_globs = schema_sources.map(build_glob_regex);
  for (const file of files) {
    if (!schema_globs.some((schema_glob) => schema_glob.test(file))) continue;
    if (file.endsWith('.sql') || file.endsWith('.prisma')) schema_files.push(file);
    if (file.endsWith('.sql')) parse_sql(read_repo_file(file), schema);
    else if (file.endsWith('.prisma')) parse_prisma(read_repo_file(file), schema);
  }
  return { root: repo_root, files, scripts, make_targets, deps, schema, schema_files, md_names: new Map(), symbols: new Map(), symbol_kinds: new Map() };
}

const BIG_FILE = 512 * 1024;
const WORD = /\w/;
/** Not a place a symbol is defined: data and generated files. Used as a last resort for `reference`. */
const NOT_SOURCE = /(?:\.json|\.lock|[-.]lock\.[\w]+|\.generated\.[\w]+|\.min\.[\w]+)$|(?:^|\/)(?:dist|build)\//;
/** Test and mock files: a definition there loses to one in source. */
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|__mocks__|mocks?|fixtures?|spec)\/|[._-](?:test|spec)\.[\w]+$/;
const build_definition_rank = (file: string): string => `${TEST_FILE.test(file) ? 1 : 0}${file}`;
const escape_dollar = (text: string): string => text.replace(/\$/g, '\\$');

/** First file (in order) containing `name` as a whole word, read in Node; for files too big for `git grep -o`. */
function has_word(text: string, name: string): boolean {
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) {
    if (!WORD.test(text[i - 1] ?? '') && !WORD.test(text[i + name.length] ?? '')) return true;
  }
  return false;
}

/**
 * One `git grep` per chunk (two: SQL is case-insensitive) for lines that define a name; source beats test/mock
 * files, then path order. Names without one keep their referencing file and are marked `reference`.
 */
function scan_definitions(index: RepoIndex, names: string[], files: string[]): void {
  const run_git_in_index = (args: string[]): string => { try { return run_git(index.root, args); } catch { return ''; } };
  const want = new Set(names);
  const defs = new Map<string, string>();
  // a defining file mentions the name, so only the existence pass's candidates are searched
  const source = files.filter((file) => !NOT_SOURCE.test(file) && !/\.mdx?$/.test(file));
  if (names.length && source.length) {
    const alt = `(${names.map(escape_dollar).join('|')})`;
    const jobs: Array<[string[], Array<[RegExp, number]>]> = [
      [['-e', `\\b(def|class|function|const|let|var|interface|type|enum|struct|fn|func)\\s+${alt}\\b`, '-e', `\\b${alt}\\s*[:=]\\s*(async\\s+)?(function|\\()`, '-e', `__tablename__\\s*=\\s*["']${alt}["']`],
        [[/^(?:def|class|function|const|let|var|interface|type|enum|struct|fn|func)\s+([\w$]+)$/, 1], [/^([\w$]+)\s*[:=]/, 1], [/^__tablename__\s*=\s*["']([\w$]+)["']$/, 1]]],
      [['-i', '-e', `CREATE (OR REPLACE )?(TABLE|VIEW|FUNCTION|POLICY|TYPE)\\s+(IF NOT EXISTS\\s+)?([[:alnum:]_."]+\\.)?"?${alt}\\b`], [[/([\w$]+)$/, 1]]],
    ];
    for (const [flags, name_res] of jobs) {
      for (let j = 0; j < source.length; j += 500) {
        const found = run_git_in_index(['grep', '-I', '-n', '-o', '-E', ...flags, '--', ...source.slice(j, j + 500).map((file) => `:(literal)${file}`)]);
        for (const line of found.split('\n')) {
          const match = /^(.*?):\d+:(.*)$/.exec(line);
          const name = match && name_res.map(([re]) => re.exec(match[2]!)?.[1]).find((candidate_name) => candidate_name && want.has(candidate_name));
          if (!name) continue;
          const current = defs.get(name);
          if (current === undefined || build_definition_rank(match![1]!) < build_definition_rank(current)) defs.set(name, match![1]!);
        }
      }
    }
  }
  for (const name of names) {
    const defining_file = defs.get(name);
    if (defining_file) index.symbols.set(name, defining_file);
    index.symbol_kinds.set(name, defining_file ? 'definition' : 'reference');
  }
}

/** name -> up to two markdown files that mention it, for names with no code hit (git grep order). Also what the graph cache compares. */
export function find_md_mentions(repo_root: string, names: string[]): Map<string, Set<string>> {
  const mentions = new Map<string, Set<string>>();
  if (!names.length) return mentions;
  const dir_path = mkdtempSync(join(tmpdir(), 'hewtd-refs-'));
  const patterns_file = join(dir_path, 'patterns');
  writeFileSync(patterns_file, names.join('\n') + '\n');
  const want = new Set(names);
  try {
    let found = '';
    try { found = run_git(repo_root, ['grep', '-I', '-o', '-w', '-F', '-f', patterns_file, '--', '*.md', '*.mdx']); } catch { /* exit 1 = no matches */ }
    for (const line of found.split('\n')) {
      const content = line.lastIndexOf(':');
      const tok = line.slice(content + 1);
      if (content <= 0 || !want.has(tok)) continue;
      const files = mentions.get(tok) ?? mentions.set(tok, new Set()).get(tok)!;
      if (files.size < 2) files.add(line.slice(0, content));
    }
  } finally { rmSync(dir_path, { recursive: true, force: true }); }
  return mentions;
}

/**
 * Per 400 names: `git grep -l` finds candidate files fast; `-o` runs only on small candidates (it crawls on a
 * huge single-line file), large ones are scanned in Node. Markdown is excluded: docs do not prove code exists,
 * but a second pass records which still-unfound names docs mention (those become unknown, not missing).
 */
export function add_known_symbols(index: RepoIndex, names: Iterable<string>): void {
  const todo = [...new Set(names)].filter((name) => !index.symbols.has(name));
  const run_git_in_index = (args: string[]): string => { try { return run_git(index.root, args); } catch { return ''; } /* exit 1 = no matches */ };
  for (let i = 0; i < todo.length; i += 400) {
    const chunk = todo.slice(i, i + 400);
    const dir_path = mkdtempSync(join(tmpdir(), 'hewtd-refs-'));
    const patterns_file = join(dir_path, 'patterns');
    writeFileSync(patterns_file, chunk.join('\n') + '\n');
    const want = new Set(chunk);
    try {
      const code = ['--', '.', ':!*.md', ':!*.mdx'];
      const candidates = run_git_in_index(['grep', '-I', '-l', '-w', '-F', '-f', patterns_file, ...code]).split('\n').filter(Boolean).sort();
      const small: string[] = [];
      const big: string[] = [];
      for (const file of candidates) {
        let size = 0;
        try { size = statSync(join(index.root, file)).size; } catch { /* gone: skip */ }
        (size > BIG_FILE ? big : small).push(file);
      }
      for (let j = 0; j < small.length; j += 500) {
        const found = run_git_in_index(['grep', '-I', '-o', '-w', '-F', '-f', patterns_file, '--', ...small.slice(j, j + 500).map((file) => `:(literal)${file}`)]);
        for (const line of found.split('\n')) {
          const separator_index = line.lastIndexOf(':');
          const symbol = line.slice(separator_index + 1);
          const file = line.slice(0, separator_index);
          const current_file = index.symbols.get(symbol);
          if (separator_index > 0 && want.has(symbol) && (!current_file || (NOT_SOURCE.test(current_file) && !NOT_SOURCE.test(file)))) index.symbols.set(symbol, file);
        }
      }
      for (const file of big) {
        const left = chunk.filter((name) => !index.symbols.get(name) || (NOT_SOURCE.test(index.symbols.get(name)!) && !NOT_SOURCE.test(file)));
        if (!left.length) continue;
        let text = '';
        try { text = readFileSync(join(index.root, file), 'utf-8'); } catch { continue; }
        for (const name of left) if (has_word(text, name)) index.symbols.set(name, file);
      }
      scan_definitions(index, chunk.filter((name) => index.symbols.get(name)), small); // shortcut: files over 512KB are not searched for definitions (git grep -o crawls on them)
      const unfound = chunk.filter((name) => !index.symbols.get(name));
      if (unfound.length) for (const [name, files] of find_md_mentions(index.root, unfound)) index.md_names.set(name, files);
    } finally { rmSync(dir_path, { recursive: true, force: true }); }
    for (const name of chunk) if (!index.symbols.has(name)) index.symbols.set(name, null);
  }
}

// ---------- resolution ----------

function is_mentioned_elsewhere(index: RepoIndex, name: string, self: string | undefined): boolean {
  const files = index.md_names.get(name);
  return !!files && [...files].some((file) => file !== self);
}

/** A sibling checkout, read-only. `idx` is built lazily, only when a ref misses locally. */
export interface RelatedRepo { name: string; root: string; repo_index?: RepoIndex | null }

/** The sibling's index, or null when it is not a checked-out git repo. Never reads the sibling's config. */
export function load_sibling_index(sibling_repo: RelatedRepo): RepoIndex | null {
  if (sibling_repo.repo_index === undefined) {
    try { sibling_repo.repo_index = existsSync(sibling_repo.root) ? build_repo_index(sibling_repo.root) : null; } catch { sibling_repo.repo_index = null; }
  }
  return sibling_repo.repo_index;
}

export interface ResolveOptions {
  /** sibling checkouts, consulted only for refs unresolved locally */
  related?: RelatedRepo[];
  /** absolute path of the doc, for resolving relative links */
  doc_file?: string;
  /** absolute docs root, for resolving links */
  docs_root?: string;
}

/** `example.com/x`: a host-like first segment (letters-only TLD) is a URL, not a repo directory. */
const HOST_LIKE = /^[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\//i;

function resolve_path(index: RepoIndex, reference: string): string | undefined {
  const path_text = reference.replace(/^\.\//, '').replace(/^\//, '');
  if (index.files.has(path_text)) return path_text;
  const dir_path = path_text.endsWith('/') ? path_text : `${path_text}/`;
  for (const file of index.files) {
    if (file.startsWith(dir_path)) return path_text;
    if (file.endsWith(`/${path_text}`)) return file; // docs often cite a path relative to a package
  }
  return undefined;
}

/** `<name>:<where>` for the first sibling that has the ref (and how it holds a symbol); undefined if none does. */
function find_sibling_match(sibling_repos: RelatedRepo[], reference: Reference): { where: string; kind?: 'definition' | 'reference' } | undefined {
  for (const sibling_repo of sibling_repos) {
    const sibling_index = load_sibling_index(sibling_repo);
    if (!sibling_index) continue;
    let where: string | undefined;
    let kind: 'definition' | 'reference' | undefined;
    if (reference.kind === 'path') where = resolve_path(sibling_index, reference.ref);
    else if (reference.kind === 'symbol' || reference.kind === 'env') { where = sibling_index.symbols.get(reference.ref) ?? undefined; kind = sibling_index.symbol_kinds.get(reference.ref); }
    else if (reference.kind === 'command') {
      const name = reference.ref.replace(/^\S+( run)? /, '');
      if (reference.ref.startsWith('npm') && sibling_index.scripts.has(name)) where = join(sibling_index.scripts.get(name)!, 'package.json');
      else if (reference.ref.startsWith('make') && sibling_index.make_targets.has(name)) where = 'Makefile';
    }
    if (where) return { where: `${sibling_repo.name}:${where}`, ...(kind && { kind }) };
  }
  return undefined;
}

export async function resolve_references(index: RepoIndex, references: Reference[], options: ResolveOptions = {}): Promise<ResolvedReference[]> {
  const sibling_repos = options.related ?? [];
  const sym_names = references.filter((reference) => reference.kind === 'symbol' || reference.kind === 'env').map((reference) => reference.ref);
  add_known_symbols(index, sym_names);
  const lost = sym_names.filter((sym_name) => !index.symbols.get(sym_name));
  if (sibling_repos.length && lost.length) for (const sibling_repo of sibling_repos) { const sibling_index = load_sibling_index(sibling_repo); if (sibling_index) add_known_symbols(sibling_index, lost); }
  const have_schema = index.schema.tables.size > 0;
  const self = options.doc_file ? relative(index.root, options.doc_file).split('\\').join('/') : undefined;
  const found: ResolvedReference[] = [];
  for (const reference of references) {
    let status: RefStatus = 'unknown';
    let where: string | undefined;
    let where_kind: 'definition' | 'reference' | undefined;
    switch (reference.kind) {
      case 'path':
        // `/docs/x/` and `/api/v1/x` are URL paths, not repo paths
        if (reference.ref.startsWith('/')) break;
        where = resolve_path(index, reference.ref);
        status = where ? 'ok' : HOST_LIKE.test(reference.ref) ? 'unknown' : 'missing';
        break;
      case 'symbol': case 'env':
        where = index.symbols.get(reference.ref) ?? undefined;
        if (where) where_kind = index.symbol_kinds.get(reference.ref);
        // Only another doc's mention makes a code-less name `unknown` (an external name); the citing doc itself proves nothing.
        status = where ? 'ok' : is_mentioned_elsewhere(index, reference.ref, self) ? 'unknown' : 'missing';
        break;
      case 'command': {
        const [tool, name] = [reference.ref.split(' ')[0]!, reference.ref.replace(/^\S+( run)? /, '')];
        if (tool === 'npm') status = index.scripts.has(name) ? 'ok' : 'missing';
        else if (tool === 'make') status = index.make_targets.has(name) ? 'ok' : index.files.has('Makefile') ? 'missing' : 'unknown';
        else status = index.deps.has(name) || existsSync(resolve(index.root, 'node_modules/.bin', name)) ? 'ok' : 'unknown'; // npx can fetch from the registry
        break;
      }
      case 'table': case 'column': {
        if (!have_schema) break;
        const [owner_token, content] = reference.kind === 'column' ? reference.ref.split('.') : [reference.ref, undefined];
        const cols = index.schema.tables.get(normalize_name(owner_token!));
        // shortcut: `a.b` with a one-word owner not in the schema is probably an object property, so unknown
        status = !cols ? (content && !owner_token!.includes('_') ? 'unknown' : 'missing') : content && !cols.has(content.toLowerCase()) ? 'missing' : 'ok';
        break;
      }
      case 'doc-link':
        if (options.doc_file && options.docs_root) {
          const target = reference.ref.startsWith('/') ? null : resolve(dirname(options.doc_file), decodeURI(reference.ref.split(/[#?]/)[0]!));
          if (target && relative(index.root, target).startsWith('..')) {
            // outside the project: only a related repo's .documentation is checkable
            const sibling_repo = sibling_repos.find((item) => !relative(join(item.root, '.documentation'), target).startsWith('..'));
            if (sibling_repo) {
              status = existsSync(target) && statSync(target).isFile() ? 'ok' : 'missing';
              where = `${sibling_repo.name}:${relative(sibling_repo.root, target).split('\\').join('/')}`;
            }
          } else {
            status = (await check_single_link(reference.ref, options.doc_file, options.docs_root)).valid ? 'ok' : 'missing';
          }
        }
        break;
    }
    // markdown-only names are unknown locally, but code in a sibling still proves them
    const lookup = status === 'missing' || (status === 'unknown' && !where && (reference.kind === 'symbol' || reference.kind === 'env'));
    if (lookup && sibling_repos.length && reference.kind !== 'doc-link' && reference.kind !== 'table' && reference.kind !== 'column') {
      const sibling_match = find_sibling_match(sibling_repos, reference);
      where = sibling_match?.where;
      where_kind = sibling_match?.kind;
      // a sibling that is not checked out might own it: unknown, not missing
      status = where ? 'ok' : sibling_repos.some((item) => !load_sibling_index(item)) ? 'unknown' : status;
    }
    found.push(where ? { ...reference, status, where, ...(reference.kind === 'symbol' && where_kind && { whereKind: where_kind }) } : { ...reference, status });
  }
  return found;
}

/** Convenience: extract and resolve one doc body. */
export async function check_doc_references(index: RepoIndex, body: string, options: ResolveOptions = {}): Promise<ResolvedReference[]> {
  return resolve_references(index, extract_references(body), options);
}
