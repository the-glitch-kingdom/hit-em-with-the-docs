// Regression tests for the final #117/#118 review, round 7 (3.7.0): explained sentences, click flag pairs, GitLab keys, no-git warning, cron subshells, click function names.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { plugin_config_schema } from '../../../src/utils/config.js';
import { run_coverage } from '../../../src/core/coverage/coverage.js';
import { grade_surfaces } from '../../../src/core/coverage/grade.js';
import { SURFACE_DETECTORS, name_cron_command, type Surface } from '../../../src/core/coverage/surfaces/detectors.js';
import type { DocText } from '../../../src/core/coverage/decide.js';

const doc = (path: string, text: string, sources: string[] = []): DocText => ({ path, text, sources });
const surface = (kind: Surface['kind'], name: string, file: string): Surface => ({ kind, name, file, line: 1, source_kind: 'x' });
const detect = (id: string, file: string, text: string): string[] => SURFACE_DETECTORS.find((d) => d.id === id)!.detect(file, text.split('\n')).map((s) => s.name);

describe('finding 1: a sentence with the name and content words explains it', () => {
  const cases: Array<[Surface, string]> = [
    [surface('scheduled-job', 'db_backup', 'ops/cron'), 'The db_backup job dumps the database nightly.'],
    [surface('scheduled-job', 'db_backup', 'ops/cron'), 'The db_backup job purges old dumps weekly.'],
    [surface('scheduled-job', 'db_backup', 'ops/cron'), 'The db_backup job backs up the database.'],
    [surface('scheduled-job', 'db_backup', 'ops/cron'), 'db_backup compresses and uploads the database dump.'],
    [surface('cli-flag', '--force', 'ops/cron'), 'The --force flag skips prompts.'],
    [surface('cli-flag', '--force', 'ops/cron'), '--force skips the confirmation prompt.'],
  ];
  it.each(cases)('%j explained by %s', (s, text) => { expect(grade_surfaces([s], [doc('ops/x.md', text, ['ops/cron'])])[0]!.grade).toBe('explained'); });
  it('still named without a citation, in a list, or with other surface names as the only words', () => {
    const job = surface('scheduled-job', 'db_backup', 'ops/cron');
    expect(grade_surfaces([job], [doc('ops/x.md', 'The db_backup job dumps the database nightly.')])[0]!.grade).toBe('named');
    expect(grade_surfaces([job], [doc('ops/x.md', 'Jobs: db_backup, purge_old, send_digest.', ['ops/cron'])])[0]!.grade).toBe('named');
    const others = [job, surface('scheduled-job', 'purge_old', 'ops/cron'), surface('scheduled-job', 'send_digest', 'ops/cron')];
    expect(grade_surfaces(others, [doc('ops/x.md', 'db_backup then purge_old then send_digest.', ['ops/cron'])])[0]!.grade).toBe('named');
  });
});

describe('finding 2: click boolean flag pairs', () => {
  it.each([['@click.option("--shout/--no-shout", default=False)', ['--shout']], ['@click.option("--dry-run/--apply")', ['--dry-run']], ["@click.option('-v/-q', '--verbose/--quiet')", ['--verbose']], ["@click.option('-v', '--verbose')", ['--verbose']], ["@click.option('--name', help='--other/--thing')", ['--name']]])('%s', (text, names) => {
    expect(detect('click', 'app/cli.py', text)).toEqual(names);
  });
});

describe('finding 3: gitlab job keys', () => {
  it('colon keys, quoted keys, trailing comments, trigger and extends jobs; reserved and hidden keys skipped', () => {
    const yaml = ['stages: [a]', 'image: node', 'variables:', '  X: 1', 'default:', '  script: [x]', 'test:unit:', '  script:', '    - a', '"deploy prod":', '  script: b', 'lint: # comment', '  script: c', 'downstream:', '  trigger: other/project', 'child:', '  extends: .base', '.base:', '  script: z', 'cache:', '  script: nope', ''].join('\n');
    expect(detect('gitlab-job', '.gitlab-ci.yml', yaml)).toEqual(['test:unit', 'deploy prod', 'lint', 'downstream', 'child']);
  });
});

describe('finding 4: not a git repo', () => {
  it('warns that surfaces come from tracked files', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'nogit-'));
    try {
      mkdirSync(join(repo, '.documentation'), { recursive: true });
      const report = await run_coverage({ repo_root: repo, docs_root: join(repo, '.documentation'), config: plugin_config_schema.parse({}) });
      expect(report.warnings.join(' ')).toMatch(/tracked files/);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe('finding 5: cron subshells, chains and short names', () => {
  it.each([['(cd /app && make nightly)', 'nightly'], ['backup.sh && b.sh', 'backup'], ['cd /app; ./run.sh && ./other.sh', 'run']])('%s', (command, name) => { expect(name_cron_command(command)).toBe(name); });
  it.each(['a', 'a.sh', 'x'])('a one-letter name %s is a placeholder', (command) => { expect(name_cron_command(command)).toBeUndefined(); });
  it('a one-letter or stop-word name is never matched as a word', () => {
    expect(grade_surfaces([surface('scheduled-job', 'a', 'ops/cron')], [doc('ops/x.md', 'A job runs a nightly backup of the whole database.', ['ops/cron'])])[0]!.grade).toBe('absent');
  });
});

describe('finding 6: click command from a function name', () => {
  it('is located at its own line', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'clickfn-'));
    const w = (path: string, text: string): void => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
    try {
      w('.documentation/ops/a.md', '---\ntitle: A\ntier: guide\ndomains: [ops]\nstatus: active\n---\n# A\n\nNothing here.\n');
      w('app/cli.py', 'import click\n\n@cli.command()\ndef migrate_data():\n    pass\n');
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
      const report = await run_coverage({ repo_root: repo, docs_root: join(repo, '.documentation'), config: plugin_config_schema.parse({}), today: '2026-11-15' });
      const found = report.surfaces.find((s) => s.name === 'migrate-data')!;
      expect(found).toMatchObject({ file: 'app/cli.py' });
      const judged = report.plan!.drafts.entries.flatMap((entry) => entry.for_judge ?? []).flatMap((item) => item.at);
      expect(judged).toEqual([`app/cli.py:${found.line}`]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
