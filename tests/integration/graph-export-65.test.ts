import { createHash } from 'crypto';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Graph export (#65) through the built CLI: index writes it, apply updates it.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const GRAPH = () => join(root, '.hewtd/graph.json');
const verdict = (p: string) => JSON.parse(readFileSync(GRAPH(), 'utf-8')).docs[p]?.verdict;
const reviewFile = () => join(root, '.hewtd/reconcile', readdirSync(join(root, '.hewtd/reconcile')).find((f) => /^review-.*\.md$/.test(f))!);
function fill(file: string, fn: (path: string) => Record<string, unknown> | null): void {
  const out = readFileSync(file, 'utf-8').split(/^(?=## )/m).map((sec) => {
    const m = /```json\n([\s\S]*?)\n```/.exec(sec);
    if (!m) return sec;
    const e = JSON.parse(m[1]!);
    const patch = fn(e.path);
    return patch ? sec.replace(m[1]!, JSON.stringify({ ...e, ...patch }, null, 2)).replace('- [ ] accept', '- [x] accept') : sec;
  });
  writeFileSync(file, out.join(''));
}

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'graph-cli-'));
  put('src/real.ts', 'export const realThing = 1;\n');
  put('.documentation/backend/a.md', '---\ntitle: a\ndomains:\n  - backend\n---\n\n# a\n\nSee `src/real.ts` and `src/gone.ts`.\n');
  put('.gitignore', '.hewtd/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('graph export on index and apply', () => {
  it('index writes the graph; an unchanged tree leaves it untouched', async () => {
    expect(hewtd(['index']).status).toBe(0);
    expect(JSON.parse(readFileSync(GRAPH(), 'utf-8')).version).toBe(1);
    const m = statSync(GRAPH()).mtimeMs;
    const bytes = readFileSync(GRAPH(), 'utf-8');
    await new Promise((r) => setTimeout(r, 30));
    hewtd(['index']);
    expect(readFileSync(GRAPH(), 'utf-8')).toBe(bytes);
    expect(statSync(GRAPH()).mtimeMs).toBe(m);
  });

  it('index --no-graph skips the export and says nothing about it', () => {
    const r = hewtd(['index', '--no-graph']);
    expect(r.status).toBe(0);
    expect(existsSync(GRAPH())).toBe(false);
    expect(r.stdout + r.stderr).not.toMatch(/graph/i);
    expect(hewtd(['index']).status).toBe(0);
    expect(existsSync(GRAPH())).toBe(true);
  });

  it('--dry-run writes nothing; graph_export:false writes nothing', () => {
    expect(hewtd(['index', '--dry-run']).stdout).toMatch(/Would update \.hewtd\/graph\.json/);
    expect(existsSync(GRAPH())).toBe(false);
    put('.claude/hit-em-with-the-docs.json', '{"graph_export": false}');
    hewtd(['index']);
    expect(existsSync(GRAPH())).toBe(false);
  });

  it('hints once when the file is not git-ignored', () => {
    put('.gitignore', '');
    expect(hewtd(['index']).stdout).toMatch(/not git-ignored/);
    expect(hewtd(['index']).stdout).not.toMatch(/not git-ignored/);
  });

  it('outside git: skips and does not fail', () => {
    rmSync(join(root, '.git'), { recursive: true });
    const r = hewtd(['index']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/not a git checkout/);
  });

  it('apply updates the touched entry; a batch with no applied entry leaves the file', () => {
    hewtd(['index']);
    expect(verdict('backend/a.md')).not.toBe('verified');
    hewtd(['reconcile', 'backend', '--write-review']);
    const f = reviewFile();
    fill(f, () => ({ verdict: 'integrate' })); // invalid for in-tree docs: error, nothing applied
    const before = readFileSync(GRAPH(), 'utf-8');
    expect(hewtd(['reconcile', '--apply', f]).status).toBe(1);
    expect(readFileSync(GRAPH(), 'utf-8')).toBe(before);
    fill(f, () => ({ verdict: 'verify', sources: ['src/real.ts'] }));
    expect(hewtd(['reconcile', '--apply', f]).status).toBe(0);
    expect(verdict('backend/a.md')).toBe('verified');
  });
});

