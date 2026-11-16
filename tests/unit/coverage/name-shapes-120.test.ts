import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan_coverage_misses } from '../../../src/core/coverage/plan.js';
import { load_plugin_config } from '../../../src/utils/config.js';
import { find_block_lines, find_security_check } from '../../../src/core/security/gate.js';

// inside a literal only a few shapes are names (see literal-structure-120.test.ts); every other shape is a value, as on main
const aws_like = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/'); // built at runtime, never a committed literal
const slash_key = ['kZ3f9Qx2', 'Lm8vN4pRt7Yw+aB1cD5eF6gHi'].join('/');
const withheld: [string, string, string][] = [
  ['aws-style slash secret', `secret_key = "${aws_like}"`, aws_like],
  ['slash secret with plus', `blob = "${slash_key}"`, slash_key],
  ['slash letters only', 'blob = "abcdefgh/ijklmnop/qrstuvwx"', 'abcdefgh/ijklmnop/qrstuvwx'],
  ['infra name', "db = 'payments-db-replica'", 'payments-db-replica'],
  ['broker name', "host = 'kafka-broker-east'", 'kafka-broker-east'],
  ['bucket name', "bucket = 'customer-uploads-archive'", 'customer-uploads-archive'],
  ['rotation name', 'team = "payments-oncall-rotation"', 'payments-oncall-rotation'],
  ['export target', 'export TARGET="payments-db-replica"', 'payments-db-replica'],
  ['ssh target', 'ssh "bastion-eu-west" uptime', 'bastion-eu-west'],
  ['ldap server', 'ldap_server = "directory-primary"', 'directory-primary'],
  ['passphrase', "phrase = 'open sesame please'", 'open sesame please'],
  ['word secret', "pw = 'hunter-two-secret-words'", 'hunter-two-secret-words'],
  ['people list', 'ADMINS = ["alice smith", "bob jones"]', 'alice smith'],
  ['recipients', 'recipients = ["finance-team"]', 'finance-team'],
  ['user and env', 'who = "jsmith/prod"', 'jsmith/prod'],
  ['route-looking secret', `u = "${['a1B2c3D4e5', 'F6g7H8'].join('/')}"`, ['a1B2c3D4e5', 'F6g7H8'].join('/')],
  ['file with key segment', `f = "${['kZ3f9Qx2Lm8vN4pRt7Yw', 'x.json'].join('/')}"`, ['kZ3f9Qx2Lm8vN4pRt7Yw', 'x.json'].join('/')],
  ['flag then argument', 'run("--token abcdef")', '--token abcdef'],
];
const kept: [string, string, string][] = [
  ['flag', '# fall back to npm audit fix --package-lock-only when it fails', '--package-lock-only'],
  ['flag with word', 'run("npm ci --omit=dev")', '--omit=dev'],
  ['command phrase', 'run("npm audit fix --package-lock-only")', 'npm audit fix --package-lock-only'],
  ['fixture file', 'data = load("fixtures/orders_sample.json")', 'orders_sample.json'],
  ['fixture path', 'data = load("fixtures/orders_sample.json")', 'fixtures/orders_sample.json'],
  ['route', 'app.get("/api/orders/list", handler)', '/api/orders/list'],
  ['route params', 'app.get("/api/orders/:id/{kind}", handler)', '/api/orders/:id/{kind}'],
  ['comment event', '// emits user.created once the row is saved', 'user.created'],
];

let repo: string;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'shapes120-'));
  [...withheld, ...kept].forEach(([, line], i) => { mkdirSync(join(repo, 'src'), { recursive: true }); writeFileSync(join(repo, `src/f${i}.py`), `${line}\n`); });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const run = async (facet: string) => {
  const result = await plan_coverage_misses({ repo_root: repo, docs_root: join(repo, '.documentation'), config: await load_plugin_config(repo), gaps: [{ query: 'q', used_doc: null, id: 'q', facets: [escape(facet)] }], today: '2026-11-15' });
  return { facets: result.proposals.flatMap((proposal) => [...proposal.missing_facets, ...(proposal.withheld_facets ? ['[withheld]'] : [])]), text: JSON.stringify(result) };
};

describe('only five shapes are names inside a literal or comment (#120)', () => {
  for (const [name, , value] of withheld) {
    it(`withholds: ${name}`, async () => {
      const { facets, text } = await run(value);
      expect(facets).toEqual(['[withheld]']);
      expect(text).not.toContain(value);
    });
  }
  for (const [name, , value] of kept) {
    it(`keeps the name: ${name}`, async () => {
      expect((await run(value)).facets).toEqual([escape(value)]);
    });
  }
});

describe('a C block opens only where a comment can start (#120)', () => {
  const check = 'if (bcrypt.compareSync(supplied, stored)) {}';
  const cases: [string, string, string][] = [
    ['regex literal in a call', "p.replace(/\\/*$/, '');\n" + check + '\n// done */\n', 'a.js'],
    ['regex literal in a const', 'const re = /\\/*/;\n' + check + '\n// x */\n', 'a.ts'],
    ['php hash comment', "# list /* here\n$ok = password_verify($a, $b);\n// */\n", 'a.php'],
    ['escaped opener', 'x = "\\/*";\n' + check + '\n*/\n', 'a.js'],
  ];
  for (const [name, text, file] of cases) {
    it(`${name} hides nothing`, () => {
      expect(find_block_lines(text, file).size).toBe(0);
    });
  }
  it('a regex check line stays a check', () => {
    expect(find_security_check(check)).toBeDefined();
  });
  it('real blocks still hide prose, also after a statement end', () => {
    expect([...find_block_lines('a();\n/* x\ny\n*/\n', 'a.ts')]).toEqual([1, 2, 3]);
    expect([...find_block_lines('if (a) {} /* x\ny\n*/\n', 'a.ts')]).toEqual([1, 2]);
  });
  // the 200-line cap is gone: the lexer knows where a block really closes, so a long one is prose; one that never closes marks nothing
  it('a long closed block is prose and an unclosed one marks nothing', () => {
    const body = Array.from({ length: 205 }, () => 'prose').join('\n');
    const q3 = '"'.repeat(3);
    expect(find_block_lines(`/*\n${body}\n*/\n`, 'a.ts').size).toBe(207);
    expect(find_block_lines(`${q3}\n${body}\n${q3}\n`, 'a.py').size).toBe(207);
    expect(find_block_lines(`/*\n${body}\n`, 'a.ts').size).toBe(0);
    expect(find_block_lines(`/*\n${body.split('\n').slice(0, 150).join('\n')}\n*/\n`, 'a.ts').size).toBeGreaterThan(100);
  });
});
