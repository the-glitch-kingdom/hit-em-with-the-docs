import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { parse } from 'yaml';

// Issue #69 acceptance checks through the built CLI, in temp git repos.
// Secret-shaped fixtures are built at runtime from fragments.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const key = 'AK' + 'IA' + 'ZXCVBNMASDFGHJKL';
const hvs = 'hv' + 's.' + 'q7Zx3Lm9Pw2Rt8Vb5Nc1';
const uuid = ['3f9a1c2e', '7b4d', '4e8a', '9c1f', '5d2b6a7e8c90'].join('-');
const kv = 'Tq9' + 'xZ4mW' + '7pLr2' + 'Vb8NcK5';
let root: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const read = (rel: string) => readFileSync(join(root, rel), 'utf-8');
const fm = (t: string, body: string) => `---\ntitle: ${t}\ndomains:\n  - backend\n---\n\n# ${t}\n\n${body}\n`;
const graph = () => JSON.parse(read('.hewtd/graph.json'));
const lanes = () => Object.fromEntries((JSON.parse(hewtd(['reconcile', '--next', '1000', '--json']).stdout).docs as { path: string; lane: string }[]).map((d) => [d.path, d.lane]));

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ft69-')); put('.gitignore', '.hewtd/\n'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const commit = () => { g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init'); };

describe('graph export (#69)', () => {
  it('symbol points at its defining file; JSON never beats source; plan docs are exported', () => {
    put('src/auth.py', 'def require_role(role):\n    return role\n');
    put('a0/caller.py', 'require_role("y")\n');
    put('a1.json', '{"onlyMentioned": 1}\n');
    put('z/use.ts', 'onlyMentioned();\n');
    put('.documentation/backend/a.md', fm('a', 'Uses `require_role()` and `onlyMentioned()`; see `src/gone.ts`.'));
    put('.documentation/plans/p.md', '---\ntitle: p\ntier: plan\ndomains:\n  - backend\n---\n\n# p\n\nSee `src/planned.ts`.\n');
    put('.documentation/drafts/d.md', fm('d', 'Draft.'));
    commit();
    expect(hewtd(['index']).status).toBe(0);
    const gr = graph();
    expect(gr.symbols.require_role).toMatchObject({ file: 'src/auth.py', file_kind: 'definition' });
    expect(gr.symbols.onlyMentioned).toMatchObject({ file: 'z/use.ts', file_kind: 'reference' });
    expect(gr.docs['plans/p.md'].refs).toContainEqual({ kind: 'file', target: 'src/planned.ts', resolved: false });
    expect(Object.keys(gr.docs).sort()).toEqual(Object.keys(lanes()).sort());
    expect(gr.docs['drafts/d.md']).toBeDefined();
  });

  it('index --no-graph writes nothing; plain index writes it', () => {
    put('.documentation/backend/a.md', fm('a', 'x'));
    commit();
    expect(hewtd(['index', '--no-graph']).status).toBe(0);
    expect(existsSync(join(root, '.hewtd/graph.json'))).toBe(false);
    hewtd(['index']);
    expect(existsSync(join(root, '.hewtd/graph.json'))).toBe(true);
  });
});

describe('secret lane (#69)', () => {
  it('code expressions and emails do not block; a real token in a cited file does', () => {
    put('src/settings.py', 'url = f"postgres://u:{db_password}@h/db"\nclass S:\n    def f(self):\n        token = self.vault_token\n        secret = settings.API_SECRET\n        password = get_password(user)\n');
    put('src/creds.ts', `export const k = '${key}';\n`);
    put('.documentation/backend/settings.md', fm('settings', 'See `src/settings.py`.'));
    put('.documentation/backend/creds.md', fm('creds', 'See `src/creds.ts`.'));
    put('.documentation/backend/mail.md', fm('mail', 'secret_contact = ops@example.com'));
    put('.documentation/backend/ptr.md', fm('ptr', 'VAULT_TOKEN=<secret: HEWTD_SECRET_VAULT_TOKEN, see .env.hewtd>'));
    commit();
    const l = lanes();
    expect(l['backend/settings.md']).not.toBe('secret');
    expect(l['backend/mail.md']).not.toBe('secret');
    expect(l['backend/ptr.md']).not.toBe('secret');
    expect(l['backend/creds.md']).toBe('secret');
    const f = JSON.parse(hewtd(['reconcile', '--secrets', '--json']).stdout) as { file: string }[];
    expect(f.filter((x) => x.file.endsWith('ptr.md'))).toEqual([]);
  });

  it('recall: short hvs token, AppRole ids and kv put values are found, masked', () => {
    put('.documentation/backend/r.md', fm('r', [`token ${hvs}`, `vault write auth/approle/login --role-id ${uuid}`, `Role ID: ${uuid.replace('3f9a', '4a9f')}`, `vault kv put secret/app data=${kv}`].join('\n\n')));
    commit();
    const r = hewtd(['reconcile', '--secrets', '--json']);
    const f = JSON.parse(r.stdout) as { file: string; rule: string }[];
    const rules = f.filter((x) => x.file.endsWith('r.md')).map((x) => x.rule);
    expect(rules).toEqual(expect.arrayContaining(['vault-token', 'approle-id', 'vault-kv-value']));
    expect(r.stdout + r.stderr).not.toContain(hvs);
    expect(r.stdout + r.stderr).not.toContain(kv);
  });
});

describe('gaps and apply (#69)', () => {
  it('a 150-character query becomes a proposal and applies; other frontmatter bytes are untouched', () => {
    const original = '---\ntitle: "Title"\ncreated: 2026-07-31\ndomains:\n  - backend\ntier: guide\nlast_verified: "2026-01-01"\n# keep me\nowner:   ann\n---\n\n# T\n\n\nBody.\n';
    put('.documentation/backend/release.md', original);
    const q = 'how do I roll back a bad deploy of the release pipeline when the canary fails health checks and traffic is already shifted to the new version'.slice(0, 150).replace(/\s+\S*$/, '');
    expect(q.length).toBeGreaterThan(120);
    put('gaps.json', JSON.stringify([{ query: q, used_doc: 'backend/release.md', count: 3 }]));
    commit();
    const out = JSON.parse(hewtd(['reconcile', '--gaps', 'gaps.json', '--write-review', '--json']).stdout);
    expect(out.proposals[0].accepted[0].query).toBe(q);
    const review = join(root, out.review);
    writeFileSync(review, readFileSync(review, 'utf-8').replace('- [ ] accept', '- [x] accept'));
    expect(hewtd(['reconcile', '--apply', review]).status).toBe(0);
    const after = read('.documentation/backend/release.md');
    expect(parse(after.split('\n---\n')[0]!.slice(4)).symptoms.join(' ')).toContain(q);
    const head = (t: string) => t.split('\n---\n')[0]!.split('\n');
    const lines = head(after);
    expect(lines.slice(0, head(original).length)).toEqual(head(original));
    expect(after.slice(after.indexOf('\n---\n'))).toContain('\n\n# T\n\n\nBody.\n');
  });
});
