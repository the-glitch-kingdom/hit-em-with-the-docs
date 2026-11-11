import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { parse_frontmatter } from '../../src/utils/frontmatter.js';

// #98: any doc created or updated with hewtd ends like a reconciled doc, through `reconcile --changed`.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const body = (title: string) => `# ${title}\n\nThis paragraph describes how ${title.toLowerCase()} works.\n\nCalls \`fetchUser()\` in \`src/user.ts\`.\n`;
const review_files = () => (existsSync(join(root, '.hewtd/reconcile')) ? readdirSync(join(root, '.hewtd/reconcile')).filter((f) => /^review-.*\.md$/.test(f)).sort() : []);

/** Judge every entry of a review file as the author would: verify, cite the source, write purpose and symptoms, tick accept. */
function fill(file: string): void {
  const path = join(root, '.hewtd/reconcile', file);
  const text = readFileSync(path, 'utf8')
    .replace(/```json\n([\s\S]*?)\n```/g, (_m, json) => '```json\n' + JSON.stringify({
      ...JSON.parse(json), verdict: 'verify', sources: ['src/user.ts'],
      frontmatter: { purpose: 'How do I fetch a user record from the store, and what does fetchUser return?', symptoms: ['user lookup returns nothing for a known id', 'fetchUser comes back empty'] },
    }, null, 2) + '\n```')
    .replaceAll('- [ ] accept', '- [x] accept');
  writeFileSync(path, text);
}
const changed = () => (JSON.parse(hewtd(['reconcile', '--changed', '--json']).stdout).docs as { path: string }[]).map((d) => d.path);

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'changed-98-'));
  put('src/user.ts', 'export function fetchUser() { return 1; }\n');
  put('.gitignore', '.hewtd/\n');
  put('.documentation/api/old.md', body('Old guide'));
  put('.documentation/api/stable.md', body('Stable guide'));
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
  // old + stable are reviewed (verify) in one batch
  expect(hewtd(['reconcile', 'api', '--write-review']).status).toBe(0);
  fill(review_files()[0]!);
  expect(hewtd(['reconcile', '--apply', join(root, '.hewtd/reconcile', review_files()[0]!)]).status).toBe(0);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('reconcile --changed (#98)', () => {
  it('lists the direct write, the integrated doc and the edited reviewed doc, and nothing else', () => {
    expect(changed()).toEqual([]);
    put('.documentation/api/direct.md', body('Direct write'));
    put('draft.md', body('Integrated draft'));
    expect(hewtd(['integrate', 'draft.md', '-a', '-d', 'api']).status).toBe(0);
    const old = join(root, '.documentation/api/old.md');
    writeFileSync(old, readFileSync(old, 'utf8') + '\nAn added paragraph about retries.\n');
    expect(changed()).toEqual(['api/direct.md', 'api/draft.md', 'api/old.md']);
    expect(changed()).toEqual(['api/direct.md', 'api/draft.md', 'api/old.md']); // listing writes no state
  });

  it('--write-review writes entries for exactly those, fill + apply ends all three reconciled and committed', () => {
    put('.documentation/api/direct.md', body('Direct write'));
    put('draft.md', body('Integrated draft'));
    hewtd(['integrate', 'draft.md', '-a', '-d', 'api']);
    const old = join(root, '.documentation/api/old.md');
    writeFileSync(old, readFileSync(old, 'utf8') + '\nAn added paragraph about retries.\n');
    const before = review_files().length;
    expect(hewtd(['reconcile', '--changed', '--write-review']).status).toBe(0);
    const files = review_files().slice(before);
    expect(files).toHaveLength(1);
    const text = readFileSync(join(root, '.hewtd/reconcile', files[0]!), 'utf8');
    expect([...text.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(['api/direct.md', 'api/draft.md', 'api/old.md']);
    fill(files[0]!);
    const applied = hewtd(['reconcile', '--apply', join(root, '.hewtd/reconcile', files[0]!)]);
    expect(applied.status).toBe(0);
    expect(g('status', '--porcelain', '--', '.documentation/api/direct.md', '.documentation/api/draft.md', '.documentation/api/old.md')).toBe('');
    const ledger = JSON.parse(readFileSync(join(root, '.hewtd/reconcile.json'), 'utf8')).entries;
    for (const name of ['direct', 'draft', 'old']) {
      const path = `api/${name}.md`;
      expect(ledger[path].verdict).toBe('verify');
      expect(parse_frontmatter<Record<string, unknown>>(readFileSync(join(root, '.documentation', path), 'utf8')).data.last_verified).toBeTruthy();
    }
    const triage = JSON.parse(hewtd(['reconcile', 'api', '--json']).stdout).docs as { path: string; lane: string }[];
    expect(triage.map((d) => d.lane)).toEqual(triage.map(() => 'clean'));
    expect(changed()).toEqual([]);
  });

  it('--status --changed prints the count', () => {
    put('.documentation/api/direct.md', body('Direct write'));
    const r = hewtd(['reconcile', '--status', '--changed']);
    expect(r.stdout + r.stderr).toMatch(/changed or new since review: 1/);
  });

  it('--check warns with the count and the command, exits 0 by default and 1 with reconcile.require_review', () => {
    put('.documentation/api/direct.md', body('Direct write'));
    const warn = hewtd(['reconcile', '--changed', '--check']);
    expect(warn.status).toBe(0);
    expect(warn.stdout + warn.stderr).toMatch(/1 doc.* not reviewed.*hewtd reconcile --changed --write-review/s);
    put('.claude/hit-em-with-the-docs.json', JSON.stringify({ reconcile: { require_review: true } }));
    const block = hewtd(['reconcile', '--changed', '--check']);
    expect(block.status).toBe(1);
    expect(block.stdout + block.stderr).toMatch(/require_review/);
  });

  it('audit warns DOCS_UNREVIEWED (advisory: --strict stays green)', () => {
    put('.documentation/api/direct.md', body('Direct write'));
    const r = hewtd(['audit']);
    expect(r.stdout + r.stderr).toMatch(/DOCS_UNREVIEWED/);
    expect(r.stdout + r.stderr).toMatch(/hewtd reconcile --changed --write-review/);
  });

  it('--cached --check looks only at staged docs', () => {
    put('.documentation/api/direct.md', body('Direct write'));
    expect(hewtd(['reconcile', '--changed', '--check', '--cached']).stdout).not.toMatch(/not reviewed/);
    g('add', '.documentation/api/direct.md');
    expect(hewtd(['reconcile', '--changed', '--check', '--cached']).stdout + '').toMatch(/1 doc.* not reviewed/s);
  });
});

describe('pre-commit hook block (#98)', () => {
  const OLD = '# >>> hewtd secrets >>>\nnpx --no-install hewtd secrets --staged || exit 1\n# <<< hewtd secrets <<<\n';
  it('install adds the review check to an older block of ours, uninstall removes the block', () => {
    const hook = join(root, '.git/hooks/pre-commit');
    put('.git/hooks/pre-commit', '#!/bin/sh\n' + OLD + 'echo mine\n');
    expect(hewtd(['hooks', 'install']).status).toBe(0);
    expect(readFileSync(hook, 'utf8')).toContain('hewtd reconcile --changed --check --cached || exit 1');
    expect(hewtd(['hooks', 'uninstall']).status).toBe(0);
    expect(readFileSync(hook, 'utf8')).toBe('#!/bin/sh\necho mine\n');
  });
});
