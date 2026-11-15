import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { find_security_check } from '../../../src/core/security/gate.js';
import { plugin_config_schema } from '../../../src/utils/config.js';
import { run_coverage, type CoverageReport } from '../../../src/core/coverage/coverage.js';

describe('checks written with quotes, sigils and membership calls', () => {
  const checks = [
    "if (!user.roles.includes('moderator')) {", "if (perms.has('write')) {", "if (scopes.includes('write')) {",
    'head :forbidden unless can?(:destroy, @record)', 'head :forbidden unless current_user.admin?', 'if (!passwordEncoder.matches(raw, stored)) {',
    '[ "$TOKEN" = "$EXPECTED" ] && go', 'if ($secret eq $given) {', 'if user.permissions.contains(&Perm::Write) {', 'ok, _ := enforcer.Enforce(sub, obj, act)',
    '@PreAuthorize("hasRole(\'ADMIN\')")', '@login_required', '@Authorize', '@UseGuards(AuthGuard)',
  ];
  for (const line of checks) it(line, () => { expect(find_security_check(line), line).toBeDefined(); });
  const negatives = [
    "@click.option('--max-tokens', default=4096)", "@click.command('cleanup-sessions')", '@Cacheable("tokens")', "@click.option('--token-count', type=int)",
    "app.use(cors({ origin: 'tokens' }))", 'if items.includes(tokens_limit) {', "@app.route('/sessions')",
  ];
  for (const line of negatives) it(`not a check: ${line}`, () => { expect(find_security_check(line), line).toBeUndefined(); });
});

describe('click lines through coverage', () => {
  let repo: string; let report: CoverageReport;
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'click-r3-'));
    mkdirSync(join(repo, 'app'), { recursive: true });
    writeFileSync(join(repo, 'app/cli.py'), "@click.option('--max-tokens', default=4096)\n@click.command('cleanup-sessions')\ndef run():\n    pass\n");
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'init'], { cwd: repo });
    report = await run_coverage({ repo_root: repo, docs_root: join(repo, '.documentation'), config: plugin_config_schema.parse({}), today: '2026-11-15' });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  it('are graded and drafted, not withheld', () => {
    expect(report.surfaces.map((s) => s.name).sort()).toEqual(['--max-tokens', 'cleanup-sessions']);
    expect(report.plan!.drafts.needs_human.filter((n) => /security/.test(n.reason))).toEqual([]);
    expect(report.plan!.drafts.entries.length).toBeGreaterThan(0);
  });
});
