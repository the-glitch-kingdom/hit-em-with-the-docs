// Regression tests for the fourth #117/#118 re-review (3.7.0): values by context, hex constants, normalized IPs, env names with underscores, file paths, port arithmetic.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect_surfaces } from '../../../src/core/coverage/surfaces/index.js';
import { name_cron_command } from '../../../src/core/coverage/surfaces/detectors.js';
import { list_graded_surfaces } from '../../../src/core/coverage/coverage.js';
import { find_value_in_name, is_constant_value, is_stateable_constant } from '../../../src/core/security/gate.js';
import { name_new_doc } from '../../../src/core/coverage/naming.js';
import { plan_coverage_misses } from '../../../src/core/coverage/plan.js';
import { plugin_config_schema } from '../../../src/utils/config.js';

// fakes are built at run time so no real-shape secret literal sits in the repo
const pw = (n: number): string => ['Zq', `${n}x`, 'Vw', 'Lm7', 'pR'].join('');
const hex = ['a1b2c3d4', 'e5f60718', 'a1b2c3d4'].join('');
const make_repo = (files: Record<string, string>): string => {
  const repo = mkdtempSync(join(tmpdir(), 'round4-'));
  mkdirSync(join(repo, '.documentation/ops'), { recursive: true });
  writeFileSync(join(repo, '.documentation/ops/a.md'), '# a\n');
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), text); }
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
  return repo;
};

