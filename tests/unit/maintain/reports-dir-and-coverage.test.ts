import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { run_maintenance } from '../../../src/core/maintain/orchestrator.js';
import { save_health_report, generate_health_report } from '../../../src/reports/health-report.js';
import { resolve_reports_dir } from '../../../src/utils/config.js';

const GOOD = 'Explains how the deploy pipeline promotes builds to production safely';
const fm = (title: string, extra = ''): string =>
  `---\ntitle: ${title}\ntier: guide\ndomains: [api]\nstatus: active\nlast_updated: '2026-01-01'\n${extra}---\n\nBody.\n`;

let root: string;
let docs: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hewtd-reports-'));
  docs = join(root, '.documentation');
  await mkdir(join(docs, 'api'), { recursive: true });
  await mkdir(join(root, '.claude'), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const set_config = (c: object) => writeFile(join(root, '.claude/hit-em-with-the-docs.json'), JSON.stringify(c));

describe('reports_dir', () => {
  it('defaults to <docs>/reports', async () => {
    expect(await resolve_reports_dir(docs)).toBe(join(docs, 'reports'));
    const result = await run_maintenance({ docsPath: docs, quick: true, silent: true });
    expect(result.reportPath).toContain(join('.documentation', 'reports'));
  });

  it('writes outside the docs root when configured, leaving nothing under .documentation/reports', async () => {
    await set_config({ reports_dir: '.hewtd/reports' });
    const result = await run_maintenance({ docsPath: docs, quick: true, silent: true });
    expect(result.reportPath).toBe(join(root, '.hewtd/reports', (result.reportPath as string).split('/').pop()!));
    expect(existsSync(join(docs, 'reports'))).toBe(false);
    const saved = await save_health_report(docs, result);
    expect(saved.startsWith(join(root, '.hewtd/reports'))).toBe(true);
    expect((await readdir(join(root, '.hewtd/reports'))).length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to the default for a path that escapes the repo', async () => {
    await set_config({ reports_dir: '../outside' });
    expect(await resolve_reports_dir(docs)).toBe(join(docs, 'reports'));
  });

  it('accepts a directory whose name starts with two dots', async () => {
    await set_config({ reports_dir: '..reports' });
    expect(await resolve_reports_dir(docs)).toBe(join(root, '..reports'));
  });
});

describe('health report retrieval coverage', () => {
  it('reports exact counts and percentages', async () => {
    await writeFile(join(docs, 'api/a.md'), fm('Alpha', `purpose: ${GOOD}\nsymptoms:\n  - deploy hangs\n`));
    await writeFile(join(docs, 'api/b.md'), fm('Twin'));
    await writeFile(join(docs, 'api/c.md'), fm('Twin'));
    const result = await run_maintenance({ docsPath: docs, quick: true, silent: true });
    expect(result.retrievalCoverage).toEqual({ total: 3, withPurpose: 1, withSymptoms: 1, withUniqueTitle: 1 });
    const md = await generate_health_report({ docsPath: docs, result });
    expect(md).toContain('## Retrieval Coverage');
    expect(md).toContain('| Non-weak purpose | 1/3 | 33.3% |');
    const json = JSON.parse(await generate_health_report({ docsPath: docs, result, format: 'json' }));
    expect(json.retrievalCoverage.total).toBe(3);
  });

  it('empty tree gives 0% without dividing by zero', async () => {
    const result = await run_maintenance({ docsPath: docs, quick: true, silent: true });
    expect(result.retrievalCoverage?.total).toBe(0);
    const md = await generate_health_report({ docsPath: docs, result });
    expect(md).toContain('| Symptoms | 0/0 | 0.0% |');
    expect(md.split('## Retrieval Coverage')[1]!.split('## Recommendations')[0]).not.toContain('NaN');
  });
});
