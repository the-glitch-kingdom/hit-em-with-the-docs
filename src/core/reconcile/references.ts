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

function looks_like_symbol(t: string): boolean {
  const name = t.replace(/\(\)$/, '');
  if (!SYMBOL_RE.test(name) || name.length < 4 || ENV_RE.test(name)) return false;
  return t.endsWith('()') || /[a-z][A-Z]/.test(name) || /^[A-Z][a-z]+[A-Z]/.test(name) || /^[a-z]+_[a-z_]+$/.test(name);
}

function looks_like_path(t: string): boolean {
  if (/[\s*?<>{}$|=,;]/.test(t) || /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.startsWith('~') || t.startsWith('@')) return false;
  const p = t.replace(/:\d+(?::\d+)?$/, '');
  return (p.includes('/') && (FILE_EXT.test(p) || p.endsWith('/'))) || (FILE_EXT.test(p) && /^[\w.-]+$/.test(p) && p.includes('.') && !/^\.\w+$/.test(p));
}

export function extract_references(body: string): Reference[] {
  const out: Reference[] = [];
  const seen = new Set<string>();
  const add = (ref: string, kind: RefKind, line: number): void => {
    const k = `${kind}\0${ref}`;
    if (!seen.has(k)) { seen.add(k); out.push({ ref, kind, line }); }
  };
  const scan_commands = (text: string, line: number): void => {
    for (const [re, prefix] of CMD_RES) {
      for (const m of text.matchAll(re)) add(prefix + m[1], 'command', line);
    }
  };
  const scan_sql = (text: string, line: number): void => {
    for (const re of SQL_TABLE_RES) {
      for (const m of text.matchAll(re)) {
        const t = m[1]!;
        if (!/^(?:select|set|values|where|the|a|an)$/i.test(t)) add(t, 'table', line);
      }
    }
    for (const m of text.matchAll(/ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi)) {
      const tbl = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?([\w.]+)/i.exec(text);
      if (tbl) add(`${tbl[1]}.${m[1]}`, 'column', line);
    }
  };

  let fence: { marker: string; len: number; skip: boolean; sql: boolean } | null = null;
  body.split('\n').forEach((raw, i) => {
    const line = i + 1;
    if (fence) {
      if (new RegExp(`^ {0,3}\\${fence.marker}{${fence.len},}\\s*$`).test(raw)) { fence = null; return; }
      if (fence.skip) return;
      scan_commands(raw, line);
      if (fence.sql) scan_sql(raw, line);
      return;
    }
    const open = /^ {0,3}(`{3,}|~{3,})\s*(.*)$/.exec(raw);
    if (open) {
      const info = open[2] ?? '';
      fence = { marker: open[1]![0]!, len: open[1]!.length, skip: EXAMPLE_FENCE.test(info), sql: SQL_FENCE.test(info) };
      return;
    }
    for (const m of raw.matchAll(/`([^`\n]+)`/g)) {
      const t = m[1]!.trim();
      scan_commands(t, line);
      if (/^(?:SELECT|INSERT|UPDATE|DELETE|ALTER)\b/i.test(t)) { scan_sql(t, line); continue; }
      if (ENV_RE.test(t)) add(t, 'env', line);
      else if (looks_like_path(t)) add(t.replace(/:\d+(?::\d+)?$/, ''), 'path', line);
      else if (looks_like_symbol(t)) add(t.replace(/\(\)$/, ''), 'symbol', line);
      else {
        const d = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/.exec(t);
        if (d && !NOT_COLUMN_OWNER_EXT.test(d[2]!)) add(t, 'column', line);
      }
    }
    for (const m of raw.matchAll(/\$([A-Z][A-Z0-9_]{2,})\b/g)) add(m[1]!, 'env', line);
  });
  for (const l of extract_links(body)) {
    if (l.isInternal && !/^[a-z][a-z0-9+.-]*:/i.test(l.url)) add(l.url, 'doc-link', l.lineNumber);
  }
  return out;
}

// ---------- repo index (built once per run) ----------

export interface Schema { tables: Map<string, Set<string>> }

export interface RepoIndex {
  root: string;
  files: Set<string>;
  /** npm script name -> directory of the first package.json defining it ('' = root) */
  scripts: Map<string, string>;
  makeTargets: Set<string>;
  deps: Set<string>;
  schema: Schema;
  /** schema files actually parsed (from `schema_sources`) */
  schemaFiles: string[];
  /** names with no code hit that do appear in markdown (docs neither prove nor disprove them) */
  /** name -> up to two markdown files that mention it (names with no code hit only) */
  mdNames: Map<string, Set<string>>;
  /** symbol -> first file it appears in (non-markdown); filled by primeSymbols */
  symbols: Map<string, string | null>;
  /** symbol -> whether `symbols` holds a defining file; filled by primeSymbols */
  symbolKinds: Map<string, 'definition' | 'reference'>;
}

const git = (root: string, args: string[]): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

export function glob_to_re(glob: string): RegExp {
  const s = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '(?:.*/)?');
  return new RegExp(`^${s}$`);
}

