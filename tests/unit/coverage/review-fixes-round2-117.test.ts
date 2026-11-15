// Regression tests for the second #117/#118 re-review (3.7.0): names joined to values, bare-value facets, ports, route keys.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect_surfaces, type Surface } from '../../../src/core/coverage/surfaces/index.js';
import { find_value_in_name, is_stateable_constant } from '../../../src/core/security/gate.js';
import { name_new_doc } from '../../../src/core/coverage/naming.js';
import { plan_coverage_misses } from '../../../src/core/coverage/plan.js';
import { render_gaps_report } from '../../../src/core/reconcile/gaps-report.js';
import { plugin_config_schema } from '../../../src/utils/config.js';

const config = { allow: [], disabled_rules: [] };
// fakes are built at run time so no real-shape secret literal sits in the repo
const ip = [10, 0, 0, 5].join('.');
const host = ['db', 'example', 'com'].join('.');
const akia = ['AK', 'IA', 'IOSFODNN7', 'EXAMPLE'].join('');
const ghp = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
const anthropic = ['sk', '-ant-', 'api03-', 'Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2'].join('');
const live = ['sk', '_live_', 'abcdefghijklmnopqrstuv'].join('');
const pass = ['S3cr', '3tPass'].join('');
const pass2 = ['hunter2', 'hunter2'].join('');

describe('finding 1: a name is screened as written and as read', () => {
  const bad = [
    `sync_to_${ip}`, `redis_${ip}_6379`, `ping_${host}_now`, `High5xxOn${ip}`, `deploy-to-${ip.replace(/\./g, '-')}`,
    `backup_s3_${akia}`, ghp, `token_${ghp}`, `token_${anthropic}`, `rotate_${live}`, `fetch_${['AI', 'zaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'].join('')}`,
    `job_${['npm', '_', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('')}`, `upload_${'a1b2c3d4e5f60718'}`,
  ];
  it('values joined by underscores, dashes or letters are found', () => {
    for (const name of bad) expect(find_value_in_name(name, config), name).toBeDefined();
  });
  it('plain identifiers are kept', () => {
    for (const name of ['sync_to_warehouse', 'High5xxRate', 'getOauth2ClientRegistrationHandler', 'rotate-logs', 'nightly_rebuild', 'Queue Backlog', 'task-queue-sizing', 'MAX_RETRIES', 'build_task_list', 'asset-pipeline-v2']) expect(find_value_in_name(name, config), name).toBeUndefined();
  });
  let repo: string;
  let all: Surface[];
  const w = (p: string, t: string): void => { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), t); };
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'review2-'));
    w('deploy/crontab', [`/opt/app/sync_to_${ip}.sh`, `/opt/app/redis_${ip}_6379.sh`, `/opt/app/ping_${host}_now.sh`, '/opt/app/rebuild_index'].map((c) => `0 3 * * * ${c}\n`).join(''));
    w('app/beat.py', `CELERY_BEAT_SCHEDULE = {\n    'sync_to_${ip}': {'task': 'a.b'},\n    'backup_s3_${akia}': {'task': 'a.c'},\n    '${ghp}': {'task': 'a.d'},\n    'token_${anthropic}': {'task': 'a.e'},\n    'fine-job': {'task': 'a.f'},\n}\n`);
    w('monitoring/grafana-alerts.json', `{"rules":[{"title":"High5xxOn${ip}","condition":"C"},{"title":"Queue Backlog","condition":"C"}]}`);
    w('deploy/cron.yaml', `${'# c\n'.repeat(8)}apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: deploy-to-${ip.replace(/\./g, '-')}\nspec:\n  schedule: "0 * * * *"\n`);
    w('src/server.ts', `app.get('/v1/tokens/${live}', h);\napp.get('/v1/keys/${ghp}/x', h);\napp.get('/v1/orders', h);\n`);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
    all = await detect_surfaces({ repo_root: repo, docs_root: join(repo, '.documentation') });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  it('no surface name, and nothing built from one, holds a value', () => {
    const json = JSON.stringify(all);
    for (const value of [ip, ip.replace(/\./g, '-'), host, akia, ghp, anthropic, live, '10_0_0_5']) expect(json, value).not.toContain(value);
    expect(all.map((s) => s.name)).toEqual(expect.arrayContaining(['fine-job', 'Queue Backlog', 'rebuild_index', '/v1/orders']));
  });
  it('a key-shaped route segment is a parameter', () => {
    expect(all.filter((s) => s.kind === 'http-route').map((s) => s.name).sort()).toEqual(['/v1/keys/:param/x', '/v1/orders', '/v1/tokens/:param']);
  });
  it('a doc name is never made from a value', () => {
    expect(name_new_doc({ queries: ['q'], facets: [`sync_to_${ip}`, `token_${ghp}`], source_files: ['src/jobs/sync_runner.ts'] })).toBe('sync-runner');
  });
});

describe('finding 3: ports are stated only under a measuring name', () => {
  it('collector, exporter and similar names stay with the judge; measuring names state', () => {
    for (const [name, value] of [['OTLP_COLLECTOR', '4317'], ['METRICS_EXPORTER', '9100'], ['STATSD', '8125'], ['SYSLOG_SINK', '5140'], ['AGENT_LISTENER', '7946'], ['RELAY', '2525'], ['QUEUE_SLOT', '31337']] as const) expect(is_stateable_constant(name, value), name).toBe(false);
    for (const [name, value] of [['MAX_BATCH_SIZE', '4096'], ['POLL_INTERVAL_MS', '4000'], ['RETRY_LIMIT', '5'], ['CHUNK_BYTES', '8192'], ['IDLE_TIMEOUT', '30'], ['SMALL_COUNT', '12']] as const) expect(is_stateable_constant(name, value), name).toBe(true);
  });
});

describe('finding 2: a facet that is only a value is withheld everywhere', () => {
  let repo: string;
  const w = (p: string, t: string): void => { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), t); };
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'review2f-'));
    mkdirSync(join(repo, '.documentation/ops'), { recursive: true });
    writeFileSync(join(repo, '.documentation/ops/a.md'), '# a\n');
    w('src/boot.ts', `const DEFAULT_PASS = '${pass}';\nconst fallback = process.env.APP_SECRET_TWO ?? '${pass2}';\nexport function start_worker() { return 1; }\n`);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  it('the report, json, review entries and doc name carry [redacted facet], and the miss is still classified', async () => {
    const gaps = [{ id: 'v1', query: 'how does the worker start', facets: [pass, pass2, 'start_worker'] }];
    const plan = await plan_coverage_misses({ repo_root: repo, docs_root: join(repo, '.documentation'), config: plugin_config_schema.parse({}), gaps, today: '2026-11-15' });
    const text = JSON.stringify(plan) + render_gaps_report({ proposals: [], candidates: [], questions: [], dropped: [], facet_gaps: [], warnings: [] } as never, config, '2026-11-15', plan);
    expect(text).not.toContain(pass);
    expect(text).not.toContain(pass2);
    expect(text).not.toContain('s3cr3t');
    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]!.missing_facets).toEqual(expect.arrayContaining(['[redacted facet]', 'start_worker']));
    expect(plan.drafts.entries.every((entry) => !entry.path.includes('s3cr3t') && !entry.path.includes('hunter'))).toBe(true);
  });
});
