import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { add_known_symbols, build_repo_index, check_doc_references, find_md_mentions } from '../../../src/core/reconcile/references.js';
import { discover_outside } from '../../../src/core/reconcile/outside.js';
import { scan_peripheral } from '../../../src/core/reconcile/triage.js';
import { scan_staged } from '../../../src/core/reconcile/hooks.js';
import { list_committed_changes } from '../../../src/core/graph/cache.js';
import { load_plugin_config } from '../../../src/utils/config.js';
import { DEFAULT_RECONCILE_KEEP_IN_PLACE } from '../../../src/utils/config.js';

// #97: a committed cold generation is history. Every repo-wide scanner must behave as if it were not there.
let root: string;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=A', '-c', 'user.email=a@a', ...args], { cwd: root, encoding: 'utf-8' });
const put = (rel: string, text: string): void => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const fake_key = (): string => ['AKIA', 'QWERTYUIOPASDFGH'].join(''); // built at runtime
const COLD = '.documentation-cold/2026-01-01';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cold-invisible-'));
  put('src/real.ts', 'export const realThing = 1;\n');
  put('.documentation/a.md', '# a\n');
  put('vendor/src/outside-cold.ts', 'export const OutsideColdCode = 1;\n'); // control: suffix resolution works outside the cold root
  git('init', '-q');
  git('add', '-A'); git('commit', '-qm', 'base');
  put(`${COLD}/src/only-cold.ts`, 'export const OnlyInColdCode = 1;\n');
  put(`${COLD}/old/note.md`, `# old\nMentions OnlyInColdMention here. key=${fake_key()}\n`);
  put(`${COLD}/old/stray.md`, '# stray cold doc\n\nSome long enough text so that this is a doc and not junk or a stub at all, really.\n');
  git('add', '-A'); git('commit', '-qm', 'rotate');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('a cold generation is invisible to every repo-wide scanner (#97)', () => {
  it('path references never resolve into it (control: they do outside it)', async () => {
    const index = build_repo_index(root);
    const refs = await check_doc_references(index, 'See `src/only-cold.ts` and `src/outside-cold.ts`.', { doc_file: join(root, '.documentation/x.md'), docs_root: join(root, '.documentation') });
    expect(refs.find((ref) => ref.ref === 'src/only-cold.ts')?.status).toBe('missing');
    expect(refs.find((ref) => ref.ref === 'src/outside-cold.ts')?.status).toBe('ok');
  });

  it('a name mentioned only in a cold doc is not found by the mention search', () => {
    expect(find_md_mentions(root, ['OnlyInColdMention']).size).toBe(0);
  });

  it('a symbol defined only in cold code is not found by the symbol search', () => {
    const index = build_repo_index(root);
    add_known_symbols(index, ['OnlyInColdCode', 'OutsideColdCode']);
    expect(index.symbols.get('OnlyInColdCode') ?? null).toBeNull();
    expect(index.symbols.get('OutsideColdCode')).toBe('vendor/src/outside-cold.ts');
  });

  it('the outside lane never offers a cold doc', async () => {
    const found = await discover_outside(join(root, '.documentation'), DEFAULT_RECONCILE_KEEP_IN_PLACE);
    expect(found.filter((doc) => doc.path.startsWith('.documentation-cold'))).toEqual([]);
  });

  it('the peripheral secret scan skips it (its findings are in the manifest)', async () => {
    const found = await scan_peripheral(root, join(root, '.documentation'), await load_plugin_config(root));
    expect(found.filter((finding) => finding.file.startsWith('.documentation-cold'))).toEqual([]);
  });

  it('the staged-secrets scan skips it even when the docs root contains it, and still flags other files', async () => {
    const config = (await load_plugin_config(root)).reconcile.secrets;
    put(`${COLD}/old/added.md`, `added ${fake_key()}\n`);
    put('plain.md', `added ${fake_key()}\n`);
    git('add', '-A', '-f');
    const found = scan_staged(root, root, config);
    expect(found.map((finding) => finding.file)).toEqual(['plain.md']);
    git('reset', '-q');
    rmSync(join(root, 'plain.md')); rmSync(join(root, COLD, 'old/added.md'));
  });

  it('the incremental graph ignores cold paths in a commit range', () => {
    const changed = list_committed_changes(root, git('rev-parse', 'HEAD~1').trim(), git('rev-parse', 'HEAD').trim());
    expect([...(changed ?? [])].filter((file) => file.startsWith('.documentation-cold'))).toEqual([]);
  });
});
