import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// #84 through the built CLI: refs that cannot be repo files are not missing; real losses still are.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const fm = (title: string, body: string) => `---\ntitle: ${title}\ndomains:\n  - backend\n---\n\n# ${title}\n\n${body}\n`;
const triage = (rel: string) => JSON.parse(hewtd(['reconcile', rel, '--json']).stdout).docs.find((doc: { path: string }) => doc.path.endsWith(rel));

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'not-checkable-cli-84-'));
  put('.gitignore', '.hewtd/\n.venv/\n');
  put('src/real.ts', 'export const realThing = 1;\n');
  put('.documentation/backend/ok.md', fm('ok', 'Real: `src/real.ts`. Not files: `.venv/`, `YYYYMMDD_x.py`, `<name>.py`, `secret/app/prod/.env`, `^src/`.'));
  // three false positives only: the old code saw three missing refs and filed this doc under archive-candidate
  put('.documentation/backend/fp.md', fm('fp', 'See `.venv/`, `support/.../x.py` and `secret/app/.env`.'));
  put('.documentation/backend/gone.md', fm('gone', 'See `src/x1.ts`, `src/x2.ts`, `src/x3.ts` and `renamedGoneFn`.'));
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('not-checkable refs (built CLI, #84)', () => {
  it('a doc whose refs are all not-checkable has no missing and is not filed under archive-candidate', () => {
    for (const rel of ['backend/ok.md', 'backend/fp.md']) {
      const doc = triage(rel);
      expect(doc.missing).toEqual([]);
      expect(doc.lane).not.toBe('archive-candidate');
    }
  });

  it('a deleted file and a renamed symbol are still missing, and the lane still says so', () => {
    const doc = triage('backend/gone.md');
    expect([...doc.missing].sort()).toEqual(['renamedGoneFn', 'src/x1.ts', 'src/x2.ts', 'src/x3.ts']);
    expect(doc.lane).toBe('archive-candidate');
  });

  it('the graph shows not-checkable refs as resolved:null and real losses as resolved:false', () => {
    expect(hewtd(['index']).status).toBe(0);
    const graph = JSON.parse(readFileSync(join(root, '.hewtd/graph.json'), 'utf-8'));
    const resolved = (doc: string, target: string) => graph.docs[doc].refs.find((ref: { target: string }) => ref.target === target)?.resolved;
    expect(resolved('backend/fp.md', '.venv/')).toBeNull();
    expect(resolved('backend/ok.md', 'src/real.ts')).toBe(true);
    expect(resolved('backend/gone.md', 'src/x1.ts')).toBe(false);
  });
});