const norm = (n: string): string => n.replace(/["`]/g, '').split('.').pop()!.toLowerCase();
const SQL_CONSTRAINT = /^(?:primary|foreign|unique|constraint|check|index|key|exclude|like)$/i;

export function parse_sql(sql: string, schema: Schema): void {
  const s = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of s.matchAll(/CREATE\s+(?:\w+\s+)*?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."`]+)\s*\(/gi)) {
    const cols = new Set<string>();
    let depth = 1, i = m.index! + m[0].length, start = i;
    const parts: string[] = [];
    for (; i < s.length && depth > 0; i++) {
      const c = s[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) parts.push(s.slice(start, i)); }
      else if (c === ',' && depth === 1) { parts.push(s.slice(start, i)); start = i + 1; }
    }
    for (const p of parts) {
      const w = /^\s*["`]?(\w+)["`]?/.exec(p)?.[1];
      if (w && !SQL_CONSTRAINT.test(w)) cols.add(w.toLowerCase());
    }
    const key = norm(m[1]!);
    schema.tables.set(key, new Set([...(schema.tables.get(key) ?? []), ...cols]));
  }
  for (const m of s.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w."`]+)([^;]*);/gi)) {
    const key = norm(m[1]!);
    const cols = schema.tables.get(key) ?? new Set<string>();
    for (const a of m[2]!.matchAll(/ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi)) {
      if (!SQL_CONSTRAINT.test(a[1]!)) cols.add(a[1]!.toLowerCase());
    }
    schema.tables.set(key, cols);
  }
}

export function parse_prisma(src: string, schema: Schema): void {
  for (const m of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const cols = new Set<string>();
    let table = m[1]!;
    for (const line of m[2]!.split('\n')) {
      const l = line.trim();
      const map = /@@map\(\s*"([^"]+)"/.exec(l);
      if (map) table = map[1]!;
      else if (l && !l.startsWith('@@') && !l.startsWith('//')) {
        const f = /^(\w+)\s+\w/.exec(l)?.[1];
        if (f) cols.add((/@map\(\s*"([^"]+)"/.exec(l)?.[1] ?? f).toLowerCase());
      }
    }
    for (const k of new Set([m[1]!, table])) schema.tables.set(k.toLowerCase(), cols);
  }
}

