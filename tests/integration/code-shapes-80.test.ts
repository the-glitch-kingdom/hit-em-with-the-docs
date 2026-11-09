import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Issue #80 acceptance checks through the built CLI, in temp git repos.
// Secret-shaped fixtures are built at runtime from fragments.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const random_literal = ['Tq9xZ4mW', '7pLr2Vb8', 'Kd5Hn3Yc'].join('');
let root: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const fm = (t: string, body: string) => `---\ntitle: ${t}\ndomains:\n  - backend\n---\n\n# ${t}\n\n${body}\n`;
const lanes = () => Object.fromEntries((JSON.parse(hewtd(['reconcile', '--next', '1000', '--json']).stdout).docs as { path: string; lane: string }[]).map((d) => [d.path, d.lane]));
const secrets = () => JSON.parse(hewtd(['reconcile', '--secrets', '--json']).stdout) as { file: string; rule: string }[];
const commit = () => { g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init'); };

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ft80-')); put('.gitignore', '.hewtd/\n'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('structured code, CSS functions, markdown links and $VAR references are not generic-secret (#80)', () => {
  it('a doc holding every #80 row has no generic-secret and is not in the secret lane', () => {
    put('.documentation/backend/code.md', fm('code', [
      'token_expiry = datetime.utcnow() + timedelta(hours=1)', 'api_key = settings.qdrant_api_key',
      "'new-token': 'hsl(var(--new-token))'", '- Get token: [codecov.io](https://codecov.io)',
      'sed -i "s/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=$NEW_KEY/" .env', 'api_key = ${QDRANT_API_KEY}/v1',
      'token: `login rejected offline token: code 401`',
    ].join('\n\n')));
    commit();
    expect(secrets().filter((f) => f.file.endsWith('code.md') && f.rule === 'generic-secret')).toEqual([]);
    expect(lanes()['backend/code.md']).not.toBe('secret');
  });

  it('literal values in the same shapes are still found and the doc is in the secret lane', () => {
    const hex = ['9f8e7d6c', '5b4a3f2e', '1d0c9b8a', '7f6e5d4c'].join('');
    put('.documentation/backend/real.md', fm('real', [
      `api_key = settings.${random_literal}`, `token = client.${random_literal}()`, `token: hsl(${random_literal})`,
      `token: [${random_literal}](https://docs.acme.dev/x)`, `api_key = "${random_literal}/$HOME"`, `password = ${hex}`,
    ].join('\n\n')));
    commit();
    expect(secrets().filter((f) => f.file.endsWith('real.md') && f.rule === 'generic-secret').length).toBeGreaterThanOrEqual(4);
    expect(lanes()['backend/real.md']).toBe('secret');
  });
});
