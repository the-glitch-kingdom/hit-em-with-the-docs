// Regression tests for the #117 adversarial review findings (3.7.0).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect_surfaces, type Surface } from '../../../src/core/coverage/surfaces/index.js';
import { run_coverage } from '../../../src/core/coverage/coverage.js';
import { plugin_config_schema } from '../../../src/utils/config.js';

let repo: string;
const w = (p: string, t: string): void => { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), t); };
let all: Surface[];
const by = (source_kind: string, file?: string): Surface[] => all.filter((s) => s.source_kind === source_kind && (!file || s.file === file));
const names = (source_kind: string, file?: string): string[] => by(source_kind, file).map((s) => s.name).sort();
// fakes are built at run time so no real-shape secret literal sits in the repo
const pass = ['hun', 'ter', 'two', 'x9'].join('');
const token = ['ab', 'cd', '1234', 'efgh'].join('');
const akia = ['AK', 'IA', 'IOSFODNN7', 'EXAMPLE'].join('');
const account = '1234'.repeat(3);
const host = ['backup', 'example', 'com'].join('.');
const ip = [10, 2, 3, 4].join('.');
const cron = (command: string, spec = '0 3 * * *'): string => `${spec} ${command}\n`;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'review-117-'));
  w('deploy/crontab', [
    cron(`curl -fsS https://deploy:${pass}@${host}/run`),
    cron(`wget -q "https://${host}/ping?token=${token}"`),
    cron('flock -n /var/lock/a.lock /opt/app/bin/rebuild_index --all'),
    cron('cd /srv/app && python3 jobs/compact.py --fast'),
    cron('nice -n 10 timeout 300 /opt/app/bin/vacuum'),
    cron('sh -c "/opt/app/bin/rotate_logs --all"'),
    cron('FOO=1 BAR=2 node scripts/report.js'),
    cron('python -m app.tasks.cleanup'),
    cron('root /usr/bin/user_col_job'),
    '@daily /opt/app/bin/daily_job\n@reboot /opt/app/bin/boot_job\n@hourly flock -n /tmp/l /opt/app/bin/hourly_job\n',
  ].join(''));
  w('deploy/cron.yaml', `${'# c\n'.repeat(8)}apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: sync-prod-${ip.replace(/\./g, '-')}\nspec:\n  schedule: "0 * * * *"\n`);
  w('.gitlab-ci.yml', 'build-prod-eu-west-1:\n  script:\n    - make\nlint:\n  script:\n    - make lint\n');
  w('monitoring/grafana-alerts.json', `{"rules":[{"title":"Disk full on ${ip}:9100","condition":"C"},{"title":"Queue Backlog","condition":"C"}]}`);
  w('src/server.ts', `app.post('/hook/${akia}', h);\napp.get('/tenant/${account}/x', h);\napp.get('/users/:id', h);\napp.get('/orders', h);\n`);
  w('app/beat.py', "CELERY_BEAT_SCHEDULE = {\n    'rotate-logs': {'task': 'a.b', 'schedule': 60},\n    'nightly-rebuild': {\n        'task': 'a.c',\n    },\n}\n");
  w('app/beat2.py', "app.conf.Beat_Schedule = {'one-liner': {'task': 'a.d'}, 'two-liner': {'task': 'a.e'}}\n");
  w('app/cli.py', [
    '@click.option(\n    "--dry-run",\n    is_flag=True,\n)',
    '@click.option("-v", "--verbose")',
    '@cli.command()',
    'def sync_all():\n    pass',
    '@cli.command("export")',
    'def x():\n    pass',
    '@click.command',
    'def solo():\n    pass',
    '@db.command(name="migrate")',
    'def y():\n    pass',
    '',
  ].join('\n'));
  w('vendor/lib.ts', 'const VENDORED_LIMIT = 7;\n');
  w('third_party/lib.ts', 'const THIRD_LIMIT = 7;\n');
  w('archive/old.ts', 'const ARCHIVED_LIMIT = 7;\n');
  w('src/live.ts', 'const LIVE_LIMIT = 7;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
  all = await detect_surfaces({ repo_root: repo, docs_root: join(repo, '.documentation') });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('finding 1: a URL command never names a job', () => {
  it('curl and wget lines get the position placeholder, and no secret is in any surface', () => {
    const json = JSON.stringify(all);
    for (const value of [pass, token, host, 'https://']) expect(json).not.toContain(value);
    expect(names('crontab', 'deploy/crontab')).toContain('scheduled job at deploy/crontab:1');
    expect(names('crontab', 'deploy/crontab')).toContain('scheduled job at deploy/crontab:2');
  });
  it('the report, facets and queries never hold the value', async () => {
    const report = await run_coverage({ repo_root: repo, docs_root: join(repo, '.documentation'), config: plugin_config_schema.parse({}), today: '2026-11-15' });
    const json = JSON.stringify(report);
    for (const value of [pass, token, host, ip, akia, account]) expect(json).not.toContain(value);
    expect(json).toContain('scheduled job at deploy/crontab:1');
  });
});

describe('finding 2: every name passes the gate', () => {
  it('k8s, CI, grafana names that are resources or hosts become placeholders', () => {
    expect(names('k8s-cronjob')).toEqual(['scheduled job at deploy/cron.yaml:12']);
    expect(names('gitlab-job')).toEqual(['CI job at .gitlab-ci.yml:1', 'lint']);
    expect(names('grafana')).toEqual(['Queue Backlog', 'alert rule at monitoring/grafana-alerts.json:1']);
  });
  it('id and key shaped route segments become :param; the placeholder carries no value', () => {
    expect(names('express-route', 'src/server.ts')).toEqual(['/hook/:param', '/orders', '/tenant/:param/x', '/users/:id']);
  });
  it('a placeholder is a surface the facet finds by position, not by value', async () => {
    const report = await run_coverage({ repo_root: repo, docs_root: join(repo, '.documentation'), config: plugin_config_schema.parse({}), today: '2026-11-15' });
    const placeholder = report.surfaces.find((s) => s.name === 'scheduled job at deploy/cron.yaml:12');
    expect(placeholder?.placeholder).toBe(true);
    expect(JSON.stringify(report.plan?.drafts)).not.toContain('prod');
  });
});

describe('finding 3: cron jobs are named by what they run', () => {
  it('wrappers, interpreters, cd, env and user columns are stripped', () => {
    const jobs = names('crontab', 'deploy/crontab').filter((n) => !n.startsWith('scheduled job at'));
    expect(jobs).toEqual(['boot_job', 'cleanup', 'compact', 'daily_job', 'hourly_job', 'rebuild_index', 'report', 'rotate_logs', 'user_col_job', 'vacuum']);
  });
});

describe('finding 4: Python shapes', () => {
  it('celery beat: CELERY_BEAT_SCHEDULE, single-line entries, any case', () => {
    expect(names('celery-beat', 'app/beat.py')).toEqual(['nightly-rebuild', 'rotate-logs']);
    expect(names('celery-beat', 'app/beat2.py')).toEqual(['one-liner', 'two-liner']);
  });
  it('click flags across lines, and click commands in every decorator form', () => {
    expect(names('click')).toEqual(['--dry-run', '--verbose']);
    expect(names('click-command')).toEqual(['export', 'migrate', 'solo', 'sync-all']);
  });
});

describe('finding 5: vendored and archived code is skipped by default', () => {
  it('root vendor, third_party and archive folders yield nothing', () => {
    expect(all.filter((s) => s.kind === 'constant').map((s) => s.name)).toEqual(['LIVE_LIMIT']);
  });
});

describe('a placeholder surface is drafted by position', () => {
  it('the judge is pointed at the surface line, also for a two-digit line', async () => {
    const report = await run_coverage({ repo_root: repo, docs_root: join(repo, '.documentation'), config: plugin_config_schema.parse({}), today: '2026-11-15' });
    const entries = JSON.stringify(report.plan?.drafts.entries);
    expect(entries).toContain('deploy/cron.yaml:12');
  });
});
