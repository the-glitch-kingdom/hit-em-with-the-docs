import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import matter from 'gray-matter';

const REPO = resolve(__dirname, '../..');
const CLI = join(REPO, 'dist/cli/index.js');

let root: string;
let docs: string;

const hewtd = (...args: string[]) =>
  spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });

const GOOD = 'Explains how the deploy pipeline promotes builds to production safely';
const fm = (title: string, extra = '', tier = 'guide') =>
  `---\ntitle: ${title}\ntier: ${tier}\ndomains: [api]\nstatus: active\nversion: 1.0.0\nlast_updated: '2026-01-01'\n${extra}---\n\n${GOOD}.\n`;

// Rule names of RETRIEVAL_* issues, via the built auditor (the CLI does not print issues).
const retrieval_rules = (): string[] =>
  JSON.parse(
    execFileSync(
      'node',
      [
        '-e',
        `import('${join(REPO, 'dist/core/audit/auditor.js')}').then(async m=>{const r=await m.audit_documentation({docsPath:process.argv[1],silent:true});console.log(JSON.stringify(r.issues.filter(i=>i.rule&&i.rule.startsWith('RETRIEVAL_')).map(i=>i.rule+'|'+i.file)))})`,
        docs,
      ],
      { encoding: 'utf8', cwd: root }
    )
      .trim()
      .split('\n')
      .pop()!
  );

