import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { integrate_document } from '../../../src/core/integrate/integrator';
import { parse_frontmatter } from '../../../src/utils/frontmatter';
import { fingerprint } from '../../../src/core/reconcile/secrets';
import { triage } from '../../../src/core/reconcile/triage';
import { search_docs } from '../../../src/core/reconcile/search';
import { load_plugin_config } from '../../../src/utils/config';
import { load_ledger } from '../../../src/core/reconcile/ledger';

// Secret-shaped values are assembled at runtime so the repo never holds a scannable literal.
const rnd = (n: number, seed = 7) => { let x = seed; let s = ''; const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += a[x % a.length]; } return s; };
const hvs = 'hv' + 's.' + rnd(24);

let root: string, docs: string, inbox: string;
const run = (name: string, text: string, extra: Record<string, unknown> = {}) => {
  const f = join(inbox, name);
  writeFileSync(f, text);
  return integrate_document({ filePath: f, docsPath: docs, auto: true, silent: true, ...extra });
};
const fm = (p: string) => parse_frontmatter<Record<string, unknown>>(readFileSync(p, 'utf-8')).data;
const files = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wtg-'));
  docs = join(root, '.documentation');
  inbox = join(root, 'inbox');
  mkdirSync(docs); mkdirSync(inbox);
  mkdirSync(join(root, 'src'));
  for (let i = 0; i < 14; i++) writeFileSync(join(root, `src/f${i}.ts`), `export const v${i} = ${i};\n`);
  writeFileSync(join(root, 'src/a.ts'), 'export function doThing() {}\n');
  writeFileSync(join(root, 'data.json'), '{"doThing": 1}\n');
  writeFileSync(join(root, 'package.json'), '{"name":"x","scripts":{"build":"tsc"}}\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('integrate secret scan', () => {
  it('refuses a token (also with --force), masked, and writes nothing', async () => {
    for (const force of [false, true]) {
      const r = await run('deploy.md', `# Deploy\n\nlogin with ${hvs}\n`, { force });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/vault-token deploy\.md:3 hvs\.…\d+/);
      expect(r.error).toMatch(/reconcile --secrets/);
      expect(r.error).not.toContain(hvs.slice(4));
    }
    expect(files(docs).filter((f) => f.endsWith('.md'))).toEqual([]);
  });

  it('a baselined value integrates; an email only warns', async () => {
    mkdirSync(join(root, '.hewtd'));
    writeFileSync(join(root, '.hewtd/secrets-baseline.json'), JSON.stringify({ entries: [{ fingerprint: fingerprint(hvs), rule: 'vault-token', file: 'x', masked: 'hvs.…27', reason: 'fixture' }] }));
    expect((await run('a.md', `# A\n\nfixture ${hvs}\n`)).success).toBe(true);
    expect((await run('b.md', '# B\n\ncontact ann@corp.io for access\n')).success).toBe(true);
  });
});

