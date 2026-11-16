import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// #120 security review: a facet that overlaps a value is withheld, a positional phrase is never a name. Built CLI, `reconcile --gaps`.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const join_parts = (...parts: string[]): string => parts.join(''); // fakes are built at runtime, never a committed literal
const mysql_pw = join_parts('Sup3r', 'S3cret', 'Pw');
const curl_pair = join_parts('svc', 'user:Zx9Qw7', 'Lm2Rr');
const flag_pw = join_parts('hunt', 'er2xQ9');

// [name, file, line, facet]
const withheld: [string, string, string, string][] = [
  ['short flag glued password', 'a.sh', `mysql -h db1 -p${mysql_pw}`, `-p${mysql_pw}`],
  ['short flag glued user:pw', 'b.sh', `curl -u${curl_pair} https://svc.example/api`, `-u${curl_pair}`],
  ['partial overlap of a glued value', 'c.sh', `mysql -h db1 -p${mysql_pw}`, `db1 -pSup3`],
  ['long flag = password', 'd.sh', `tool --password=${flag_pw}`, `--password=${flag_pw}`],
  ['long flag with mixed-case value', 'e.sh', `tool --label=Ab${flag_pw}`, `--label=Ab${flag_pw}`],
  ['long flag value with digits', 'f.sh', 'git clone --depth 1 repo', '--depth 1'],
  ['--username alice', 'g.sh', 'tool --username alice', '--username alice'],
  ['--user alice', 'h.sh', 'tool --user alice', '--user alice'],
  ['--token space value', 'i.sh', 'tool --token abc123', '--token abc123'],
  ['positional password phrase', 'j.py', 'run("ledger deploy swordfish --prod")', 'ledger deploy swordfish --prod'],
  ['positional unlock phrase', 'k.py', 'run("unlock vault opensesame --now")', 'unlock vault opensesame --now'],
  ['diceware phrase', 'l.py', 'run("correct horse battery staple --verbose")', 'correct horse battery staple --verbose'],
  ['login phrase', 'm.py', 'run("login admin hunter --silent")', 'login admin hunter --silent'],
  ['ssh phrase', 'n.py', 'run("ssh jdoe bastion --force")', 'ssh jdoe bastion --force'],
  ['register phrase', 'o.py', 'run("register alice smith --force")', 'register alice smith --force'],
  ['su phrase', 'p.py', 'run("su postgres --login")', 'su postgres --login'],
  ['name also quoted as a value in a comment', 's2.py', '# emits user.created, see "user.created"', 'user.created'],
  ['tool phrase with a word after a flag', 'q.py', 'run("npm login --user alice")', 'npm login --user alice'],
  ['tool phrase with a short flag value', 'r.py', 'run("npm ci -psecretpw --prod")', 'npm ci -psecretpw --prod'],
  // review round 2: allowlists for option arguments, command phrases, file names
  ['option = person', 'x1.sh', 'kubectl get pods --as=alice', '--as=alice'],
  ['phrase with --passphrase=', 'x2.py', 'run("npm cmd --passphrase=swordfish")', 'npm cmd --passphrase=swordfish'],
  ['phrase login with positional', 'x3.py', 'run("npm login alice --force")', 'npm login alice --force'],
  ['phrase kubectl config set', 'x4.py', 'run("kubectl config set acme --force")', 'kubectl config set acme --force'],
  ['git remote add phrase', 'x5.py', 'run("git remote add origin2 --x=y")', 'git remote add origin2 --x=y'],
  ['--owner=acme', 'x6.sh', 'tool --owner=acme', '--owner=acme'],
  ['--email=x', 'x7.sh', 'tool --email=x', '--email=x'],
  ['--apikey=x', 'x8.sh', 'tool --apikey=x', '--apikey=x'],
  ['--pw=xyz1', 'x9.sh', 'tool --pw=xyz1', '--pw=xyz1'],
  ['--target build', 'y1.sh', 'tool --target build', '--target build'],
  ['data/alice.json', 'y2.py', 'load("data/alice.json")', 'data/alice.json'],
  ['acme-corp.json', 'y3.py', 'load("acme-corp.json")', 'acme-corp.json'],
  ['customers/acme/export.csv', 'y4.py', 'load("customers/acme/export.csv")', 'customers/acme/export.csv'],
];
const kept: [string, string, string, string][] = [
  ['long flag = word', 's.sh', 'npm ci --omit=dev', '--omit=dev'],
  ['tool phrase', 't.sh', 'npm audit fix --package-lock-only', 'npm audit fix --package-lock-only'],
  ['tool phrase in a literal', 'u.py', 'run("npm audit fix --package-lock-only")', 'npm audit fix --package-lock-only'],
  ['tool phrase with = flag in a literal', 'v.py', 'run("npm ci --omit=dev")', 'npm ci --omit=dev'],
  ['git phrase', 'w.py', 'run("git push --force-with-lease")', 'git push --force-with-lease'],
  ['fixture file name', 'z1.py', 'load("fixtures/x.json")', 'fixtures/x.json'],
];

let repo: string;
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', ...args], { cwd: repo });
const run = (facet: string) => {
  writeFileSync(join(repo, 'gaps.json'), JSON.stringify({ version: 1, source: 'fixture', gaps: [{ id: 'q', query: 'how does it run', facets: [escape(facet)] }] }));
  const result = spawnSync('node', [CLI, 'reconcile', '--gaps', 'gaps.json', '--json'], { cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: repo } });
  expect(result.status).toBe(0);
  const out = JSON.parse(result.stdout);
  const on_disk = (readdirSync(repo, { recursive: true }) as string[]).filter((f) => (f.startsWith('.documentation') || f.startsWith('.hewtd')) && /\.(md|json)$/.test(f)).map((f) => { try { return readFileSync(join(repo, f), 'utf-8'); } catch { return ''; } }).join('\n');
  return { out, text: `${result.stdout}\n${on_disk}` };
};

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests');
  repo = mkdtempSync(join(tmpdir(), 'overlap120-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  for (const [, file, line] of [...withheld, ...kept]) writeFileSync(join(repo, 'src', file), `${line}\n`);
  writeFileSync(join(repo, '.gitignore'), '.hewtd/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'i');
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('reconcile --gaps withholds a facet that overlaps a value (#120)', () => {
  for (const [name, , , facet] of withheld) {
    it(`withholds: ${name}`, () => {
      const { out, text } = run(facet);
      const proposal = out.coverage.proposals.find((p: any) => p.closes.some((c: any) => c.key === 'q'));
      expect(proposal?.missing_facets ?? []).toEqual([]);
      expect(text).not.toContain(facet);
    });
  }
  for (const [name, , , facet] of kept) {
    it(`keeps the name: ${name}`, () => {
      const { out } = run(facet);
      const proposal = out.coverage.proposals.find((p: any) => p.closes.some((c: any) => c.key === 'q'));
      expect(proposal?.missing_facets).toEqual([escape(facet)]);
    });
  }
});
