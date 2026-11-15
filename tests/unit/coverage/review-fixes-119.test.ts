import { describe, it, expect } from 'vitest';
import { is_stateable_constant, find_security_check } from '../../../src/core/security/gate.js';
import { extract_stated_constant } from '../../../src/core/coverage/draft.js';
import { resolve_decision, type DocText } from '../../../src/core/coverage/decide.js';

describe('a well-known port is never stated, whatever the name says it measures', () => {
  for (const line of ['BIND_MAX = 8080', 'CONN_LIMIT = 5432', 'REDIS_MAX = 6379', 'PROXY_TIMEOUT = 8080', 'const MAX_PORT_LIKE = 443;'])
    it(line, () => { expect(extract_stated_constant(line)).toBeUndefined(); });
  it('a measure that is not a port is still stated', () => {
    expect(is_stateable_constant('RETRY_LIMIT', '5')).toBe(true);
    expect(is_stateable_constant('CACHE_TTL', '3600')).toBe(true);
  });
});

describe('security checks are found by shape in other languages and frameworks', () => {
  const checks = [
    '@permission_required("x")', 'before_action :authenticate_user!', 'app.use(passport.authenticate("jwt"))', 'authorize! :manage, Post',
    '[Authorize(Roles = "Admin")]', '@UseGuards(AuthGuard)', 'def view(user = Depends(get_current_user)):', 'router.use(requireAuth)',
    'app.get("/x", requireAuth, handler)', 'if hmac.Equal(a, b) {', 'if hmac.compare_digest(a, b):', 'crypto.timingSafeEqual(a, b)',
    'if token == expected:', 'if (token === expected_value) {', 'if token != expected_token:', 'jwt.encode(payload, key)', 'jwt.sign(payload, key)',
    'digest = hashlib.sha256(secret).hexdigest()', 'bcrypt.hash(pw, 10)', 'argon2.hash(pw)', 'scrypt(pw, salt, 64)', 'if not user.is_authenticated:',
    'permission_classes = [IsAuthenticated]', '@login_required', '@requires_auth', 'requests.get(u, verify=False)', 'if sig != computed_signature:',
  ];
  for (const line of checks) it(line, () => { expect(find_security_check(line), line).toBeDefined(); });
  const ordinary = ['if (count === total) {', 'def token_count(self): return len(self.items)', 'if token_count == limit:', 'if status == "ok":', 'router.use(express.json())', 'app.get("/admin", handler)', 'x = y + 1'];
  for (const line of ordinary) it(`not a check: ${line}`, () => { expect(find_security_check(line), line).toBeUndefined(); });
});

describe('a knowledge-base doc is never an extend target for code-derived proposals', () => {
  const doc = (path: string, text: string, sources: string[] = []): DocText => ({ path, text, sources });
  const miss = { key: 'q', query: 'how does the cache expiry work', count: 1, facets: ['cache_expiry', 'cache_other'] };
  const located = { code: new Map([['cache_expiry', [{ file: 'src/c.ts', line: 1 }]]]), instructions: new Map() };
  it('facts holding most facets are skipped for another doc', () => {
    const three = { ...miss, facets: ['cache_expiry', 'cache_other', 'cache_third'] };
    const kb = doc('knowledge-base/facts/cache.md', 'cache_expiry cache_other', ['src/c.ts']);
    const other = doc('ops/cache.md', 'cache_expiry', ['src/c.ts']);
    expect(resolve_decision(three, located, [kb, other]).doc).toBe('ops/cache.md');
    const alone = resolve_decision(three, located, [kb]);
    expect(alone.kind).toBe('new');
  });
  it('a citing knowledge-base fact is not extended', () => {
    const kb = doc('knowledge-base/facts/cache.md', 'the cache expiry works so', ['src/c.ts']);
    expect(resolve_decision(miss, located, [kb]).kind).toBe('new');
  });
  it('covered still counts it', () => {
    const kb = doc('knowledge-base/facts/cache.md', 'cache_expiry cache_other', ['src/c.ts']);
    expect(resolve_decision(miss, located, [kb])).toMatchObject({ kind: 'covered', doc: 'knowledge-base/facts/cache.md' });
  });
});
