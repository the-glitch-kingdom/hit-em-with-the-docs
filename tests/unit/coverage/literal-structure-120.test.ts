import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan_coverage_misses } from '../../../src/core/coverage/plan.js';
import { load_plugin_config } from '../../../src/utils/config.js';

// main's literal rule is the base: a matched facet inside a literal is a value unless it starts with `--` (a long flag) or `/` (a route or path);
// the only additions are a one-letter flag, a file name, a command phrase and a name a surface detector found on the same line (#120)
const withheld: [string, string, string][] = [
  ['short flag with password', 'run("mysql", "-ptopsecret")', '-ptopsecret'],
  ['short flag with user', 'run("mysql", "-uroot")', '-uroot'],
  ['short flag with host', 'run("mysql", "-hprod-db-1")', '-hprod-db-1'],
  ['short flag with value', 'run("mysql", "-psecret")', '-psecret'],
  ['person name', 'owner = "john.smith"', 'john.smith'],
  ['cache host', 'cache = "redis.cache"', 'redis.cache'],
  ['db name', 'db = "db.primary"', 'db.primary'],
  ['db file-like name', 'db = "payments.db"', 'payments.db'],
  ['passphrase', 'phrase = "correct.horse"', 'correct.horse'],
  ['event name no detector', 'bus.emit("user.created", payload)', 'user.created'],
  ['hyphenated word', 'queue_name = "payments-retry-batch"', 'payments-retry-batch'],
  ['command phrase with short flag value', 'run("mysql --host x -psecret")', 'mysql --host x -psecret'],
  ['command phrase with option argument', 'run("tool --user alice")', 'tool --user alice'],
];
const kept: [string, string, string][] = [
  ['versioned route', 'app.get("/api/v2/orders/list", handler)', '/api/v2/orders/list'],
  ['camelCase route', 'app.get("/api/getUserById", handler)', '/api/getUserById'],
  ['wildcard route', 'app.get("/files/*", handler)', '/files/*'],
  ['param route', 'app.get("/api/Orders/:orderId", handler)', '/api/Orders/:orderId'],
  ['one-letter flag', 'run("tool", "-v")', '-v'],
  ['long flag', 'run("npm ci --omit=dev")', '--omit=dev'],
  ['person in a file name is shown (file names are not a value class)', 'f = "ann.lee.json"', 'ann.lee.json'],
  ['file name', 'data = load("fixtures/orders_sample.json")', 'orders_sample.json'],
  ['command phrase', 'run("npm audit fix --package-lock-only")', 'npm audit fix --package-lock-only'],
  ['scheduled job key', "beat_schedule = {'nightly-report': {'task': 't', 'schedule': 60}}", 'nightly-report'],
  ['queue name', "const q = new Queue('email-sender-jobs');", 'email-sender-jobs'],
];

let repo: string;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'struct120-'));
  [...withheld, ...kept].forEach(([, line], i) => {
    mkdirSync(join(repo, 'src'), { recursive: true });
    const extension = line.includes('Queue(') ? 'ts' : 'py';
    writeFileSync(join(repo, `src/f${i}.${extension}`), `${line}\n`);
  });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const run = async (facet: string) => {
  const result = await plan_coverage_misses({ repo_root: repo, docs_root: join(repo, '.documentation'), config: await load_plugin_config(repo), gaps: [{ query: 'q', used_doc: null, id: 'q', facets: [escape(facet)] }], today: '2026-11-15' });
  return { facets: result.proposals.flatMap((proposal) => proposal.missing_facets), text: JSON.stringify(result) };
};

describe('a literal is a value unless it is clearly a name (#120 structural)', () => {
  for (const [name, , value] of withheld) {
    it(`withholds: ${name}`, async () => {
      const { facets, text } = await run(value);
      expect(facets).toEqual(['[redacted facet]']);
      expect(text).not.toContain(value);
    });
  }
  for (const [name, , value] of kept) {
    it(`keeps the name: ${name}`, async () => {
      expect((await run(value)).facets).toEqual([escape(value)]);
    });
  }
});
