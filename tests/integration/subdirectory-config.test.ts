import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const roots: string[] = [];

const domains = ['alpha-ops', 'beta-ops', 'gamma-ops'].map((id) => ({
  id,
  name: id,
  description: `${id} docs`,
  keywords: [id],
  loadPriority: 5,
  category: 'development',
}));

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hewtd-subdir-'));
  roots.push(root);
  await mkdir(join(root, '.git'));
  await mkdir(join(root, '.claude'));
  await writeFile(join(root, '.claude/hit-em-with-the-docs.json'), JSON.stringify({ domains }));
  for (const d of domains) {
    await mkdir(join(root, '.documentation', d.id), { recursive: true });
    await writeFile(
      join(root, '.documentation', d.id, `${d.id}-guide.md`),
      `---\ntitle: ${d.id} guide\ntier: guide\ndomains:\n  - ${d.id}\nstatus: active\nlast_updated: '2026-07-13'\n---\n\n# ${d.id}\n\nBody.\n`,
    );
  }
  await mkdir(join(root, 'deep/er/dir'), { recursive: true });
  await writeFile(
    join(root, 'incoming.md'),
    `---\ntitle: Incoming\ntier: guide\ndomains:\n  - beta-ops\nstatus: active\nlast_updated: '2026-07-13'\n---\n\n# Incoming\n\nBody.\n`,
  );
  return root;
}

const run = (cwd: string, ...args: string[]) => spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
const generated = async (root: string) => ({
  index: await readFile(join(root, '.documentation/INDEX.md'), 'utf-8'),
  registry: await readFile(join(root, '.documentation/REGISTRY.md'), 'utf-8'),
});

beforeAll(() => expect(existsSync(CLI)).toBe(true));
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('project config from a subdirectory', () => {
  it('domain list sees the custom domains', async () => {
    const root = await project();
    const r = run(join(root, 'deep/er/dir'), 'domain', 'list', '--json');
    expect(r.status).toBe(0);
    for (const d of domains) expect(r.stdout).toContain(d.id);
  });

  it('index and integrate give byte-identical root indexes from a subdirectory', async () => {
    const [a, b] = [await project(), await project()];
    const sub = join(b, 'deep/er/dir');

    expect(run(a, 'index').status).toBe(0);
    expect(run(sub, 'index').status).toBe(0);
    const fromRoot = await generated(a);
    expect(fromRoot.index).toContain('gamma-ops');
    expect(await generated(b)).toEqual(fromRoot);

    expect(run(a, 'integrate', 'incoming.md', '-a').status).toBe(0);
    expect(run(sub, 'integrate', '../../../incoming.md', '-a').status).toBe(0);
    const afterRoot = await generated(a);
    expect(afterRoot.index).toContain('gamma-ops');
    expect(await generated(b)).toEqual(afterRoot);
  });

  it('a fact command from a subdirectory finds the project root config', async () => {
    const root = await project();
    const fromRoot = run(root, 'find-citers', 'nope');
    const fromSub = run(join(root, 'deep/er/dir'), 'find-citers', 'nope');
    expect(fromSub.status).toBe(fromRoot.status);
    expect(fromSub.stdout + fromSub.stderr).toBe(fromRoot.stdout + fromRoot.stderr);
  });
});
