import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Issue #72 acceptance checks through the built CLI, in temp git repos.
// Secret-shaped fixtures are built at runtime from fragments.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const hvs = 'hv' + 's.' + 'q7Zx3Lm9Pw2Rt8Vb5Nc1';
const stripe_placeholder = 'sk' + '_test_51ABCDEF' + 'abcdef1234567890';
let root: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const read = (rel: string) => readFileSync(join(root, rel), 'utf-8');
const fm = (t: string, body: string) => `---\ntitle: ${t}\ndomains:\n  - backend\n---\n\n# ${t}\n\n${body}\n`;
const graph_text = () => read('.hewtd/graph.json');
const lanes = () => Object.fromEntries((JSON.parse(hewtd(['reconcile', '--next', '1000', '--json']).stdout).docs as { path: string; lane: string }[]).map((d) => [d.path, d.lane]));
const commit = () => { g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init'); };

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ft72-')); put('.gitignore', '.hewtd/\n'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('surgical frontmatter writers (#72)', () => {
  it('fix-retrieval-fields --apply changes only the moved and dropped keys, line by line', () => {
    const before = [
      '---', 'title: "Quoted: title"', '# keep this comment', 'last_updated: 2024-01-05', 'domains: [backend]',
      "summary: 'Drain the queue, pin the previous image, then re-enable workers one at a time to roll back safely'", 'tags: [a]', 'keywords: [b, a]', '---', '', '# T', '', 'Body.', '',
    ].join('\n');
    put('.documentation/backend/a.md', before);
    commit();
    expect(hewtd(['fix-retrieval-fields', '--apply']).status).toBe(0);
    const after = read('.documentation/backend/a.md').split('\n');
    const untouched = ['---', 'title: "Quoted: title"', '# keep this comment', 'last_updated: 2024-01-05', 'domains: [backend]', '---', '', '# T', '', 'Body.', ''];
    for (const line of untouched) expect(after).toContain(line);
    const changed = after.filter((l) => !untouched.includes(l));
    expect(changed.join('\n')).toMatch(/purpose: .*pin the previous image/);
    expect(changed.join('\n')).not.toMatch(/summary|keywords/);
    expect(changed.length).toBeLessThanOrEqual(6); // purpose + tags (block or flow), nothing else
  });
});

describe('secret lane (#72)', () => {
  it('a doc linking to a doc with a real finding is not secret; the linked doc is', () => {
    put('.documentation/backend/b.md', fm('b', `token ${hvs}`));
    put('.documentation/backend/a.md', fm('a', 'See [b](b.md) for setup.'));
    commit();
    const l = lanes();
    expect(l['backend/a.md']).not.toBe('secret');
    expect(l['backend/b.md']).toBe('secret');
    expect(hewtd(['index']).status).toBe(0);
    const docs = JSON.parse(graph_text()).docs;
    expect(docs['backend/a.md'].verdict).not.toBe('secret');
    expect(docs['backend/b.md'].verdict).toBe('secret');
  });

  it('placeholders, short url passwords, regexes and code are not findings; real values are', () => {
    put('.documentation/backend/p.md', fm('p', [
      'postgres://user:pass@db/x', 'token: abc123def456ghi789jkl', `API_KEY=${stripe_placeholder}`,
      'API_KEY_PATTERN=^[A-Za-z0-9_-]{32,64}$', 'PASSWORD=req.body.password',
    ].join('\n\n')));
    put('.documentation/backend/r.md', fm('r', `token ${hvs}\n\npostgres://app:Tq9xZ4mW7pLr2Vb8@db/x`));
    commit();
    const found = JSON.parse(hewtd(['reconcile', '--secrets', '--json']).stdout) as { file: string }[];
    expect(found.filter((f) => f.file.endsWith('p.md'))).toEqual([]);
    expect(found.filter((f) => f.file.endsWith('r.md')).length).toBeGreaterThanOrEqual(2);
  });
});