/** Build every per-run index: tracked files, package scripts, Makefile targets, parsed schema. */
export function build_repo_index(root: string, schema_sources: string[] = []): RepoIndex {
  const files = new Set(git(root, ['ls-files', '-z']).split('\0').filter(Boolean));
  const read = (p: string): string => { try { return readFileSync(join(root, p), 'utf-8'); } catch { return ''; } };
  let pkg: Record<string, Record<string, unknown> | string> = {};
  try { pkg = JSON.parse(read('package.json') || '{}'); } catch { /* unreadable package.json: no scripts */ }
  const obj = (k: string): Record<string, unknown> => (typeof pkg[k] === 'object' && pkg[k] ? (pkg[k] as Record<string, unknown>) : {});
  const deps = new Set([...Object.keys(obj('dependencies')), ...Object.keys(obj('devDependencies')), ...Object.keys(obj('bin'))]);
  if (typeof pkg.name === 'string') deps.add(pkg.name);
  const make_targets = new Set<string>();
  for (const m of read('Makefile').matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)) make_targets.add(m[1]!);
  const scripts = new Map<string, string>();
  for (const f of [...files].filter((f) => f === 'package.json' || f.endsWith('/package.json')).sort()) {
    try {
      const sc = (JSON.parse(read(f) || '{}') as { scripts?: Record<string, unknown> }).scripts;
      const dir = f === 'package.json' ? '' : f.slice(0, -'/package.json'.length);
      if (sc && typeof sc === 'object') for (const k of Object.keys(sc)) if (!scripts.has(k)) scripts.set(k, dir);
    } catch { /* unreadable package.json: no scripts */ }
  }
  const schema: Schema = { tables: new Map() };
  const schema_files: string[] = [];
  const res = schema_sources.map(glob_to_re);
  for (const f of files) {
    if (!res.some((r) => r.test(f))) continue;
    if (f.endsWith('.sql') || f.endsWith('.prisma')) schema_files.push(f);
    if (f.endsWith('.sql')) parse_sql(read(f), schema);
    else if (f.endsWith('.prisma')) parse_prisma(read(f), schema);
  }
  return { root, files, scripts, makeTargets: make_targets, deps, schema, schemaFiles: schema_files, mdNames: new Map(), symbols: new Map(), symbolKinds: new Map() };
}

