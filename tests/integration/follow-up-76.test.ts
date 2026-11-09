import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Issue #76 acceptance checks through the built CLI, in temp git repos.
// Secret-shaped fixtures are built at runtime from fragments.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const random_literal = ['Tq9xZ4mW', '7pLr2Vb8', 'Kd5Hn3Yc'].join('');
let root: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const read = (rel: string) => readFileSync(join(root, rel), 'utf-8');
const fm = (t: string, body: string) => `---\ntitle: ${t}\ndomains:\n  - backend\n---\n\n# ${t}\n\n${body}\n`;
const lanes = () => Object.fromEntries((JSON.parse(hewtd(['reconcile', '--next', '1000', '--json']).stdout).docs as { path: string; lane: string }[]).map((d) => [d.path, d.lane]));
const secrets = () => JSON.parse(hewtd(['reconcile', '--secrets', '--json']).stdout) as { file: string; rule: string }[];
const commit = () => { g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init'); };

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ft76-')); put('.gitignore', '.hewtd/\n'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('identifiers with acronyms and camel joins are not generic-secret (#76)', () => {
  it('settings and manager calls, placeholders and camel names are clean; a random literal is the secret', () => {
    put('.documentation/backend/code.md', fm('code', [
      'api_key = settings.get_secret("x")', 'self.k = manager.get("x")', 'API_KEY = settings.openAIApiKey',
      'API_KEY = manager.getAPIKey(provider)', 'VAULT_TOKEN=<root-token>', 'API_KEY = minLengthRequirement12',
      'API_KEY = LLMProviderKey', 'TOKEN = <root-token-from-init>',
    ].join('\n\n')));
    put('.documentation/backend/real.md', fm('real', `API_KEY = ${random_literal}\n\nTOKEN = settings.openAIApiKey${random_literal}`));
    commit();
    const found = secrets();
    expect(found.filter((f) => f.file.endsWith('code.md') && f.rule === 'generic-secret')).toEqual([]);
    expect(found.filter((f) => f.file.endsWith('real.md') && f.rule === 'generic-secret').length).toBeGreaterThanOrEqual(1);
    const lane = lanes();
    expect(lane['backend/code.md']).not.toBe('secret');
    expect(lane['backend/real.md']).toBe('secret');
  });

  it('an email-only doc (acronym and digit addresses) is never verdict secret in graph.json', () => {
    put('.documentation/backend/mail.md', fm('mail', [
      'API_KEY = QATeam@acme.com', 'SECRET = DevOps-Oncall2@corp-01.io', 'token = j.smith2@acme2go.com',
      'Contact SREOnCall@example.org, OpenAIBilling@acme.com or "ops-team@corp.io".',
    ].join('\n\n')));
    commit();
    expect(hewtd(['index']).status).toBe(0);
    expect(JSON.parse(read('.hewtd/graph.json')).docs['backend/mail.md'].verdict).not.toBe('secret');
    expect(secrets().filter((f) => f.file.endsWith('mail.md') && f.rule === 'generic-secret')).toEqual([]);
  });
});

describe('a docs-only commit keeps the incremental graph equal to a cold build (#76)', () => {
  it('reuses the cache across a docs-only commit and still matches cold, with a changed doc re-resolved', () => {
    put('src/a.ts', 'export function alphaUnit() { return 1; }\n');
    for (let i = 0; i < 4; i++) put(`.documentation/backend/d${i}.md`, fm(`d${i}`, `See \`src/a.ts\`, \`alphaUnit()\`, \`GhostName${i}\` and [next](./d${(i + 1) % 4}.md).`));
    commit();
    expect(hewtd(['index']).status).toBe(0);
    const before = JSON.parse(read('.hewtd/graph-cache.json')).doc_cache;
    put('.documentation/backend/d1.md', fm('d1', 'Changed; see `src/a.ts` and `GhostName3`.'));
    put('.documentation/backend/d4.md', fm('d4', 'New; see `alphaUnit()` and [d0](./d0.md).'));
    g('add', '-A'); g('commit', '-qm', 'docs only');
    expect(hewtd(['index']).status).toBe(0);
    const after = JSON.parse(read('.hewtd/graph-cache.json')).doc_cache;
    expect(after.state).toBe(before.state); // a docs-only commit does not change the code state key
    const incremental = read('.hewtd/graph.json');
    rmSync(join(root, '.hewtd/graph.json'), { force: true });
    rmSync(join(root, '.hewtd/graph-cache.json'), { force: true });
    expect(hewtd(['index']).status).toBe(0);
    expect(read('.hewtd/graph.json')).toBe(incremental);
  });

  it('a code commit changes the code state key and the graph still equals a cold build', () => {
    put('src/a.ts', 'export function alphaUnit() { return 1; }\n');
    put('.documentation/backend/a.md', fm('a', 'See `alphaUnit()` and `betaUnit()`.'));
    commit();
    hewtd(['index']);
    const before = JSON.parse(read('.hewtd/graph-cache.json')).doc_cache.state;
    put('src/b.ts', 'export function betaUnit() { return 2; }\n');
    g('add', '-A'); g('commit', '-qm', 'code');
    expect(hewtd(['index']).status).toBe(0);
    expect(JSON.parse(read('.hewtd/graph-cache.json')).doc_cache.state).not.toBe(before);
    const incremental = read('.hewtd/graph.json');
    rmSync(join(root, '.hewtd/graph-cache.json'), { force: true });
    hewtd(['index']);
    expect(read('.hewtd/graph.json')).toBe(incremental);
  });
});
