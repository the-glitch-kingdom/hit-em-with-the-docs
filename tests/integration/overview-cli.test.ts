import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO = resolve(__dirname, '../..');
const CLI = join(REPO, 'dist/cli/index.js');

let root: string;
let docs: string;

const hewtd = (...args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });

const GOOD = 'Explains how the deploy pipeline promotes builds to production safely';
const FM = (title: string, extra = '', tier = 'guide') =>
  `---\ntitle: ${title}\ntier: ${tier}\ndomains: [api]\naudience: [developers]\ntags: []\nstatus: active\nlast_updated: '2026-01-01'\nversion: 1.0.0\npurpose: ${GOOD}\nestimated_read_time: 1 minute\nword_count: 3\nlast_validated: '2026-01-01'\nbacklinks: []\n${extra}---\n`;
const NAMES = ['a', 'b', 'c', 'd', 'e'];
const put = (rel: string, text: string) => writeFile(join(docs, rel), text);

/** "RULE|file" for every OVERVIEW_* issue, via the built auditor (the CLI does not print issues). */
const overviewIssues = (): string[] =>
  JSON.parse(
    execFileSync(
      'node',
      [
        '-e',
        `import('${join(REPO, 'dist/core/audit/auditor.js')}').then(async m=>{const r=await m.auditDocumentation({docsPath:process.argv[1],silent:true});console.log(JSON.stringify(r.issues.filter(i=>i.rule&&i.rule.startsWith('OVERVIEW_')).map(i=>i.rule+'|'+i.file+'|'+i.message)))})`,
        docs,
      ],
      { encoding: 'utf8', cwd: root }
    )
      .trim()
      .split('\n')
      .pop()!
  );

const snapshot = async (dir = docs): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'reports') continue;
      Object.entries(await snapshot(p)).forEach(([k, v]) => (out[`${e.name}/${k}`] = v));
    } else out[e.name] = await readFile(p, 'utf8');
  }
  return out;
};

const writeMembers = async () => {
  for (const [i, n] of NAMES.entries()) await put(`api/${n}.md`, `${FM(`Doc ${n}`)}\n# Doc ${n}\n\n[x](${NAMES[(i + 1) % 5]}.md) [y](${NAMES[(i + 2) % 5]}.md)\n`);
};
const writeOverview = (linked = NAMES) =>
  put(
    'api/ov.md',
    `${FM('The Overview', 'kind: overview\n')}\n# The Overview\n\n${linked.map((n) => `[${n}](${n}.md)`).join('\n')}\n`
  );

