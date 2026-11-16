import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan_coverage_misses } from '../../../src/core/coverage/plan.js';
import { load_plugin_config } from '../../../src/utils/config.js';
import { find_block_lines, find_security_check } from '../../../src/core/security/gate.js';
import { find_check_line } from '../../../src/core/coverage/draft.js';

// a literal or comment holds a NAME only when it is clearly name-shaped; everything else is a value (#120 review round)
const leaks: [string, string, string][] = [
  ['dsn pair in a call', 'psycopg2.connect("dbname=app user=svc password=pgsecret99")', 'pgsecret99'],
  ['bearer key', 'headers = {"bearer": "tok_9f8e7d6c5b4a"}', 'tok_9f8e7d6c5b4a'],
  ['vault write', 'vault.write("secret/app", value="s3cr3t-val")', 's3cr3t-val'],
  ['basic auth header', 'headers = {"Authorization": "Basic dXNlcjpwYXNz"}', 'dXNlcjpwYXNz'],
  ['smtp login', 'smtp.login("noreply", "mailpass2024x")', 'mailpass2024x'],
  ['client name with digit', 'client = Client("orders-internal-9")', 'orders-internal-9'],
  ['login pair, password', 'login("admin", "swordfish")', 'swordfish'],
  ['login pair, user', 'login("admin", "swordfish")', 'admin'],
  ['ruby smtp', 'Net::SMTP.start("mail.local", 25, "box", "mailuser", "mailpw")', 'mailpw'],
  ['cookie set', 'session.cookies.set("sid", "abcd1234wxyz")', 'abcd1234wxyz'],
  ['auth tuple', 'auth = ("svc_user", "Tr0ub4dor")', 'Tr0ub4dor'],
  ['password list', 'PASSWORDS = ["alpha", "bravo"]', 'bravo'],
  ['comment, password pair', '// connect with password = "correcthorse7"', 'correcthorse7'],
  ['comment, pwd', '# example: host="db1.corp.internal", user="svcacct", pwd="Qx9zLm2"', 'Qx9zLm2'],
  ['comment, user', '# example: host="db1.corp.internal", user="svcacct", pwd="Qx9zLm2"', 'svcacct'],
  ['comment, bearer', '# curl -H "Authorization: Bearer abc123def" https://x', 'abc123def'],
  ['comment, unquoted pair', '# connect with password=correcthorse7 for now', 'correcthorse7'],
];
// two letter-words ('sample_workspace') are no longer a name shape: main withheld them, so they stay withheld (#120 round 3)
const names: [string, string, string][] = [
  ['flag', '# fall back to npm audit fix --package-lock-only when it fails', '--package-lock-only'],
  ['flag with word', 'run("npm ci --omit=dev")', '--omit=dev'],
  ['fixture file', 'data = load("fixtures/orders_sample.json")', 'orders_sample.json'],
  ['fixture path', 'data = load("fixtures/orders_sample.json")', 'fixtures/orders_sample.json'],
  ['route', 'app.get("/api/orders/list", handler)', '/api/orders/list'],
  ['comment event', '// emits user.created once the row is saved', 'user.created'],
];

let repo: string;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'lit120-'));
  [...leaks, ...names].forEach(([, line], i) => { mkdirSync(join(repo, 'src'), { recursive: true }); writeFileSync(join(repo, `src/f${i}.py`), `${line}\n`); });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const run = async (facet: string) => {
  const result = await plan_coverage_misses({ repo_root: repo, docs_root: join(repo, '.documentation'), config: await load_plugin_config(repo), gaps: [{ query: 'q', used_doc: null, id: 'q', facets: [facet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')] }], today: '2026-11-15' });
  return { facets: result.proposals.flatMap((proposal) => [...proposal.missing_facets, ...(proposal.withheld_facets ? ['[withheld]'] : [])]), text: JSON.stringify(result) };
};

describe('a literal value never reaches the output (#120 review)', () => {
  for (const [name, , value] of leaks) {
    it(`withholds: ${name}`, async () => {
      const { facets, text } = await run(value);
      expect(facets).toEqual(['[withheld]']);
      expect(text).not.toContain(value);
    });
  }
  for (const [name, , value] of names) {
    it(`keeps the name: ${name}`, async () => {
      expect((await run(value)).facets).toEqual([value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')]);
    });
  }
});

describe('block syntax belongs to the languages that have it (#120 review)', () => {
  it('a shell glob opens no C block', () => {
    const text = 'rm -rf build/*\ncp build/* out/\nfor d in */; do\n  if [ "$token" == "$expected" ]; then x; fi\ndone\n';
    expect(find_block_lines(text, 'ci/clean.sh').size).toBe(0);
  });
  it('a triple quote inside a # comment opens no Python block', () => {
    const text = '# the docstring starts with """ here\nif token == expected:\n    pass\n# and """ closes\n';
    expect(find_block_lines(text, 'a.py').size).toBe(0);
  });
  it('a check on the line that closes a block is still checked', () => {
    const c = '/*\nprose\n*/ if (token === expected) {}\n';
    expect([...find_block_lines(c, 'a.ts')]).toEqual([0, 1]);
    const py = '"""\nprose\n""" ; ok = token == expected\n';
    // a string with code after its closing quotes is data, not a docstring: nothing is skipped
    expect([...find_block_lines(py, 'a.py')]).toEqual([]);
  });
  it('a check on the line that opens a block is still checked', () => {
    const c = 'if (token === expected) {} /* start\nprose\n*/\n';
    expect([...find_block_lines(c, 'a.js')]).toEqual([1, 2]);
  });
  it('real blocks still hide prose, by language', () => {
    expect([...find_block_lines('/*\nx\n*/\n', 'a.go')]).toEqual([0, 1, 2]);
    expect([...find_block_lines('"""\nx\n"""\n', 'a.py')]).toEqual([0, 1, 2]);
    expect([...find_block_lines('=begin\nx\n=end\n', 'a.rb')]).toEqual([]); // Ruby is not parser-checked: every line is held
    expect(find_block_lines('=begin\nx\n=end\n', 'a.py').size).toBe(0);
    expect(find_block_lines('"""\nx\n"""\n', 'a.ts').size).toBe(0);
    expect(find_block_lines('/*\nx\n*/\n', 'a.py').size).toBe(0);
  });
  it('find_check_line reads the file extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blk120b-'));
    try {
      writeFileSync(join(dir, 'clean.sh'), 'rm -rf build/*\nif [ "$token" == "$expected" ]; then x; fi\ncp a b\nrm -rf out/*\n');
      expect(find_security_check('if [ "$token" == "$expected" ]; then x; fi')).toBeDefined();
      expect(await find_check_line(dir, [{ file: 'clean.sh', line: 2 }])).toMatchObject({ line: 2 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
