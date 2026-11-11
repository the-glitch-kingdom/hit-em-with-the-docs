import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { with_generated_stamp } from '../../src/generators/stamp-reports.js';

const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
let docs: string;
const hewtd = (...args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const read = (p: string) => readFile(p, 'utf-8');

beforeAll(() => {
  expect(existsSync(CLI)).toBe(true); // run `npm run build` first
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hewtd-stamp-'));
  docs = join(root, '.documentation');
  await mkdir(join(docs, 'reports'), { recursive: true });
  await mkdir(join(docs, 'knowledge-base', 'facts'), { recursive: true });
  await mkdir(join(root, '.git'));
  await writeFile(join(docs, 'knowledge-base', 'facts', 'INDEX.md'), '---\ntitle: Facts\n---\n\nold\n');
  await writeFile(join(docs, 'reports', 'maintenance-2026-01-01T00-00-00.md'), '---\ntitle: M\ntier: reference\n---\n\n# M\n');
  await writeFile(join(docs, 'reports', 'health-2026-01-01T00-00-00.md'), '# Health, no frontmatter\n');
  await writeFile(join(docs, 'reports', 'notes.md'), '# my note\n');
  await writeFile(join(docs, 'reports', 'audit-2026-01-01T00-00-00.json'), '{}');
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('hewtd index upgrade step', () => {
  it('stamps KB indexes and old reports once; a second run changes nothing', async () => {
    const r = hewtd('index');
    expect(r.status).toBe(0);
    const m = join(docs, 'reports', 'maintenance-2026-01-01T00-00-00.md');
    const h = join(docs, 'reports', 'health-2026-01-01T00-00-00.md');
    expect(await read(m)).toContain('generated: true');
    expect(await read(m)).toContain('tier: reference');
    expect((await read(h)).startsWith('---\ngenerated: true\n---\n')).toBe(true);
    expect(await read(join(docs, 'knowledge-base', 'facts', 'INDEX.md'))).toContain('generated: true');
    expect(await read(join(docs, 'reports', 'notes.md'))).toBe('# my note\n');
    expect(await read(join(docs, 'reports', 'audit-2026-01-01T00-00-00.json'))).toBe('{}');

    const before = await read(m);
    hewtd('index');
    expect(await read(m)).toBe(before);
  });

  it('--dry-run lists the reports and writes nothing', async () => {
    const r = hewtd('index', '--dry-run');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('maintenance-2026-01-01T00-00-00.md');
    expect(await read(join(docs, 'reports', 'health-2026-01-01T00-00-00.md'))).toBe('# Health, no frontmatter\n');
    expect(await read(join(docs, 'knowledge-base', 'facts', 'INDEX.md'))).not.toContain('generated: true');
  });
});

describe('hewtd init reports_dir', () => {
  const cfg = () => join(root, '.claude', 'hit-em-with-the-docs.json');

  it('writes reports_dir on a fresh repo', async () => {
    await rm(docs, { recursive: true });
    expect(hewtd('init').status).toBe(0);
    expect(JSON.parse(await read(cfg())).reports_dir).toBe('.hewtd/reports');
  });

  it('keeps existing keys and an existing reports_dir', async () => {
    await rm(docs, { recursive: true });
    await mkdir(join(root, '.claude'));
    await writeFile(cfg(), JSON.stringify({ updatePolicy: 'off', reports_dir: 'x/r' }));
    hewtd('init');
    expect(JSON.parse(await read(cfg()))).toMatchObject({ updatePolicy: 'off', reports_dir: 'x/r' }); // plus the #109 targets block
    await rm(docs, { recursive: true, force: true });
    await writeFile(cfg(), JSON.stringify({ updatePolicy: 'off' }));
    hewtd('init');
    expect(JSON.parse(await read(cfg()))).toMatchObject({ updatePolicy: 'off', reports_dir: '.hewtd/reports' });
  });

  it('never overwrites an unparseable config, and --force re-init keeps reports where they were (review fix)', async () => {
    await rm(docs, { recursive: true });
    await mkdir(join(root, '.claude'));
    await writeFile(cfg(), '{ "updatePolicy": "off", }');
    hewtd('init');
    expect(await read(cfg())).toBe('{ "updatePolicy": "off", }');
    await writeFile(cfg(), JSON.stringify({ updatePolicy: 'off' }));
    hewtd('init', '--force');
    const kept = JSON.parse(await read(cfg()));
    expect(kept.reports_dir).toBeUndefined(); // a re-init never adds reports_dir (the #109 targets block is added)
    expect(kept.updatePolicy).toBe('off');
  });
});

describe('stampGenerated', () => {
  it('handles CRLF and skips stamped files', () => {
    expect(with_generated_stamp('---\r\ntitle: a\r\n---\r\nbody')).toBe('---\r\ntitle: a\r\ngenerated: true\r\n---\r\nbody');
    expect(with_generated_stamp('---\ngenerated: true\n---\nx')).toBeNull();
  });
});