describe('finding 1: a facet inside a literal, an option argument or userinfo is a value', () => {
  let repo: string;
  beforeAll(() => {
    repo = make_repo({
      'src/Cfg.java': `class Cfg {\n  String secretPhrase = "${pw(1)}";\n  void use_phrase() { }\n}\n`,
      'scripts/backup.sh': `#!/bin/sh\nmysql -uroot -p${pw(2)} appdb < dump.sql\n`,
      'scripts/call.sh': `curl -H "X-Api-Key: ${hex}" https://x.invalid/v1\n`,
      'src/dsn.go': `package main\nfunc dial() { dsn := "svc:${pw(4)}@tcp(db:3306)/app"; _ = dsn }\n`,
      'src/db.ts': `export function open_pool() { return connect('h', 5432, 'svcuser', '${pw(5)}'); }\n`,
      'scripts/heredoc.sh': `cat <<EOF\nlogin ${pw(6)}\nEOF\nrun_report\n`,
      'scripts/flag.sh': `deploy --token ${pw(7)} --force\n`,
    });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  it('every shape is [redacted facet] in the plan and never names a doc', async () => {
    const secrets = [pw(1), pw(2), hex, pw(4), pw(5), pw(6), pw(7)];
    const gaps = secrets.map((secret, i) => ({ id: `g${i}`, query: 'how does the service connect', facets: [secret, 'open_pool'] }));
    const plan = await plan_coverage_misses({ repo_root: repo, docs_root: join(repo, '.documentation'), config: plugin_config_schema.parse({}), gaps, today: '2026-11-15' });
    const text = JSON.stringify(plan);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(plan.proposals.flatMap((proposal) => proposal.missing_facets)).toContain('[redacted facet]');
    expect(plan.proposals.flatMap((proposal) => proposal.missing_facets)).toContain('open_pool');
  });
  it('identifier facets outside literals stay', async () => {
    const gaps = [{ id: 'n1', query: 'what is secretPhrase', facets: ['secretPhrase'] }, { id: 'n2', query: 'run it', facets: ['run_report', 'use_phrase'] }];
    const plan = await plan_coverage_misses({ repo_root: repo, docs_root: join(repo, '.documentation'), config: plugin_config_schema.parse({}), gaps, today: '2026-11-15' });
    const facets = plan.proposals.flatMap((proposal) => proposal.missing_facets);
    expect(facets).toEqual(expect.arrayContaining(['secretPhrase', 'run_report', 'use_phrase']));
    expect(facets).not.toContain('[redacted facet]');
  });
  it('a key-shaped facet is redacted even when nothing locates it', async () => {
    const plan = await plan_coverage_misses({ repo_root: repo, docs_root: join(repo, '.documentation'), config: plugin_config_schema.parse({}), gaps: [{ id: 'k', query: 'how', facets: [hex, 'open_pool'] }], today: '2026-11-15' });
    expect(JSON.stringify(plan)).not.toContain(hex);
  });
});

describe('finding 2: a long hex literal is never a constant', () => {
  it('signing keys, hashes and hex IPs are not stated; short masks are', () => {
    for (const value of [`0x${hex}`, '0xDEADBEEFCAFEBABE', '0xC0A80164', '0x8f14e45']) {
      expect(is_constant_value(value)).toBe(false);
      expect(is_stateable_constant('WEBHOOK_SIGNING', value)).toBe(false);
    }
    expect(is_stateable_constant('FLAG_MASK', '0xFF')).toBe(true);
    expect(is_stateable_constant('RETRY_CAP', '0x10')).toBe(true);
  });
});

describe('finding 3: IPs and ids hidden in names', () => {
  const bad = ['sync_010_000_000_005', '192_168_001_001', '10__0__0__5', 'sync_10.0.0.5', 'fe80::1', '2001:db8::1', 'ping_[::1]', 'host_167772165', 'host_0a000005', 'to_10-0-0-5', 'what is RETRY_CAP on 10-0-0-5'];
  it.each(bad)('%s holds a value', (name) => { expect(find_value_in_name(name)).toBeDefined(); });
  it.each(['sync_users', 'std::vector', 'Foo::bar', 'retry_cap_30', 'build_2024', 'http2_client', 'ed25519_sign'])('%s is a name', (name) => { expect(find_value_in_name(name)).toBeUndefined(); });
  it('a cron script keeps its name when the stem holds an IP, and only script extensions are stripped', () => {
    expect(name_cron_command('/opt/bin/backup_to_10.0.0.5')).toBe('backup_to_10.0.0.5');
    expect(name_cron_command('/opt/bin/rotate.sh')).toBe('rotate');
    expect(name_cron_command('python3 /opt/job.py')).toBe('job');
  });
  it('a surface with such a name is withheld', async () => {
    const repo = make_repo({ 'deploy/crontab': '0 1 * * * /opt/bin/backup_to_10.0.0.5\n' });
    try {
      const names = (await detect_surfaces({ repo_root: repo, docs_root: join(repo, '.documentation') })).map((surface) => surface.name);
      expect(names.join()).not.toContain('10.0.0');
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
  it('a gaps query that holds a value is not echoed', async () => {
    const repo = make_repo({ 'src/a.ts': 'export const RETRY_CAP = 3;\n' });
    try {
      const plan = await plan_coverage_misses({ repo_root: repo, docs_root: join(repo, '.documentation'), config: plugin_config_schema.parse({}), gaps: [{ id: 'q', query: 'what is RETRY_CAP on 10-0-0-5', facets: ['RETRY_CAP'] }], today: '2026-11-15' });
      expect(JSON.stringify(plan)).not.toMatch(/10-0-0-5/);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe('finding 4: environment resource names with underscores', () => {
  it.each(['notify_db_prod_01', 'sync_prod_db_01', 'cp_stg_bucket_acme', 'prod_db', 'orders_staging_queue'])('%s holds an environment resource', (name) => { expect(find_value_in_name(name)).toBeDefined(); });
  it.each(['product_list', 'stage_two', 'produce_report'])('%s is a name', (name) => { expect(find_value_in_name(name)).toBeUndefined(); });
});

describe('finding 5: file paths are screened', () => {
  let repo: string;
  beforeAll(() => {
    repo = make_repo({
      'jobs/10-0-0-5-svc.ts': "new Queue('send_mail');\n",
      '.github/workflows/deploy-prod-123456789012.yml': 'on:\n  schedule:\n    - cron: "0 1 * * *"\njobs:\n  build:\n    steps: []\n',
      'deploy/10.0.0.5/crontab': '0 1 * * * /opt/bin/rotate\n',
      'src/ok/jobs.ts': "new Queue('send_sms');\n",
      'config.local.ts': 'export const MAX_ROWS = 50;\n',
    });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  it('a surface whose path holds a value is held for a human with a placeholder path, never graded or named', async () => {
    const config = plugin_config_schema.parse({});
    const { graded, held } = await list_graded_surfaces({ repo_root: repo, docs_root: join(repo, '.documentation'), config });
    const text = JSON.stringify({ graded, held });
    expect(text).not.toMatch(/10[.-]0[.-]0[.-]5|123456789012/);
    expect(held.filter((entry) => entry.reason === 'value in file path').length).toBeGreaterThanOrEqual(4);
    expect(held.every((entry) => entry.file === '[withheld path]' || entry.reason !== 'value in file path')).toBe(true);
    expect(graded.map((surface) => surface.name)).toEqual(expect.arrayContaining(['send_sms', 'MAX_ROWS']));
  });
  it('a module stem that holds a value never names a doc', () => {
    expect(name_new_doc({ queries: ['how'], facets: [], source_files: ['jobs/10-0-0-5-svc.ts'] })).not.toMatch(/10/);
  });
});

describe('finding 6: ports and arithmetic', () => {
  it.each([['LDAP_LIMIT', '389'], ['X_LIMIT', '636'], ['X_LIMIT', '445'], ['X_LIMIT', '514'], ['X_LIMIT', '123'], ['WINDOW', '8000 + 80'], ['LIMIT', '5_432'], ['LIMIT', '(80 * 100) + 43'], ['LEVEL', '3'], ['SLOT', '200']])('%s = %s is not stated', (name, value) => {
    expect(is_stateable_constant(name, value)).toBe(false);
  });
  it.each([['RETRY_LIMIT', '3'], ['TIMEOUT_MS', '30 * 1000'], ['CACHE_SIZE', '1_024 * 64'], ['MAX_ROWS', '7_500'], ['TTL', '60 * 60']])('%s = %s is stated', (name, value) => {
    expect(is_stateable_constant(name, value)).toBe(true);
  });
});
