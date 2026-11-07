import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// End-to-end regressions for #55 and the two #54 integrate traps, through the built CLI.
const REPO = resolve(__dirname, '../..');
const CLI = join(REPO, 'dist/cli/index.js');
let root: string;
let docs: string;
const hewtd = (cwd: string, ...args: string[]) => spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });

const GOOD = 'Explains how the deploy pipeline promotes builds to production safely';
const FM = (title: string, extra = '') =>
  `---\ntitle: ${title}\ntier: guide\ndomains: [api]\naudience: [developers]\ntags: []\nstatus: active\nlast_updated: '2026-01-01'\nversion: 1.0.0\n${extra}estimated_read_time: 1 minute\nword_count: 3\nlast_validated: '2026-01-01'\nbacklinks: []\n---\n`;
const put = (rel: string, text: string) => mkdir(join(docs, rel, '..'), { recursive: true }).then(() => writeFile(join(docs, rel), text));

/** Audit issues (rule|file) via the built auditor. */
const issues = (prefix: string): string[] =>
  JSON.parse(
    execFileSync(
      'node',
      [
        '-e',
        `import('${join(REPO, 'dist/core/audit/auditor.js')}').then(async m=>{const r=await m.auditDocumentation({docsPath:process.argv[1],silent:true});console.log(JSON.stringify(r.issues.filter(i=>i.rule&&i.rule.startsWith('${prefix}')).map(i=>i.rule+'|'+i.file+'|'+i.message)))})`,
        docs,
      ],
      { encoding: 'utf8', cwd: root }
    ).trim().split('\n').pop()!
  );

const snapshot = async (dir: string, rel = ''): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, await snapshot(p, `${rel}${e.name}/`));
    else out[`${rel}${e.name}`] = await readFile(p, 'utf8');
  }
  return out;
};

beforeAll(() => {
  expect(existsSync(CLI)).toBe(true);
}, 120_000);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hewtd-f55-'));
  docs = join(root, '.documentation');
  await mkdir(join(docs, 'api'), { recursive: true });
  await mkdir(join(root, '.git'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('#55.1 fix-retrieval-fields does not turn filler into weak purposes', () => {
  it('drops filler summaries, clears fallback purposes, keeps real ones; WEAK_PURPOSE does not rise', async () => {
    for (const n of [1, 2, 3]) await put(`api/filler${n}.md`, `${FM(`Filler ${n}`, `summary: Documentation for Filler ${n}\n`)}\n# F\n`);
    for (const n of [1, 2]) await put(`api/real${n}.md`, `${FM(`Real ${n}`, `summary: ${GOOD} number ${n}\n`)}\n# R\n`);
    await put('api/migrated.md', `${FM('Migrated', 'purpose: Documentation for Migrated\n')}\n# M\n`);

    const weakBefore = issues('RETRIEVAL_WEAK_PURPOSE').length;
    expect(weakBefore).toBe(1); // only the already-migrated fallback purpose
    const dry = hewtd(root, 'fix-retrieval-fields');
    expect(dry.status).toBe(0);
    expect(await readFile(join(docs, 'api/filler1.md'), 'utf8')).toContain('summary: Documentation for Filler 1');

    expect(hewtd(root, 'fix-retrieval-fields', '--apply').status).toBe(0);
    expect(issues('RETRIEVAL_WEAK_PURPOSE').length).toBe(0);
    const f = await readFile(join(docs, 'api/filler1.md'), 'utf8');
    expect(f).not.toMatch(/^(summary|purpose):/m);
    expect(await readFile(join(docs, 'api/real1.md'), 'utf8')).toContain(`purpose: ${GOOD} number 1`);
    expect(await readFile(join(docs, 'api/migrated.md'), 'utf8')).not.toMatch(/^purpose:/m);
  });
});

describe('#55.2 index upgrade step is idempotent', () => {
  it('second run leaves every file byte-identical', async () => {
    await mkdir(join(docs, 'reports'));
    await mkdir(join(docs, 'knowledge-base', 'facts'), { recursive: true });
    await writeFile(join(docs, 'knowledge-base', 'facts', 'INDEX.md'), '---\ntitle: Facts\n---\n\nold\n');
    await writeFile(join(docs, 'reports', 'audit-2026-01-01T00-00-00.md'), '# old audit\n');
    expect(hewtd(root, 'index').status).toBe(0);
    const first = await snapshot(docs);
    expect(first['reports/audit-2026-01-01T00-00-00.md']).toContain('generated: true');
    expect(hewtd(root, 'index').status).toBe(0);
    expect(await snapshot(docs)).toEqual(first);
  });
});

describe('#55.3 one OVERVIEW_MISSING per real flow', () => {
  it('3 loosely linked domains + one dense cross-domain flow gives exactly one warning naming the flow', async () => {
    const dom = (d: string, extra = '') => FM(`${d} doc`, extra).replace('domains: [api]', `domains: [${d}]`);
    // Three domains, 6 docs each, no links between docs (only INDEX would tie them).
    for (const d of ['api', 'devops', 'testing']) {
      await mkdir(join(docs, d), { recursive: true });
      for (let i = 0; i < 6; i++) await put(`${d}/loose${i}.md`, `${dom(d, `purpose: ${GOOD} ${d} ${i}\n`)}\n# ${d} ${i}\n`);
    }
    // A dense flow across the three domains.
    const flow = ['api/f0.md', 'devops/f1.md', 'testing/f2.md', 'api/f3.md', 'devops/f4.md'];
    for (const [i, rel] of flow.entries()) {
      // Each doc links the next two (no member links all others, so none is an overview).
      const links = [1, 2].map((k) => `[x](../${flow[(i + k) % 5]})`).join(' ');
      await put(rel, `${dom(rel.split('/')[0]!, `purpose: ${GOOD} flow ${i}\n`)}\n# Flow ${i}\n\n${links}\n`);
    }
    const missing = issues('OVERVIEW_MISSING');
    expect(missing).toHaveLength(1);
    for (const rel of flow) expect(missing[0]).toContain(rel);
    expect(missing[0]).not.toContain('loose');
  });
});

describe('#54 integrate traps (built CLI)', () => {
  it('commands run from a subdirectory use the real tree and create no .documentation', async () => {
    await put('api/a.md', `${FM('A', `purpose: ${GOOD}\n`)}\n# A\n`);
    const sub = join(root, 'src/deep');
    await mkdir(sub, { recursive: true });
    for (const args of [['audit'], ['maintain', '--quick'], ['index']]) {
      expect(hewtd(sub, ...args).status).toBe(0);
      expect(existsSync(join(sub, '.documentation'))).toBe(false);
    }
  });

  it('integrating an in-tree file elsewhere exits non-zero and leaves the tree unchanged', async () => {
    await put('api/sub/deploy.md', `${FM('Deploy Guide', `purpose: ${GOOD}\n`).replace('[api]', '[devops]')}\n# Deploy\n`);
    const before = await snapshot(docs);
    const r = hewtd(root, 'integrate', '.documentation/api/sub/deploy.md', '-a');
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/already in the docs tree/);
    expect(await snapshot(docs)).toEqual(before);
  });
});
