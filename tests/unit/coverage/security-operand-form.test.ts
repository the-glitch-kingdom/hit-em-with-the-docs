import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { find_security_check } from '../../../src/core/security/gate.js';
import { build_drafts } from '../../../src/core/coverage/draft.js';
import type { Proposal } from '../../../src/core/coverage/merge.js';

// a check is a security operand word and a check form on one line, however the language spells it
describe('operand plus check form', () => {
  const checks = [
    'if (strcmp(supplied, stored_key) == 0) {', 'if (hash_equals($known, $user_string)) {', 'if (token.equals(storedToken)) {', 'MessageDigest.isEqual(a, b)',
    'if SecureCompare.compare(a, b)', 'if (user.IsInRole("Admin")) {', 'current_user.can?(:manage, Post)', 'Jwts.parser().setSigningKey(k).parseClaimsJws(raw)',
    '$ok = openssl_verify($data, $sig, $pub);', 'await crypto.subtle.verify(alg, key, sig, data)', 'if api_key in VALID_KEYS:', 'if pwd.eq(&stored) {',
    'if ($_POST["pass"] === $pw) {', 'if auth_header == "Bearer " + TOKEN:', 'Cipher c = Cipher.getInstance("AES");', 'if acl.check(user, res):',
    'if policy.evaluate(req):', 'if is_owner(user, doc):',
  ];
  for (const line of checks) it(line, () => { expect(find_security_check(line), line).toBeDefined(); });
  const negatives = [
    'if token_count == limit:', 'if (a === b) {', 'app.get("/auth/verify", handler)', '// check the password token against the hash', '# verify the session cookie',
    'if tokens.length === 0 {', 'for item in items:', 'x = compare(left, right)', 'if (status == "ok") {', 'const author = post.author;', 'if len(rows) == 0:',
  ];
  for (const line of negatives) it(`not a check: ${line}`, () => { expect(find_security_check(line), line).toBeUndefined(); });
});

describe('end to end', () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'secop-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/h.php'), 'if (hash_equals($known, $user_string)) { ok(); }\n');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  it('a handler line that is such a check goes to needs_human with a reason', async () => {
    const proposal: Proposal = { kind: 'new', domain: 'ops', closes: [{ key: 'q1', query: 'how does the handler respond', count: 1 }], count: 1, missing_facets: ['handler_flow'], sources: [{ file: 'src/h.php', line: 1 }], source_files: ['src/h.php'], cited_by: [], instruction_files: [], flags: [], notes: [], generated_reference: [] };
    const result = await build_drafts({ repo_root: repo, docs_root: join(repo, '.documentation'), proposals: [proposal], secrets_config: { allow: [], disabled_rules: [] }, today: '2026-11-15' });
    expect(result.entries).toEqual([]);
    expect(result.needs_human[0]!.reason).toContain('security check');
    expect(JSON.stringify(result)).not.toContain('hash_equals');
  });
});

describe('a constant set to a literal is not a check', () => {
  for (const line of ['export const AUTH_CHECK_ATTEMPTS = 3;', 'TOKEN_VERIFY_TIMEOUT = "30s"']) it(line, () => { expect(find_security_check(line), line).toBeUndefined(); });
});
