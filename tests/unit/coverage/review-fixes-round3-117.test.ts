// Regression tests for the third #117/#118 re-review (3.7.0): own code under vendor/ or archive/, cron job names, list grading, path tokens.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect_surfaces } from '../../../src/core/coverage/surfaces/index.js';
import { name_cron_command } from '../../../src/core/coverage/surfaces/detectors.js';
import { grade_surfaces } from '../../../src/core/coverage/grade.js';
import { has_path_token, type DocText } from '../../../src/core/coverage/decide.js';
import type { Surface } from '../../../src/core/coverage/surfaces/index.js';

describe('finding 1: only root-level vendor, third_party and archive are skipped', () => {
  it('src/vendor and src/archive code is own code; root ones and node_modules are not', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'round3-'));
    try {
      const w = (p: string, t: string): void => { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), t); };
      w('src/vendor/routes.ts', "app.get('/vendored-own', h);\n");
      w('src/archive/policy.ts', 'const RETENTION_LIMIT = 30;\n');
      w('vendor/x.ts', 'const ROOT_VENDOR_LIMIT = 1;\n');
      w('archive/x.ts', 'const ROOT_ARCHIVE_LIMIT = 1;\n');
      w('pkg/node_modules/x.ts', 'const NM_LIMIT = 1;\n');
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
      const found = (await detect_surfaces({ repo_root: repo, docs_root: join(repo, '.documentation') })).map((surface) => surface.name);
      expect(found).toContain('/vendored-own');
      expect(found).toContain('RETENTION_LIMIT');
      expect(found.join(',')).not.toMatch(/ROOT_|NM_LIMIT/);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe('finding 2: a job is named by what it runs', () => {
  const name = (command: string, user_column = false): string | undefined => name_cron_command(command, user_column);
  it('management commands are named by the subcommand', () => {
    expect(['clearsessions', 'send_digest', 'purge_trials'].map((sub) => name(`python manage.py ${sub}`))).toEqual(['clearsessions', 'send_digest', 'purge_trials']);
    expect(name('bundle exec rake db:cleanup')).toBe('db:cleanup');
    expect(name('php artisan queue:prune')).toBe('queue:prune');
    expect(name('npm run nightly-sync')).toBe('nightly-sync');
    expect(name('yarn rebuild')).toBe('rebuild');
    expect(name('make -C /srv/app purge')).toBe('purge');
    expect(name("rails runner 'Report.send_all'")).toBe('Report.send_all');
  });
  it('interpreter options and their values are skipped', () => {
    expect(name('python -W ignore x.py')).toBe('x');
    expect(name('node --max-old-space-size 4096 x.js')).toBe('x');
    expect(name('python -u -X dev job.py')).toBe('job');
  });
  it('the user column is skipped in a file that has one', () => {
    expect(name('root /etc/cron.daily/rotate', true)).toBe('rotate');
    expect(name('www-data python manage.py clearsessions', true)).toBe('clearsessions');
    expect(name('root purge_tmp', true)).toBe('purge_tmp');
  });
  it('docker and kubectl exec, flock and sh -c name the command run inside', () => {
    expect(name('docker exec web ./purge.sh')).toBe('purge');
    expect(name('docker exec -u app web python manage.py clearsessions')).toBe('clearsessions');
    expect(name('kubectl exec pod-1 -- /bin/refresh_cache')).toBe('refresh_cache');
    expect(name('flock -n /tmp/l -c "/opt/app/bin/compact_db --all"')).toBe('compact_db');
  });
  it('distinct lines never merge, even when the name is the same', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'round3-cron-'));
    try {
      mkdirSync(join(repo, 'deploy'), { recursive: true });
      writeFileSync(join(repo, 'deploy/crontab'), '0 1 * * * /opt/a/run\n0 2 * * * /opt/a/run\n');
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
      const jobs = (await detect_surfaces({ repo_root: repo, docs_root: join(repo, '.documentation') })).filter((surface) => surface.kind === 'scheduled-job');
      expect(jobs.map((job) => job.line)).toEqual([1, 2]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe('finding 3: a list names, it does not explain', () => {
  const job: Surface = { kind: 'scheduled-job', name: 'send_digest', file: 'jobs/cron.py', line: 1, source_kind: 'x' };
  const grade = (text: string): string => grade_surfaces([job], [{ path: 'ops/jobs.md', text, sources: ['jobs/cron.py'] } as DocText])[0]!.grade;
  it('lead-in lists, and/or joiners and snake_case names stay named', () => {
    expect(grade('Scheduled: purge_trials, send_digest, clear_sessions.\n')).toBe('named');
    expect(grade('The jobs are purge_trials, send_digest and clear_sessions.\n')).toBe('named');
    expect(grade('Jobs: purge_trials, clear_sessions or send_digest\n')).toBe('named');
    expect(grade('- send_digest, purge_trials, clear_sessions\n')).toBe('named');
  });
  it('another sentence stating purpose still explains it', () => {
    expect(grade('Scheduled: purge_trials, send_digest, clear_sessions.\n\nThe send_digest job emails every subscriber a summary of the previous day.\n')).toBe('explained');
  });
});

describe('finding 4: a path token is a file, a deep path or a link', () => {
  it('folder-first word pairs and Node.js are not paths', () => {
    for (const line of ['- the api/gateway handles auth', '- client/server split', '- config/flags are read at start', '- built on Node.js and Express.js']) expect(has_path_token(line)).toBe(false);
  });
  it('files, deep paths and code spans are', () => {
    for (const line of ['- src/index.ts', '- src/core/coverage', '- `api/gateway`', '- [gateway](api/gateway)', '- README.md']) expect(has_path_token(line)).toBe(true);
  });
});