// Tiny checker for the keyword subset the shipped schema uses (no new dependency).
const schema = JSON.parse(readFileSync(join(resolve(__dirname, '../..'), 'schemas/graph.v1.schema.json'), 'utf-8'));
function check(s: any, v: any, path = '$'): string[] {
  if (s.$ref) return check(s.$ref.split('/').reduce((n: any, k: string) => (k === '#' ? schema : n[k]), schema), v, path);
  if (s.oneOf) return s.oneOf.some((o: any) => check(o, v, path).length === 0) ? [] : [`${path}: no oneOf match`];
  if ('const' in s) return v === s.const ? [] : [`${path}: expected ${s.const}`];
  if (s.enum) return s.enum.includes(v) ? [] : [`${path}: not in enum`];
  const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  if (s.type && !([] as string[]).concat(s.type).includes(t)) return [`${path}: expected ${s.type}, got ${t}`];
  if (s.pattern && typeof v === 'string' && !new RegExp(s.pattern).test(v)) return [`${path}: pattern`];
  const errs: string[] = [];
  if (t === 'object') {
    for (const r of s.required ?? []) if (!(r in v)) errs.push(`${path}.${r}: missing`);
    for (const [k, x] of Object.entries(v)) {
      const sub = s.properties?.[k] ?? (typeof s.additionalProperties === 'object' ? s.additionalProperties : null);
      if (sub) errs.push(...check(sub, x, `${path}.${k}`));
    }
  }
  if (t === 'array' && s.items) v.forEach((x: any, i: number) => errs.push(...check(s.items, x, `${path}[${i}]`)));
  return errs;
}

describe('graph content through the CLI', () => {
  const steps = Array.from({ length: 8 }, (_, i) => `${i + 1}. Run the release step number ${i + 1} and confirm the pipeline reports green before tagging version ${i}.`).join('\n');
  const filler = Array.from({ length: 400 }, (_, i) => `Admin note ${i}: rotate unrelated knob ${i * 7} weekly.`).join('\n');
  const gitAt = (date: string, msg: string) => { g('add', '-A'); execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', 'commit', '-qm', msg], { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }); };
  const graph = () => JSON.parse(readFileSync(GRAPH(), 'utf-8'));

  beforeEach(() => {
    put('.documentation/procedures/release.md', `---\ntitle: Release procedure\npurpose: How to cut and tag a release\n---\n# Release procedure\n\n${steps}\n`);
    put('.documentation/guides/admin.md', `---\ntitle: Admin\n---\n# Admin\n\n${filler}\n\n## Cutting a release\n\n${steps}\n`);
    const raw = readFileSync(join(root, '.documentation/backend/a.md'), 'utf-8');
    put('.hewtd/reconcile.json', JSON.stringify({ version: 1, entries: { 'backend/a.md': { path: 'backend/a.md', lane: 'check', verdict: 'point', content_hash: createHash('sha256').update(raw).digest('hex'), pointer: { target: 'procedures/release.md#release-procedure', section_hash: 'h' } } } }));
    gitAt('2026-02-01T12:00:00', 'docs');
    put('src/real.ts', 'export const realThing = 2;\n');
    gitAt('2026-04-01T12:00:00', 'code');
  });

  it('missing refs are resolved:false, resolved file refs carry code_changed, and it matches reconcile', () => {
    expect(hewtd(['index']).status).toBe(0);
    const a = graph().docs['backend/a.md'];
    expect(a.refs).toContainEqual({ kind: 'file', target: 'src/gone.ts', resolved: false });
    expect(a.refs).toContainEqual({ kind: 'file', target: 'src/real.ts', resolved: true, code_changed: '2026-04-01' });
    expect(a.body_changed).toBe(g('log', '-1', '--format=%cs', '--', '.documentation/backend/a.md'));
    const rec = JSON.parse(hewtd(['reconcile', 'backend', '--json']).stdout);
    const missing: string[] = (rec.docs ?? rec.triage?.docs ?? []).find((d: any) => d.path === 'backend/a.md')?.missing ?? [];
    expect(missing).toContain('src/gone.ts');
    for (const m of missing) expect(a.refs).toContainEqual({ kind: 'file', target: m, resolved: false });
  });

  it('owner, pointer and duplicate data match the ledger and reconcile', () => {
    hewtd(['index']);
    const d = graph().docs;
    expect(d['backend/a.md'].points_to).toEqual([{ from: null, to: 'procedures/release.md#release-procedure' }]);
    expect(d['procedures/release.md'].owner_of).toContain('procedures/release.md#release-procedure');
    expect(d['guides/admin.md'].duplicates).toEqual([expect.objectContaining({ owner: expect.stringMatching(/^procedures\/release\.md#/) })]);
  });

  it('a generated graph validates against the shipped schema and is deterministic', () => {
    hewtd(['index']);
    const first = readFileSync(GRAPH(), 'utf-8');
    expect(check(schema, JSON.parse(first))).toEqual([]);
    expect(JSON.parse(first).source_commit).toBe(g('rev-parse', 'HEAD'));
    expect(first).not.toMatch(/generated_at|timestamp/);
    rmSync(GRAPH());
    hewtd(['index']);
    expect(readFileSync(GRAPH(), 'utf-8')).toBe(first);
  });

  it('the schema rejects a graph with a bad verdict (the check can fail)', () => {
    hewtd(['index']);
    const bad = graph();
    bad.docs['backend/a.md'].verdict = 'bogus';
    expect(check(schema, bad)).not.toEqual([]);
  });
});