beforeAll(() => {
  expect(existsSync(CLI)).toBe(true);
}, 120_000);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hewtd-ov-e2e-'));
  docs = join(root, '.documentation');
  await mkdir(join(docs, 'api'), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('overview docs end to end (built CLI)', () => {
  it('OVERVIEW_MISSING with only a generated INDEX hub; gone once a kind: overview doc links the members', async () => {
    await writeMembers();
    expect(hewtd('maintain', '--quick', '-p', docs).status).toBe(0);
    expect(existsSync(join(docs, 'api/INDEX.md'))).toBe(true);
    const before = overviewIssues();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatch(/^OVERVIEW_MISSING\|api\/a\.md\|Flow — 5 docs \(api\/a\.md, api\/b\.md, api\/c\.md, api\/d\.md, api\/e\.md\) have no overview; only a generated index links them all$/);

    await writeOverview();
    expect(overviewIssues()).toEqual([]);

    // Partial coverage of the cluster (1 of 5 others) is not an overview.
    await writeOverview(['a']);
    expect(overviewIssues()[0]).toMatch(/^OVERVIEW_MISSING\|api\//);
  });

  it('OVERVIEW_STALE_LINKS names the members an overview misses', async () => {
    await writeMembers();
    await writeOverview(['a', 'b', 'c', 'd']);
    const issues = overviewIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^OVERVIEW_STALE_LINKS\|api\/ov\.md\|Overview does not link 1 of 5 cluster docs: api\/e\.md$/);
  });

  it('kind: overview passes strict audit on every tier; a bad kind fails', async () => {
    for (const tier of ['guide', 'reference', 'admin']) {
      await put(`api/${tier}.md`, `${FM(`${tier} overview`, 'kind: overview\n', tier)}\n# T\n\nBody.\n`);
    }
    hewtd('maintain', '--quick', '-p', docs);
    expect(hewtd('audit', '--strict', '-p', docs).status).toBe(0);

    await put('api/bad.md', `${FM('Bad kind', 'kind: overveiw\n')}\n# Bad\n\nBody.\n`);
    expect(hewtd('audit', '--strict', '-p', docs).status).toBe(1);
  });

  it('OVERVIEW_* warnings never change audit exit codes, even with --strict', async () => {
    await writeMembers();
    hewtd('maintain', '--quick', '-p', docs);
    expect(overviewIssues().length).toBeGreaterThan(0);
    expect(hewtd('audit', '-p', docs).status).toBe(0);
    expect(hewtd('audit', '--strict', '-p', docs).status).toBe(0);
    const { countActionableIssues } = await import('../../src/core/audit/auditor.js');
    expect(countActionableIssues([{ rule: 'OVERVIEW_MISSING' }, { rule: 'OVERVIEW_STALE_LINKS' }])).toBe(0);
  });

  it('maintain --fix adds back-links once; a second run changes no file, and kind survives', async () => {
    await writeMembers();
    // Incomplete frontmatter forces the metadata-fix path that used to strip `kind`.
    await put('api/ov.md', `---\ntitle: The Overview\ntier: guide\ndomains: [api]\nstatus: active\nkind: overview\ngenerated_by: me\n---\n\n# The Overview\n\n${NAMES.map((n) => `[${n}](${n}.md)`).join('\n')}\n`);

    // Without --fix: nothing in a member changes.
    const pristine = await readFile(join(docs, 'api/a.md'), 'utf8');
    hewtd('maintain', '--quick', '-p', docs);
    expect(await readFile(join(docs, 'api/a.md'), 'utf8')).toBe(pristine);

    expect(hewtd('maintain', '--quick', '--fix', '-p', docs).status).toBe(0);
    for (const n of NAMES) {
      expect(await readFile(join(docs, `api/${n}.md`), 'utf8')).toContain('# Doc ' + n + '\n\nPart of: [The Overview](ov.md)\n');
    }
    const ov = await readFile(join(docs, 'api/ov.md'), 'utf8');
    expect(ov).toMatch(/^kind: overview$/m);
    expect(ov).toMatch(/^generated_by: me$/m);

    const first = await snapshot();
    expect(hewtd('maintain', '--quick', '--fix', '-p', docs).status).toBe(0);
    expect(await snapshot()).toEqual(first);
    expect(overviewIssues()).toEqual([]);
  });

  it('health report (markdown and json) shows exact cluster counts', async () => {
    await writeMembers();
    expect(hewtd('report', 'health', '-p', docs).status).toBe(0);
    let files = await readdir(join(docs, 'reports'));
    let md = await readFile(join(docs, 'reports', files.find((f) => f.startsWith('health'))!), 'utf8');
    expect(md).toContain('0 cluster(s) with an overview, 1 without.');
    expect(md).toMatch(/\| api \| 5 \| yes \|/);

    await writeOverview();
    await rm(join(docs, 'reports'), { recursive: true });
    expect(hewtd('report', 'health', '-p', docs, '-f', 'json').status).toBe(0);
    files = await readdir(join(docs, 'reports'));
    const json = JSON.parse(await readFile(join(docs, 'reports', files.find((f) => f.startsWith('health'))!), 'utf8'));
    expect(json.overviewCoverage).toEqual({ withOverview: 1, withoutOverview: 0, missing: [] });
  });
});
