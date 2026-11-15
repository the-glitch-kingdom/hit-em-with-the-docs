// Regression tests for the final #117/#118 review (3.7.0): code constants, helper-style checks, opaque route segments.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect_surfaces } from '../../../src/core/coverage/surfaces/index.js';
import { find_security_check, is_stateable_constant } from '../../../src/core/security/gate.js';

describe('finding 1: code constants', () => {
  it.each(['ACCESS_CODE', 'INVITE_CODE', 'UNLOCK_CODE', 'VERIFICATION_CODE', 'ADMIN_CODE', 'DOOR_CODE', 'RESET_CODE', 'RECOVERY_CODE', 'OTP_CODE', 'PIN_CODE', 'DB_WEIGHT_X'.replace('_X', '')])('%s = 482913 / 5433 is not stated', (name) => {
    expect(is_stateable_constant(name, name === 'DB_WEIGHT' ? '5433' : '482913')).toBe(false);
  });
  it.each([['GONE_RESPONSE_CODE', '410'], ['HTTP_CODE', '404'], ['EXIT_CODE', '2'], ['ERROR_CODE', '500'], ['STATUS_CODE', '204'], ['RETRY_LIMIT', '3']])('%s = %s is stated', (name, value) => {
    expect(is_stateable_constant(name, value)).toBe(true);
  });
  it.each([['REDIS_MAX', '6380'], ['CACHE_LIMIT', '4096'], ['QUEUE_PRIORITY', '2000'], ['SERVER_LIMIT', '8500'], ['HOST_COUNT', '3000']])('%s = %s is not stated (dynamic port range)', (name, value) => {
    expect(is_stateable_constant(name, value)).toBe(false);
  });
  it('a small measure, or a unit measure, under a service name is still stated', () => { expect(is_stateable_constant('DB_POOL_SIZE', '20')).toBe(true); expect(is_stateable_constant('SERVER_TIMEOUT_MS', '30000')).toBe(true); });
});

describe('finding 2: helper-style checks', () => {
  const checks = [
    'if not valid_password(req.pw):', 'if not token_valid(req.t):', 'tokenIsValid(token)', 'password_ok(pw)', 'safe_equal(a, b)', 'constantTimeEq(a, b)',
    'validSignature(body, sig)', 'totp.verify(code)', 'if (code !== storedCode) {', 'if pin == stored_pin:', "is_allowed(user, 'write')", 'policy.allows(user)',
    "userInGroup(user, 'admins')", 'if (!req.user) return 401', 'if (!request.user) { return 401; }', 'if request.user.is_anonymous:', 'if current_user.nil?',
    'password.eql?(user.password)', 'if (a != expectedValue) {', 'timing_safe(a, b)',
  ];
  for (const line of checks) it(line, () => { expect(find_security_check(line), line).toBeDefined(); });
  const negatives = ['valid_email(address)', 'if is_valid_date(d):', 'if (a === b) {', 'const ok = true;', 'x = compare(left, right)', 'validate_order(order)'];
  for (const line of negatives) it(`not a check: ${line}`, () => { expect(find_security_check(line), line).toBeUndefined(); });
});

describe('finding 3: opaque route segments', () => {
  let names: string[];
  let repo: string;
  const bare = ['sk', '-proj-abcdefghijklmnop'].join('');
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'round6-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, '.documentation/ops'), { recursive: true });
    writeFileSync(join(repo, '.documentation/ops/a.md'), '# a\n');
    const routes = ['/internal/admin/reset-7f3a9c', '/dl/a1b2c3', '/hooks/slack/T024BE7LD', '/s/Xk92jQpL', '/reset/Zm9vYmFy', `/v1/keys/${bare}`, '/cb?token=abc123def', '/v2beta/orders', '/v1/orders/:id', '/oauth2/callback'];
    writeFileSync(join(repo, 'src/server.ts'), routes.map((route) => `app.get('${route}', h);\n`).join(''));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
    names = (await detect_surfaces({ repo_root: repo, docs_root: join(repo, '.documentation') })).filter((s) => s.kind === 'http-route').map((s) => s.name);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  it('opaque segments become :param, query strings are dropped, versions stay', () => {
    expect(names).toEqual(['/internal/admin/:param', '/dl/:param', '/hooks/slack/:param', '/s/:param', '/reset/:param', '/v1/keys/:param', '/cb', '/v2beta/orders', '/v1/orders/:id', '/oauth2/callback']);
  });
});