describe('runtime expressions (#72)', () => {
  it('import.meta.env, process.env and os.environ export no file ref; named vars are env refs', () => {
    put('.documentation/backend/e.md', fm('e', 'Read `import.meta.env`, `process.env`, `os.environ` and `process.env.API_URL`; see `src/gone.ts`.'));
    commit();
    expect(hewtd(['index']).status).toBe(0);
    const refs = JSON.parse(graph_text()).docs['backend/e.md'].refs as { kind: string; target: string }[];
    const files = refs.filter((r) => r.kind === 'file').map((r) => r.target);
    expect(files).toEqual(['src/gone.ts']);
    expect(refs).toContainEqual(expect.objectContaining({ kind: 'env', target: 'API_URL' }));
  });
});

describe('incremental index (#72)', () => {
  const tree = () => {
    put('src/a.ts', 'export function alpha() { return 1; }\n');
    put('.documentation/backend/a.md', fm('a', 'Uses `alpha()` in `src/a.ts`.'));
    put('.documentation/backend/b.md', fm('b', 'Uses `src/missing.ts`.'));
    commit();
  };
  const cold = (): string => {
    rmSync(join(root, '.hewtd/graph.json'), { force: true });
    rmSync(join(root, '.hewtd/graph-cache.json'), { force: true });
    hewtd(['index']);
    return graph_text();
  };

  it('second index on an unchanged tree reuses the export; after an edit it equals a cold build', () => {
    tree();
    expect(hewtd(['index']).status).toBe(0);
    const first = graph_text();
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(root, '.hewtd/graph.json'), old, old);
    const second = hewtd(['index']);
    expect(second.stdout).not.toMatch(/Graph export written/);
    expect(statSync(join(root, '.hewtd/graph.json')).mtimeMs).toBeCloseTo(old.getTime(), -1);
    expect(graph_text()).toBe(first);

    put('.documentation/backend/b.md', fm('b', 'Now uses `alpha()` and `src/a.ts`.'));
    expect(hewtd(['index']).status).toBe(0);
    const incremental = graph_text();
    expect(incremental).not.toBe(first);
    expect(cold()).toBe(incremental);
  });

  it('a hand-edited graph.json is rebuilt, not trusted', () => {
    tree();
    hewtd(['index']);
    const good = graph_text();
    writeFileSync(join(root, '.hewtd/graph.json'), '{"tampered":true}\n');
    hewtd(['index']);
    expect(graph_text()).toBe(good);
  });

  it('a corrupt cache file is ignored and rebuilt', () => {
    tree();
    hewtd(['index']);
    const good = graph_text();
    writeFileSync(join(root, '.hewtd/graph-cache.json'), '{not json');
    rmSync(join(root, '.hewtd/graph.json'));
    expect(hewtd(['index']).status).toBe(0);
    expect(graph_text()).toBe(good);
  });
});

describe('apply commits (#72)', () => {
  it('a gaps phrases apply commit touches only the phrase docs', () => {
    const doc = (t: string) => `---\ntitle: ${t}\ndomains:\n  - backend\ntier: guide\nlast_verified: "2026-01-01"\n---\n\n# ${t}\n\nBody of ${t}.\n`;
    put('.documentation/backend/release.md', doc('Release'));
    put('.documentation/backend/other.md', doc('Other'));
    commit();
    put('gaps.json', JSON.stringify([{ query: 'how do I roll back a bad deploy', used_doc: 'backend/release.md', count: 3 }]));
    const out = JSON.parse(hewtd(['reconcile', '--gaps', 'gaps.json', '--write-review', '--json']).stdout);
    const review = join(root, out.review);
    writeFileSync(review, readFileSync(review, 'utf-8').replace('- [ ] accept', '- [x] accept'));
    const before = g('rev-parse', 'HEAD');
    expect(hewtd(['reconcile', '--apply', review]).status).toBe(0);
    expect(g('rev-list', '--count', `${before}..HEAD`)).toBe('1');
    expect(g('show', '--name-only', '--format=', 'HEAD')).toBe('.documentation/backend/release.md');
  });
});