beforeAll(() => {
  expect(existsSync(CLI)).toBe(true);
}, 120_000);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hewtd-e2e-'));
  docs = join(root, '.documentation');
  await mkdir(join(docs, 'api'), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('retrieval end to end (built CLI)', () => {
  it('integrate on a code-block-first doc writes no purpose, and audit flags MISSING_PURPOSE', async () => {
    const src = join(root, 'incoming.md');
    await writeFile(src, '# Deploy Notes\n\n```bash\nmake deploy\n```\n\nMore text here.\n');
    const r = hewtd('integrate', src, '-a', '-d', 'api');
    expect(r.status).toBe(0);
    const out = join(docs, 'api', 'incoming.md');
    expect(existsSync(out)).toBe(true);
    const data = matter(await readFile(out, 'utf8')).data;
    expect(data.purpose).toBeUndefined();
    expect(retrieval_rules().some((x) => x.startsWith('RETRIEVAL_MISSING_PURPOSE|'))).toBe(true);
  });

  it('plain-string symptoms pass audit on every tier; a bad object entry still errors', async () => {
    for (const tier of ['guide', 'reference', 'admin']) {
      await writeFile(
        join(docs, 'api', `${tier}.md`),
        fm(`${tier} doc`, `purpose: ${GOOD}\nsymptoms:\n  - connection refused on port 5432\n`, tier)
      );
    }
    hewtd('maintain', '--quick', '-p', docs);
    expect(hewtd('audit', '--strict', '-p', docs).status).toBe(0);

    await writeFile(
      join(docs, 'api', 'bad.md'),
      fm('bad doc', `purpose: ${GOOD}\nsymptoms:\n  - error_pattern: boom\n    target: x\n`)
    );
    expect(hewtd('audit', '--strict', '-p', docs).status).toBe(1);
  });

  it('retrieval warnings do not change audit exit codes, even with --strict', async () => {
    await writeFile(join(docs, 'api', 'a.md'), fm('Plain doc')); // no purpose -> warning only
    hewtd('maintain', '--quick', '-p', docs);
    expect(retrieval_rules().length).toBeGreaterThan(0);
    expect(hewtd('audit', '-p', docs).status).toBe(0);
    expect(hewtd('audit', '--strict', '-p', docs).status).toBe(0);
  });

  it('summary-only doc warns with the fix hint; dry run writes nothing; --apply changes only purpose', async () => {
    const file = join(docs, 'api', 's.md');
    const original = fm('Summary doc', `summary: ${GOOD}\ntags: [one]\n`);
    await writeFile(file, original);

    const audit = JSON.parse(
      execFileSync(
        'node',
        ['-e', `import('${join(REPO, 'dist/core/audit/auditor.js')}').then(async m=>{const r=await m.audit_documentation({docsPath:process.argv[1],silent:true});console.log(JSON.stringify(r.issues.filter(i=>i.rule==='RETRIEVAL_MISSING_PURPOSE')))})`, docs],
        { encoding: 'utf8', cwd: root }
      ).trim().split('\n').pop()!
    );
    expect(audit.length).toBe(1);
    expect(JSON.stringify(audit)).toContain('fix-retrieval-fields --apply');

    hewtd('fix-retrieval-fields', '-p', docs);
    expect(await readFile(file, 'utf8')).toBe(original);

    expect(hewtd('fix-retrieval-fields', '-p', docs, '--apply').status).toBe(0);
    const after = matter(await readFile(file, 'utf8'));
    const before = matter(original);
    expect(after.data.purpose).toBe(GOOD);
    expect(after.data.summary).toBeUndefined();
    expect(after.content).toBe(before.content);
    const { purpose: _p, ...rest } = after.data;
    const { summary: _s, ...before_rest } = before.data;
    expect(rest).toEqual(before_rest);
    expect(retrieval_rules().some((x) => x.startsWith('RETRIEVAL_MISSING_PURPOSE|'))).toBe(false);
  });

  it('maintain writes a health report with exact retrieval coverage numbers', async () => {
    await writeFile(join(docs, 'api', 'a.md'), fm('Alpha doc', `purpose: ${GOOD}\nsymptoms: [a phrase]\n`));
    await writeFile(join(docs, 'api', 'b.md'), fm('Beta doc', `purpose: ${GOOD}\n`));
    await writeFile(join(docs, 'api', 'c.md'), fm('Gamma doc'));
    expect(hewtd('report', 'health', '-p', docs).status).toBe(0);
    const name = readdirSync(join(docs, 'reports')).find((f) => f.startsWith('health'))!;
    const report = await readFile(join(docs, 'reports', name), 'utf8');
    expect(report).toContain('## Retrieval Coverage');
    expect(report).toMatch(/Non-weak purpose \| 2\/3 \| 66.7%/);
    expect(report).toMatch(/Symptoms \| 1\/3 \| 33.3%/);
    expect(report).toMatch(/Unique title \| 3\/3 \| 100.0%/);
  });

  it('every generated file carries generated: true and reports honour reports_dir', async () => {
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(join(root, '.claude/hit-em-with-the-docs.json'), JSON.stringify({ reports_dir: '.hewtd/reports' }));
    await writeFile(join(docs, 'api', 'a.md'), fm('Alpha doc', `purpose: ${GOOD}\n`));
    expect(hewtd('maintain', '--quick', '-p', docs).status).toBe(0);
    expect(hewtd('report', 'health', '-p', docs).status).toBe(0);
    expect(hewtd('report', 'audit', '-p', docs).status).toBe(0);
    expect(hewtd('report', 'links', '-p', docs).status).toBe(0);

    expect(existsSync(join(docs, 'reports'))).toBe(false);
    const reports_dir = join(root, '.hewtd/reports');
    const reports = readdirSync(reports_dir);
    for (const prefix of ['maintenance', 'health', 'audit', 'link']) {
      expect(reports.some((f) => f.startsWith(prefix)), prefix).toBe(true);
    }
    const generated = [join(docs, 'INDEX.md'), join(docs, 'api', 'INDEX.md'), ...reports.map((f) => join(reports_dir, f))];
    for (const f of generated.filter(existsSync)) {
      expect(await readFile(f, 'utf8'), f).toMatch(/^generated: true$/m);
    }
    expect(existsSync(join(docs, 'api', 'INDEX.md'))).toBe(true);
  });

  it('domain INDEX rows show purpose and a pipe in purpose does not break the table', async () => {
    await writeFile(join(docs, 'api', 'a.md'), fm('Alpha doc', `purpose: "Use a | b to split\\nlines"\n`));
    hewtd('maintain', '--quick', '-p', docs);
    const idx = await readFile(join(docs, 'api', 'INDEX.md'), 'utf8');
    const row = idx.split('\n').find((l) => l.includes('Alpha doc'))!;
    expect(row).toContain('Use a \\| b to split');
    // title, status, updated, words, purpose => 6 unescaped pipes
    expect(row.replace(/\\\|/g, '').split('|').length).toBe(7);
  });
});
