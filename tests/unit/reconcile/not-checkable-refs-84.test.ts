import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { load_plugin_config } from '../../../src/utils/config';
import { triage_docs } from '../../../src/core/reconcile/triage';

// One doc with an example of each class in #84: none of them is a deleted file, so none is `missing`.
const GOOD = [
  '---',
  'title: Good',
  'external_refs: [lib/thirdparty/thing.py]',
  '---',
  'Link text in a span: [`../auth/x.md`](../auth/x.md).',
  'Relative to this doc: `../auth/x.md` and `./sibling.md`.',
  'Ignored: `.venv/` and `dist/foo.html` and `.planning/my-plan/`.',
  'Placeholders: `YYYYMMDD_descriptive_name.py`, `support/.../update_only.py`, `<name>.py`, `{slug}.md`, `*.py`.',
  'Secret store: `secret/myapp/prod/.env` and `secret/<app>/prod/.env`.',
  'Patterns: `^backend/` and `src\\win\\path.ts`.',
  'Env: `FOO_DELTA_HOT_TIER`.',
  'Third party: `lib/thirdparty/thing.py`.',
  '',
].join('\n');
// no env line: another doc mentioning the name would already make it unknown
const BAD = GOOD.replace(/Env:.*\n/, '').trimEnd() + '\nGone: `src/deleted.ts` and `renamedGoneFn`.\n';

let dir: string;
const put = (rel: string, body: string) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };
const run = async (rels: string[]) => {
  const config = await load_plugin_config(dir);
  const result = await triage_docs({ root: dir, docs_root: join(dir, '.documentation'), rels, config });
  return Object.fromEntries(result.docs.map((doc) => [doc.path, doc.missing]));
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'not-checkable-84-'));
  put('.gitignore', '.venv/\ndist/\n.planning/\n');
  put('src/settings.py', 'foo_delta_hot_tier: int = 1\n');
  put('.documentation/auth/x.md', '---\ntitle: X\n---\nx\n');
  put('.documentation/ops/sibling.md', '---\ntitle: S\n---\ns\n');
  put('.documentation/ops/good.md', GOOD);
  put('.documentation/ops/bad.md', BAD);
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'ignore' });
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('refs that cannot be missing (#84)', () => {
  it('reports no missing ref for relative, ignored, placeholder, regex, secret-store, settings-backed and external refs', async () => {
    expect((await run(['ops/good.md']))['ops/good.md']).toEqual([]);
  });

  it('still reports a deleted file and a renamed symbol', async () => {
    expect((await run(['ops/bad.md']))['ops/bad.md']!.sort()).toEqual(['renamedGoneFn', 'src/deleted.ts']);
  });
});
