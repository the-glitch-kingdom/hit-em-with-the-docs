import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { integrate_document } from '../../src/core/integrate/integrator.js';
import { resolve_docs_path } from '../../src/utils/docs-root.js';

const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const BODY = '---\ntitle: Deploy Guide\ntier: guide\ndomains: [devops]\nstatus: active\n---\n\n# Deploy Guide\n\nHow to deploy.\n';

let root: string;
let docs: string;
const hewtd = (cwd: string, ...args: string[]) => spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });

beforeAll(() => {
  expect(existsSync(CLI)).toBe(true); // run `npm run build` first
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hewtd-root-'));
  docs = join(root, '.documentation');
  await mkdir(join(docs, 'api'), { recursive: true });
  await mkdir(join(root, '.git'));
  await mkdir(join(root, 'src/deep'), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('resolveDocsPath', () => {
  it('walks up from a subdirectory, honors explicit -p, stops at the git root', () => {
    const sub = join(root, 'src/deep');
    expect(resolve_docs_path(sub, '.documentation', false)).toBe(docs);
    expect(resolve_docs_path(sub, '.documentation', true)).toBe(join(sub, '.documentation'));
    expect(resolve_docs_path(root, 'nope', false)).toBe(join(root, 'nope'));
  });
});

describe('integrate from a subdirectory', () => {
  it('lands in the real tree and creates no second .documentation', async () => {
    const sub = join(root, 'src/deep');
    await writeFile(join(sub, 'deploy.md'), BODY);
    const r = hewtd(sub, 'integrate', 'deploy.md', '-a');
    expect(r.status).toBe(0);
    expect(existsSync(join(sub, '.documentation'))).toBe(false);
    expect(existsSync(join(docs, 'devops/deploy.md'))).toBe(true);
  });
});

describe('integrate of an in-tree file', () => {
  const run = (file: string) => integrate_document({ file_path: file, docs_path: docs, auto: true, silent: true });

  it('refuses a file at a different path and writes nothing', async () => {
    await mkdir(join(docs, 'api/sub'), { recursive: true });
    const f = join(docs, 'api/sub/deploy.md');
    await writeFile(f, BODY);
    const r = await run(f);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/already in the docs tree/);
    expect(existsSync(join(docs, 'devops/deploy.md'))).toBe(false);
    expect(await readFile(f, 'utf8')).toBe(BODY);
  });

  it('rewrites in place when the file is at its own target path', async () => {
    await mkdir(join(docs, 'devops'), { recursive: true });
    const f = join(docs, 'devops/deploy.md');
    await writeFile(f, BODY);
    const r = await run(f);
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
  });
});