const BIG_FILE = 512 * 1024;
const WORD = /\w/;
/** Not a place a symbol is defined: data and generated files. Used as a last resort for `reference`. */
const NOT_SOURCE = /(?:\.json|\.lock|[-.]lock\.[\w]+|\.generated\.[\w]+|\.min\.[\w]+)$|(?:^|\/)(?:dist|build)\//;
/** Test and mock files: a definition there loses to one in source. */
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|__mocks__|mocks?|fixtures?|spec)\/|[._-](?:test|spec)\.[\w]+$/;
const def_rank = (f: string): string => `${TEST_FILE.test(f) ? 1 : 0}${f}`;
const esc = (n: string): string => n.replace(/\$/g, '\\$');

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
function definition_pass(idx: RepoIndex, names: string[], files: string[]): void {
  const run = (args: string[]): string => { try { return git(idx.root, args); } catch { return ''; } };
  const want = new Set(names);
  const defs = new Map<string, string>();
  // a defining file mentions the name, so only the existence pass's candidates are searched
  const src = files.filter((f) => !NOT_SOURCE.test(f) && !/\.mdx?$/.test(f));
  if (names.length && src.length) {
    const alt = `(${names.map(esc).join('|')})`;
    const jobs: Array<[string[], Array<[RegExp, number]>]> = [
      [['-e', `\\b(def|class|function|const|let|var|interface|type|enum|struct|fn|func)\\s+${alt}\\b`, '-e', `\\b${alt}\\s*[:=]\\s*(async\\s+)?(function|\\()`, '-e', `__tablename__\\s*=\\s*["']${alt}["']`],
        [[/^(?:def|class|function|const|let|var|interface|type|enum|struct|fn|func)\s+([\w$]+)$/, 1], [/^([\w$]+)\s*[:=]/, 1], [/^__tablename__\s*=\s*["']([\w$]+)["']$/, 1]]],
      [['-i', '-e', `CREATE (OR REPLACE )?(TABLE|VIEW|FUNCTION|POLICY|TYPE)\\s+(IF NOT EXISTS\\s+)?([[:alnum:]_."]+\\.)?"?${alt}\\b`], [[/([\w$]+)$/, 1]]],
    ];
    for (const [flags, name_res] of jobs) {
      for (let j = 0; j < src.length; j += 500) {
        const out = run(['grep', '-I', '-n', '-o', '-E', ...flags, '--', ...src.slice(j, j + 500).map((f) => `:(literal)${f}`)]);
        for (const l of out.split('\n')) {
          const m = /^(.*?):\d+:(.*)$/.exec(l);
          const name = m && name_res.map(([re]) => re.exec(m[2]!)?.[1]).find((n) => n && want.has(n));
          if (!name) continue;
          const cur = defs.get(name);
          if (cur === undefined || def_rank(m![1]!) < def_rank(cur)) defs.set(name, m![1]!);
        }
      }
    }
  }
  for (const n of names) {
    const d = defs.get(n);
    if (d) idx.symbols.set(n, d);
    idx.symbolKinds.set(n, d ? 'definition' : 'reference');
  }
}

/**
 * Per 400 names: `git grep -l` finds candidate files fast; `-o` runs only on small candidates (it crawls on a
 * huge single-line file), large ones are scanned in Node. Markdown is excluded: docs do not prove code exists,
 * but a second pass records which still-unfound names docs mention (those become unknown, not missing).
 */
export function prime_symbols(idx: RepoIndex, names: Iterable<string>): void {
  const todo = [...new Set(names)].filter((n) => !idx.symbols.has(n));
  const run = (args: string[]): string => { try { return git(idx.root, args); } catch { return ''; } /* exit 1 = no matches */ };
  for (let i = 0; i < todo.length; i += 400) {
    const chunk = todo.slice(i, i + 400);
    const dir = mkdtempSync(join(tmpdir(), 'hewtd-refs-'));
    const pf = join(dir, 'patterns');
    writeFileSync(pf, chunk.join('\n') + '\n');
    const want = new Set(chunk);
    try {
      const code = ['--', '.', ':!*.md', ':!*.mdx'];
      const cands = run(['grep', '-I', '-l', '-w', '-F', '-f', pf, ...code]).split('\n').filter(Boolean).sort();
      const small: string[] = [];
      const big: string[] = [];
      for (const f of cands) {
        let size = 0;
        try { size = statSync(join(idx.root, f)).size; } catch { /* gone: skip */ }
        (size > BIG_FILE ? big : small).push(f);
      }
      for (let j = 0; j < small.length; j += 500) {
        const out = run(['grep', '-I', '-o', '-w', '-F', '-f', pf, '--', ...small.slice(j, j + 500).map((f) => `:(literal)${f}`)]);
        for (const l of out.split('\n')) {
          const c = l.lastIndexOf(':');
          const tok = l.slice(c + 1);
          const f = l.slice(0, c);
          const cur = idx.symbols.get(tok);
          if (c > 0 && want.has(tok) && (!cur || (NOT_SOURCE.test(cur) && !NOT_SOURCE.test(f)))) idx.symbols.set(tok, f);
        }
      }
      for (const f of big) {
        const left = chunk.filter((n) => !idx.symbols.get(n) || (NOT_SOURCE.test(idx.symbols.get(n)!) && !NOT_SOURCE.test(f)));
        if (!left.length) continue;
        let text = '';
        try { text = readFileSync(join(idx.root, f), 'utf-8'); } catch { continue; }
        for (const n of left) if (has_word(text, n)) idx.symbols.set(n, f);
      }
      definition_pass(idx, chunk.filter((n) => idx.symbols.get(n)), small); // shortcut: files over 512KB are not searched for definitions (git grep -o crawls on them)
      const unfound = chunk.filter((n) => !idx.symbols.get(n));
      if (unfound.length) {
        writeFileSync(pf, unfound.join('\n') + '\n');
        for (const l of run(['grep', '-I', '-o', '-w', '-F', '-f', pf, '--', '*.md', '*.mdx']).split('\n')) {
          const c = l.lastIndexOf(':');
          const tok = l.slice(c + 1);
          if (c <= 0 || !want.has(tok)) continue;
          const files = idx.mdNames.get(tok) ?? idx.mdNames.set(tok, new Set()).get(tok)!;
          if (files.size < 2) files.add(l.slice(0, c));
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
    for (const n of chunk) if (!idx.symbols.has(n)) idx.symbols.set(n, null);
  }
}

// ---------- resolution ----------

function mentioned_elsewhere(idx: RepoIndex, name: string, self: string | undefined): boolean {
  const files = idx.mdNames.get(name);
  return !!files && [...files].some((f) => f !== self);
}

/** A sibling checkout, read-only. `idx` is built lazily, only when a ref misses locally. */
export interface RelatedRepo { name: string; root: string; idx?: RepoIndex | null }

/** The sibling's index, or null when it is not a checked-out git repo. Never reads the sibling's config. */
export function related_index(r: RelatedRepo): RepoIndex | null {
  if (r.idx === undefined) {
    try { r.idx = existsSync(r.root) ? build_repo_index(r.root) : null; } catch { r.idx = null; }
  }
  return r.idx;
}

export interface ResolveOptions {
  /** sibling checkouts, consulted only for refs unresolved locally */
  related?: RelatedRepo[];
  /** absolute path of the doc, for resolving relative links */
  docFile?: string;
  /** absolute docs root, for resolving links */
  docsPath?: string;
}

/** `example.com/x`: a host-like first segment (letters-only TLD) is a URL, not a repo directory. */
const HOST_LIKE = /^[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\//i;

function resolve_path(idx: RepoIndex, ref: string): string | undefined {
  const p = ref.replace(/^\.\//, '').replace(/^\//, '');
  if (idx.files.has(p)) return p;
  const dir = p.endsWith('/') ? p : `${p}/`;
  for (const f of idx.files) {
    if (f.startsWith(dir)) return p;
    if (f.endsWith(`/${p}`)) return f; // docs often cite a path relative to a package
  }
  return undefined;
}

/** `<name>:<where>` for the first sibling that has the ref (and how it holds a symbol); undefined if none does. */
function in_related(related: RelatedRepo[], r: Reference): { where: string; kind?: 'definition' | 'reference' } | undefined {
  for (const rel of related) {
    const sib = related_index(rel);
    if (!sib) continue;
    let where: string | undefined;
    let kind: 'definition' | 'reference' | undefined;
    if (r.kind === 'path') where = resolve_path(sib, r.ref);
    else if (r.kind === 'symbol' || r.kind === 'env') { where = sib.symbols.get(r.ref) ?? undefined; kind = sib.symbolKinds.get(r.ref); }
    else if (r.kind === 'command') {
      const name = r.ref.replace(/^\S+( run)? /, '');
      if (r.ref.startsWith('npm') && sib.scripts.has(name)) where = join(sib.scripts.get(name)!, 'package.json');
      else if (r.ref.startsWith('make') && sib.makeTargets.has(name)) where = 'Makefile';
    }
    if (where) return { where: `${rel.name}:${where}`, ...(kind && { kind }) };
  }
  return undefined;
}

export async function resolve_references(idx: RepoIndex, refs: Reference[], opts: ResolveOptions = {}): Promise<ResolvedReference[]> {
  const related = opts.related ?? [];
  const sym_names = refs.filter((r) => r.kind === 'symbol' || r.kind === 'env').map((r) => r.ref);
  prime_symbols(idx, sym_names);
  const lost = sym_names.filter((n) => !idx.symbols.get(n));
  if (related.length && lost.length) for (const rel of related) { const sib = related_index(rel); if (sib) prime_symbols(sib, lost); }
  const have_schema = idx.schema.tables.size > 0;
  const self = opts.docFile ? relative(idx.root, opts.docFile).split('\\').join('/') : undefined;
  const out: ResolvedReference[] = [];
  for (const r of refs) {
    let status: RefStatus = 'unknown';
    let where: string | undefined;
    let where_kind: 'definition' | 'reference' | undefined;
    switch (r.kind) {
      case 'path':
        // `/docs/x/` and `/api/v1/x` are URL paths, not repo paths
        if (r.ref.startsWith('/')) break;
        where = resolve_path(idx, r.ref);
        status = where ? 'ok' : HOST_LIKE.test(r.ref) ? 'unknown' : 'missing';
        break;
      case 'symbol': case 'env':
        where = idx.symbols.get(r.ref) ?? undefined;
        if (where) where_kind = idx.symbolKinds.get(r.ref);
        // Only another doc's mention makes a code-less name `unknown` (an external name); the citing doc itself proves nothing.
        status = where ? 'ok' : mentioned_elsewhere(idx, r.ref, self) ? 'unknown' : 'missing';
        break;
      case 'command': {
        const [tool, name] = [r.ref.split(' ')[0]!, r.ref.replace(/^\S+( run)? /, '')];
        if (tool === 'npm') status = idx.scripts.has(name) ? 'ok' : 'missing';
        else if (tool === 'make') status = idx.makeTargets.has(name) ? 'ok' : idx.files.has('Makefile') ? 'missing' : 'unknown';
        else status = idx.deps.has(name) || existsSync(resolve(idx.root, 'node_modules/.bin', name)) ? 'ok' : 'unknown'; // npx can fetch from the registry
        break;
      }
      case 'table': case 'column': {
        if (!have_schema) break;
        const [t, c] = r.kind === 'column' ? r.ref.split('.') : [r.ref, undefined];
        const cols = idx.schema.tables.get(norm(t!));
        // shortcut: `a.b` with a one-word owner not in the schema is probably an object property, so unknown
        status = !cols ? (c && !t!.includes('_') ? 'unknown' : 'missing') : c && !cols.has(c.toLowerCase()) ? 'missing' : 'ok';
        break;
      }
      case 'doc-link':
        if (opts.docFile && opts.docsPath) {
          const target = r.ref.startsWith('/') ? null : resolve(dirname(opts.docFile), decodeURI(r.ref.split(/[#?]/)[0]!));
          if (target && relative(idx.root, target).startsWith('..')) {
            // outside the project: only a related repo's .documentation is checkable
            const rel = related.find((x) => !relative(join(x.root, '.documentation'), target).startsWith('..'));
            if (rel) {
              status = existsSync(target) && statSync(target).isFile() ? 'ok' : 'missing';
              where = `${rel.name}:${relative(rel.root, target).split('\\').join('/')}`;
            }
          } else {
            status = (await check_single_link(r.ref, opts.docFile, opts.docsPath)).valid ? 'ok' : 'missing';
          }
        }
        break;
    }
    // markdown-only names are unknown locally, but code in a sibling still proves them
    const lookup = status === 'missing' || (status === 'unknown' && !where && (r.kind === 'symbol' || r.kind === 'env'));
    if (lookup && related.length && r.kind !== 'doc-link' && r.kind !== 'table' && r.kind !== 'column') {
      const hit = in_related(related, r);
      where = hit?.where;
      where_kind = hit?.kind;
      // a sibling that is not checked out might own it: unknown, not missing
      status = where ? 'ok' : related.some((x) => !related_index(x)) ? 'unknown' : status;
    }
    out.push(where ? { ...r, status, where, ...(r.kind === 'symbol' && where_kind && { whereKind: where_kind }) } : { ...r, status });
  }
  return out;
}

/** Convenience: extract and resolve one doc body. */
export async function check_doc_references(idx: RepoIndex, body: string, opts: ResolveOptions = {}): Promise<ResolvedReference[]> {
  return resolve_references(idx, extract_references(body), opts);
}
