import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Issue #74 acceptance checks through the built CLI, in temp git repos.
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
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ft74-')); put('.gitignore', '.hewtd/\n'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('generic-secret reports literals only (#74)', () => {
  it('code, wrapped placeholders, regexes, abc123 placeholders and digit-bearing emails are not secrets; a random literal is', () => {
    put('.documentation/backend/kinds.md', fm('kinds', [
      'API_KEY = req.headers.authorization', 'password = hash(password)', 'token = <your-token-here>',
      'secret = [from-the-vault]', 'PATTERN_KEY = ^[A-Za-z0-9_-]{32,64}$', 'password = abc123def456ghi789',
      'API_KEY = j.smith2@corp-01.io', 'token = ops-team@acme2go.com',
    ].join('\n\n')));
    put('.documentation/backend/real.md', fm('real', `API_KEY = ${random_literal}\n\npassword = abc123${random_literal}`));
    commit();
    const found = secrets();
    expect(found.filter((f) => f.file.endsWith('kinds.md') && f.rule === 'generic-secret')).toEqual([]);
    expect(found.filter((f) => f.file.endsWith('real.md') && f.rule === 'generic-secret')).toHaveLength(2); // a placeholder prefix never excuses a random tail
    const lane = lanes();
    expect(lane['backend/kinds.md']).not.toBe('secret');
    expect(lane['backend/real.md']).toBe('secret');
  });

  it('an email-only doc is never in the secret lane', () => {
    put('.documentation/backend/mail.md', fm('mail', 'API_KEY = j.smith2@corp-01.io\n\nSECRET = JaneDoe1987@gmail.com'));
    commit();
    expect(lanes()['backend/mail.md']).not.toBe('secret');
    expect(secrets().filter((f) => f.file.endsWith('mail.md') && f.rule === 'generic-secret')).toEqual([]);
  });
});

describe('incremental index after a one-doc edit (#74)', () => {
  const cold = (): string => {
    rmSync(join(root, '.hewtd/graph.json'), { force: true });
    rmSync(join(root, '.hewtd/graph-cache.json'), { force: true });
    hewtd(['index']);
    return read('.hewtd/graph.json');
  };

  it('equals a cold build after editing, adding and removing docs, and the cache keeps per-doc entries', () => {
    put('src/a.ts', 'export function alphaUnit() { return 1; }\n');
    for (let i = 0; i < 6; i++) put(`.documentation/backend/d${i}.md`, fm(`d${i}`, `See \`src/a.ts\`, \`alphaUnit()\`, \`GhostName${i}\` and [next](./d${(i + 1) % 6}.md).`));
    commit();
    expect(hewtd(['index']).status).toBe(0);
    const doc_cache = JSON.parse(read('.hewtd/graph-cache.json')).doc_cache;
    expect(Object.keys(doc_cache.entries)).toHaveLength(6);
    put('.documentation/backend/d2.md', fm('d2', 'Changed; see `src/gone.ts` and `GhostName4`.'));
    expect(hewtd(['index']).status).toBe(0);
    const edited = read('.hewtd/graph.json');
    put('.documentation/backend/d6.md', fm('d6', 'New doc about `GhostName1` and [d0](./d0.md).'));
    rmSync(join(root, '.documentation/backend/d3.md'));
    expect(hewtd(['index']).status).toBe(0);
    const changed = read('.hewtd/graph.json');
    expect(changed).not.toBe(edited);
    expect(cold()).toBe(changed);
  });

  it('a code edit and a malformed cache both fall back to a correct full build', () => {
    put('src/a.ts', 'export function alphaUnit() { return 1; }\n');
    put('.documentation/backend/a.md', fm('a', 'See `alphaUnit()` and `betaUnit()`.'));
    commit();
    hewtd(['index']);
    put('src/b.ts', 'export function betaUnit() { return 2; }\n');
    expect(hewtd(['index']).status).toBe(0);
    const after_code = read('.hewtd/graph.json');
    writeFileSync(join(root, '.hewtd/graph-cache.json'), '{"doc_cache": {"state": 5, "entries": []}}');
    expect(hewtd(['index']).status).toBe(0);
    expect(read('.hewtd/graph.json')).toBe(after_code);
    expect(cold()).toBe(after_code);
  });
});
