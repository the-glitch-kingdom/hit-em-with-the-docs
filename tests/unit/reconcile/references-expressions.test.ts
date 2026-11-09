import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extract_references } from '../../../src/core/reconcile/references.js';
import { load_plugin_config } from '../../../src/utils/config';
import { build_graph } from '../../../src/core/graph/export';

const refs = (token: string) => extract_references(`See \`${token}\`.`).map((r) => `${r.kind}:${r.ref}`);

describe('runtime expressions in references', () => {
  it.each(['import.meta.env', 'import.meta', 'process.env', 'os.environ', 'os.getenv', 'Deno.env', 'Bun.env',
    'window.location', 'req.body', 'document.cookie'])('%s adds no ref', (token) => {
    expect(refs(token)).toEqual([]);
  });

  it.each([
    ['process.env.API_URL', 'API_URL'],
    ['import.meta.env.VITE_API_URL', 'VITE_API_URL'],
    ['os.environ["DB_URL"]', 'DB_URL'],
    ['os.environ.get("DB_URL")', 'DB_URL'],
    ['os.getenv("X")', 'X'],
    ['Deno.env.get("TOKEN")', 'TOKEN'],
    ['Bun.env.PORT', 'PORT'],
  ])('%s adds an env ref', (token, name) => {
    expect(refs(token)).toEqual([`env:${name}`]);
  });

  it.each(['src/a.ts', 'config/app.env', 'config.env', 'config.json', 'app.config.ts'])('%s stays a path', (token) => {
    expect(refs(token)).toEqual([`path:${token}`]);
  });
});

describe('graph export of runtime expressions', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-expr-'));
    mkdirSync(join(dir, '.documentation/ops'), { recursive: true });
    writeFileSync(join(dir, '.documentation/ops/e.md'), '---\ntitle: E\n---\nRead `import.meta.env` and `process.env.API_URL`; see `src/gone.ts`.\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('has no file ref for the expression', async () => {
    const g = await build_graph({ root: dir, docs_root: join(dir, '.documentation'), config: await load_plugin_config(dir), dry_run: true });
    const files = g.docs['ops/e.md']!.refs.filter((r) => r.kind === 'file').map((r) => r.target);
    expect(files).toEqual(['src/gone.ts']);
  });
});

describe('review fixes (#72): real file names are not runtime expressions', () => {
  it('keeps bare file names whose stem is a runtime object name', async () => {
    const { extract_references } = await import('../../../src/core/reconcile/references.js');
    const refs = extract_references('See `request.ts`, `response.json`, `ctx.ts`, `document.md`, `config.env` and `app.env`.');
    expect(refs.filter((r) => r.kind === 'path').map((r) => r.ref).sort()).toEqual(['app.env', 'config.env', 'ctx.ts', 'document.md', 'request.ts', 'response.json']);
  });
});