describe('integrate records sources', () => {
  const doc = (body: string, head = '') => `${head}# Guide\n\n${body}\n`;

  it('caps at sources_max, most-cited first, ties by first mention, folds #symbol and :line', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 14; i++) lines.push(`See \`src/f${i}.ts\`.`);
    lines.push('Also `src/f13.ts` and `src/f13.ts:9` and `src/f12.ts#v12` again.', 'And `src/a.ts#doThing` and `src/a.ts:42`.');
    const r = await run('g.md', doc(lines.join('\n')));
    const src = fm(r.targetPath!).sources as string[];
    expect(src).toHaveLength(10);
    expect(src.slice(0, 3)).toEqual(['src/f13.ts', 'src/f12.ts', 'src/a.ts']);
    expect(src.slice(3)).toEqual(['src/f0.ts', 'src/f1.ts', 'src/f2.ts', 'src/f3.ts', 'src/f4.ts', 'src/f5.ts', 'src/f6.ts']);
    expect(src.some((s) => /[#:]/.test(s.replace(/^https?:.*/, '')))).toBe(false);
    expect(fm(r.targetPath!).last_verified).toBeUndefined();
  });

  it('keeps hand-written sources first and unchanged, adds up to the cap, adds none at the cap', async () => {
    const hand = ['h1', 'h2', 'h3'];
    const body = Array.from({ length: 14 }, (_, i) => `\`src/f${i}.ts\``).join(' ');
    const r = await run('h.md', doc(body, `---\ntitle: H\nsources:\n${hand.map((h) => `  - ${h}\n`).join('')}---\n\n`));
    const src = fm(r.targetPath!).sources as string[];
    expect(src.slice(0, 3)).toEqual(hand);
    expect(src).toHaveLength(10);

    const full = Array.from({ length: 10 }, (_, i) => `hand${i}`);
    const r2 = await run('full.md', doc(body, `---\ntitle: Full\nsources:\n${full.map((h) => `  - ${h}\n`).join('')}---\n\n`));
    expect(fm(r2.targetPath!).sources).toEqual(full);
  });

  it('honours integrate.sources_max from config', async () => {
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude/hit-em-with-the-docs.json'), JSON.stringify({ integrate: { sources_max: 2 } }));
    const r = await run('c.md', doc('`src/f1.ts` `src/f2.ts` `src/f3.ts`'));
    expect(fm(r.targetPath!).sources).toEqual(['src/f1.ts', 'src/f2.ts']);
  });

  it('writes cited URLs and npm-run package.json, skips common symbols, missing paths and unique-less names', async () => {
    const r = await run('u.md', doc('Run `npm run build`; see [vendor](https://vendor.example/docs). Call `doThing()` and open `src/nope.ts`.'));
    const src = fm(r.targetPath!).sources as string[];
    expect(src).toContain('package.json');
    expect(src).toContain('https://vendor.example/docs');
    expect(src).toContain('src/a.ts'); // data.json also holds doThing, but a data file is not a citation (review fix)
    expect(src).not.toContain('src/nope.ts');
  });

  it('a name found only in a data file is never cited (review fix)', async () => {
    writeFileSync(join(root, 'fixtures.json'), '{"onlyInData": 1}\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    const r = await run('dd.md', doc('Set `onlyInData`.'));
    expect(fm(r.targetPath!).sources).toBeUndefined();
  });

  it('a symbol in exactly one code file is cited', async () => {
    writeFileSync(join(root, 'src/u.ts'), 'export function onlyHere() {}\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    const r = await run('s.md', doc('Call `onlyHere()`.'));
    expect(fm(r.targetPath!).sources).toEqual(['src/u.ts']);
  });

  it('dry-run writes nothing; a doc with no references gets no sources', async () => {
    const d = await run('d.md', doc('`src/f1.ts`'), { dryRun: true });
    expect(d.sourcesAdded).toEqual(['src/f1.ts']);
    expect(existsSync(d.targetPath!)).toBe(false);
    expect(fm((await run('n.md', doc('plain prose'))).targetPath!).sources).toBeUndefined();
  });

  it('triage puts the integrated doc in check, and search never indexes sources', async () => {
    const r = await run('t.md', doc('Details live in `src/f3.ts`.', '---\ntitle: Details\n---\n\n'));
    const rel = r.targetPath!.slice(docs.length + 1);
    const t = await triage({ root, docsPath: docs, rels: [rel], config: await load_plugin_config(root), ledger: await load_ledger(join(root, '.hewtd/reconcile.json')) });
    expect(t.docs[0]!.lane).toBe('check');
    writeFileSync(r.targetPath!, readFileSync(r.targetPath!, 'utf-8').replaceAll('Details live in `src/f3.ts`.', 'Details live elsewhere.'));
    expect(await search_docs(docs, 'src/f3.ts', { config: await load_plugin_config(root) })).toEqual([]);
  });
});
