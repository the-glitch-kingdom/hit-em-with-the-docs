import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect_surfaces, is_ignored, SURFACE_DETECTORS, type Surface } from '../../../src/core/coverage/surfaces/index.js';

let repo: string;
const w = (p: string, t: string): void => { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), t); };
let all: Surface[];
const names = (kind: string, source_kind?: string): string[] => all.filter((s) => s.kind === kind && (!source_kind || s.source_kind === source_kind)).map((s) => s.name).sort();

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'surfaces-'));
  w('ops/crontab', '# comment\n*/5 * * * * /opt/app/bin/rotate_logs --all\n0 3 * * 1 root /usr/bin/vacuum_db\n');
  w('.github/workflows/nightly.yml', 'name: Nightly\non:\n  schedule:\n    - cron: "0 2 * * *"\njobs:\n  build:\n    runs-on: ubuntu-latest\n  deploy_docs:\n    runs-on: ubuntu-latest\n');
  w('k8s/cleanup.yaml', 'apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: purge-sessions\nspec:\n  schedule: "0 * * * *"\n');
  w('app/celery_conf.py', "beat_schedule = {\n    'refresh-cache': {\n        'task': 'app.tasks.refresh',\n        'schedule': 300,\n    },\n    'send-digest': {\n        'task': 'app.tasks.digest',\n    },\n}\nother = 1\n");
  w('app/sched.py', "scheduler.add_job(sync_users, 'interval', minutes=5, id='user-sync')\nscheduler.add_job(prune_tokens, 'cron', hour=1)\n");
  w('monitoring/rules.yml', 'groups:\n  - name: g\n    rules:\n      - alert: HighErrorRate\n        expr: x > 1\n      - alert: DiskFull\n');
  w('monitoring/grafana/alerts.json', '{"rules":[{"title":"Queue Backlog","condition":"C"}]}');
  w('src/server.ts', "app.get('/users', h);\nrouter.post(`/orders/:id`, h);\n");
  w('app/views.py', "@app.route('/health')\n@router.delete('/items/{id}')\n");
  w('app/cli.py', "parser.add_argument('--dry-run')\nsub.add_parser('migrate')\n@click.option('-v', '--verbose')\n");
  w('src/cli.ts', "program.command('serve <port>').option('-p, --port <n>').option('--no-color')\nyargs.option('retries', { type: 'number' })\n");
  w('.gitlab-ci.yml', 'stages: [a]\nvariables:\n  X: 1\nlint:\n  script:\n    - run\npackage_job:\n  stage: a\n  script:\n    - pack\n');
  w('app/tasks.py', "@shared_task(bind=True)\ndef send_receipt(self):\n    pass\n@app.task\n@retry\ndef resize_image():\n    pass\n");
  w('src/queues.ts', "const q = new Queue('email-out');\nnew Worker(\"thumbs\", fn);\n");
  w('app/workers/hard.rb', 'class HardWorker\n  include Sidekiq::Worker\nend\nclass Plain\nend\n');
  w('src/limits.ts', "export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;\nconst CACHE_TTL = 3600;\nconst DB_PORT = 5432;\nconst API_TOKEN_TTL = 30;\nconst GREETING = 'hi';\n  const INDENTED_LIMIT = 4;\n");
  w('app/settings.py', "RETRY_LIMIT = 5\nPASSWORD_HASH = 'abcdef'\nSECRET_TTL = 60\n");
  w('src/env.ts', "const a = process.env.DATABASE_URL;\nconst b = process.env['REDIS_HOST'];\n");
  w('app/env.py', "x = os.environ['SMTP_USER']\ny = os.getenv('FEATURE_FLAG', 'secretdefault')\nz = os.environ.get('API_BASE')\n");
  w('.env.example', 'DATABASE_URL=postgres://user:hunter2@host/db\n# comment\nWORKER_COUNT=4\n');
  w('gen/api.ts', '// @generated\nexport const GENERATED_LIMIT = 9;\n');
  w('tests/limits.test.ts', 'const TEST_ONLY_LIMIT = 3;\napp.get("/only-in-tests", h);\n');
  w('vendor/lib.ts', 'const VENDORED_LIMIT = 7;\n');
  w('.documentation/ops/x.md', 'RETRY_LIMIT mentioned\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
  all = await detect_surfaces({ repo_root: repo, docs_root: join(repo, '.documentation'), ignore: ['vendor/'] });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('surface detectors (#117)', () => {
  it('every surface has kind, name, file, line and source_kind; the registry is pluggable', () => {
    expect(SURFACE_DETECTORS.length).toBeGreaterThan(10);
    for (const s of all) { expect(s.kind && s.name && s.file && s.line > 0 && s.source_kind).toBeTruthy(); }
  });
  it('scheduled jobs: crontab, CI schedule, Kubernetes CronJob, celery beat, APScheduler', () => {
    expect(names('scheduled-job', 'crontab')).toEqual(['rotate_logs', 'vacuum_db']);
    expect(names('scheduled-job', 'github-schedule')).toEqual(['nightly']);
    expect(names('scheduled-job', 'k8s-cronjob')).toEqual(['purge-sessions']);
    expect(names('scheduled-job', 'celery-beat')).toEqual(['refresh-cache', 'send-digest']);
    expect(names('scheduled-job', 'apscheduler')).toEqual(['prune_tokens', 'user-sync']);
  });
  it('alert rules: Prometheus and Grafana', () => {
    expect(names('alert-rule')).toEqual(['DiskFull', 'HighErrorRate', 'Queue Backlog']);
  });
  it('HTTP routes, with the path as the name', () => {
    expect(names('http-route')).toEqual(['/health', '/items/{id}', '/orders/:id', '/users']);
  });
  it('CLI commands and flags: argparse, click, commander, yargs', () => {
    expect(names('cli-flag')).toEqual(['--dry-run', '--no-color', '--port', '--retries', '--verbose']);
    expect(names('cli-command')).toEqual(['migrate', 'serve']);
  });
  it('CI workflows and jobs: GitHub and GitLab', () => {
    expect(names('ci-workflow')).toEqual(['nightly']);
    expect(names('ci-job', 'github-job')).toEqual(['build', 'deploy_docs']);
    expect(names('ci-job', 'gitlab-job')).toEqual(['lint', 'package_job']);
  });
  it('background tasks and queues: celery, bull, sidekiq', () => {
    expect(names('background-task', 'celery-task')).toEqual(['resize_image', 'send_receipt']);
    expect(names('background-task', 'bull-queue')).toEqual(['email-out', 'thumbs']);
    expect(names('background-task', 'sidekiq')).toEqual(['HardWorker']);
  });
  it('constants: module-level numeric limits only; the literal rides only when stateable, never for a value-named one', () => {
    const constants = all.filter((s) => s.kind === 'constant');
    expect(constants.map((s) => s.name).sort()).toEqual(['API_TOKEN_TTL', 'CACHE_TTL', 'DB_PORT', 'MAX_UPLOAD_BYTES', 'RETRY_LIMIT', 'SECRET_TTL']);
    const value = (name: string): string | undefined => constants.find((s) => s.name === name)?.value;
    expect(value('MAX_UPLOAD_BYTES')).toBe('10 * 1024 * 1024');
    expect(value('CACHE_TTL')).toBe('3600');
    expect(value('RETRY_LIMIT')).toBe('5');
    expect(value('DB_PORT')).toBeUndefined();
    expect(value('API_TOKEN_TTL')).toBeUndefined();
    expect(value('SECRET_TTL')).toBeUndefined();
  });
  it('config and env keys: names only, never a value or default', () => {
    expect(names('config-key')).toEqual(['API_BASE', 'DATABASE_URL', 'DATABASE_URL', 'FEATURE_FLAG', 'REDIS_HOST', 'SMTP_USER', 'WORKER_COUNT']);
    expect(JSON.stringify(all)).not.toMatch(/hunter2|secretdefault|postgres:\/\//);
  });
  it('skips generated files, tests, docs and the ignore list; deduplicates; is deterministic', async () => {
    const text = JSON.stringify(all);
    for (const skipped of ['GENERATED_LIMIT', 'TEST_ONLY_LIMIT', '/only-in-tests', 'VENDORED_LIMIT']) expect(text).not.toContain(skipped);
    expect(all.filter((s) => s.name === 'DATABASE_URL')).toHaveLength(2); // two files, two surfaces
    const again = await detect_surfaces({ repo_root: repo, docs_root: join(repo, '.documentation'), ignore: ['vendor/'] });
    expect(again).toEqual(all);
    const with_vendor = await detect_surfaces({ repo_root: repo, docs_root: join(repo, '.documentation') });
    expect(JSON.stringify(with_vendor)).toContain('VENDORED_LIMIT');
  });
  it('ignore entries are prefixes or globs', () => {
    expect(is_ignored('vendor/a/b.ts', ['vendor'])).toBe(true);
    expect(is_ignored('vendors/a.ts', ['vendor'])).toBe(false);
    expect(is_ignored('src/gen/x.ts', ['**/gen/*.ts'])).toBe(true);
    expect(is_ignored('src/gen/deep/x.ts', ['src/gen/*.ts'])).toBe(false);
  });
});
