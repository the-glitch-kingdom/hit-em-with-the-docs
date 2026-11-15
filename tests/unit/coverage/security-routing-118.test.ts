import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build_drafts } from '../../../src/core/coverage/draft.js';
import { find_security_check, is_security_check_line } from '../../../src/core/security/gate.js';
import type { Proposal } from '../../../src/core/coverage/merge.js';
import { render_gaps_report } from '../../../src/core/reconcile/gaps-report.js';

let repo: string, docs: string;
const w = (p: string, t: string): void => { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), t); };
const config = { allow: [], disabled_rules: [] };
const unit = (file: string, query: string, facet: string, line = 1): Proposal => ({ kind: 'new', domain: 'ops', closes: [{ key: 'q1', query, count: 1 }], count: 1, missing_facets: [facet], sources: [{ file, line }], source_files: [file], cited_by: [], instruction_files: [], flags: [], notes: [], generated_reference: [] });
const run = (proposals: Proposal[]) => build_drafts({ repo_root: repo, docs_root: docs, proposals, secrets_config: config, today: '2026-11-15' });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'sec118-'));
  docs = join(repo, '.documentation');
  mkdirSync(docs, { recursive: true });
  w('src/db/pool.ts', 'export function open_session(pool: Pool) { return pool.acquire(); }\n');
  w('src/jobs/cleanup.ts', 'export const REGISTRATION_TOKEN_CLEANUP_HOURS = 6;\n');
  w('src/auth/emails.ts', 'export const TRIAL_EMAIL_DAYS = 3;\n');
  w('src/auth/guard.ts', 'if (!crypto.timingSafeEqual(left, right)) throw new Error("no");\n');
  w('src/api/delete.ts', 'if (!user.has_permission("delete")) throw new Forbidden();\n');
  w('infra/policy.json', '{ "Effect": "Allow", "Action": "s3:GetObject" }\n');
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('topic words alone: drafted, marked security-adjacent (#118 section 2)', () => {
  it('a database session helper is drafted, marked with the word and where', async () => {
    const r = await run([unit('src/db/pool.ts', 'how does the database session helper work', 'open_session')]);
    expect(r.needs_human).toEqual([]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ security_adjacent: { word: 'session', where: 'the question' } });
    expect(r.entries[0]!.reasons!.join(' ')).toContain('security-adjacent: judge carefully');
    expect(r.security_adjacent).toEqual([{ keys: ['q1'], word: 'session', where: 'the question' }]);
  });
  it('a registration-token cleanup schedule is drafted', async () => {
    const r = await run([unit('src/jobs/cleanup.ts', 'when does the registration token cleanup run', 'REGISTRATION_TOKEN_CLEANUP_HOURS')]);
    expect(r.needs_human).toEqual([]);
    expect(r.entries[0]).toMatchObject({ security_adjacent: { word: 'token' } });
  });
  it('a trial email schedule under an auth path is drafted; the mark names the source path', async () => {
    const r = await run([unit('src/auth/emails.ts', 'how many days is the trial email schedule', 'TRIAL_EMAIL_DAYS')]);
    expect(r.needs_human).toEqual([]);
    expect(r.entries[0]).toMatchObject({ security_adjacent: { word: 'auth', where: 'a source path' } });
  });
  it('an entry with no sensitive word carries no mark', async () => {
    w('src/q.ts', 'export const RETRY_LIMIT = 5;\n');
    const r = await run([unit('src/q.ts', 'what is the retry limit', 'RETRY_LIMIT')]);
    expect(r.entries[0]).not.toHaveProperty('security_adjacent');
    expect(r).not.toHaveProperty('security_adjacent');
  });
});

describe('a located line that is a security check: needs a human (#118 section 2)', () => {
  it('a secret comparison, a permission check and a policy document are withheld with the kind and file:line, never the line', async () => {
    for (const [file, kind] of [['src/auth/guard.ts', 'crypto or credential check'], ['src/api/delete.ts', 'permission or role check'], ['infra/policy.json', 'access policy']] as const) {
      const r = await run([unit(file, 'how does the delete work', 'x_facet')]);
      expect(r.entries, file).toEqual([]);
      expect(r.needs_human[0]!.reason, file).toBe(`security check (${kind}) at ${file}:1: a person must state it`);
      expect(JSON.stringify(r)).not.toContain('timingSafeEqual');
      expect(JSON.stringify(r)).not.toContain('s3:GetObject');
    }
  });
  it('is_security_check_line: verify, compare, hash, sign, decrypt, roles, policies, firewall rules', () => {
    for (const line of [
      'if (!crypto.timingSafeEqual(a, b)) return false;', 'ok = hmac.compare_digest(sig, expected)', 'jwt.verify(raw, key)', 'const digest = createHmac("sha256", k)',
      'hashed = bcrypt.hashpw(pw, salt)', 'plain = decrypt(blob)', 'if (!user.has_permission("x")) deny()', '@requires_role("admin")', 'if user.role == "admin":',
      '{ "Effect": "Allow", "Action": "s3:*" }', 'resource "aws_security_group" "web" {', 'cidr_blocks = ["0.0.0.0/0"]', 'iptables -A INPUT -p tcp -j DROP', 'if password == stored:',
    ]) expect(is_security_check_line(line), line).toBe(true);
    for (const line of [
      'const session = pool.acquire();', 'REGISTRATION_TOKEN_CLEANUP_HOURS = 6', 'schedule: "0 3 * * *"', 'MAX_LOGIN_PAGE_SIZE = 20', 'const author = post.author;', 'return Math.sign(delta);', 'const design = load()',
    ]) expect(is_security_check_line(line), line).toBe(false);
    expect(find_security_check('jwt.verify(raw, key)')).toBe('crypto or credential check');
  });
});

describe('report and judge instructions', () => {
  it('the report lists security-adjacent units and says judge carefully', async () => {
    const r = await run([unit('src/db/pool.ts', 'how does the database session helper work', 'open_session')]);
    const empty = { proposals: [], candidates: [], questions: [], dropped: [], facet_gaps: [], warnings: [] };
    const text = render_gaps_report(empty, config, '2026-11-15', { decisions: [], proposals: [], drafts: r, warnings: [] });
    expect(text).toContain('security-adjacent: judge carefully');
    expect(text).toContain('q1');
  });
  it('commands/reconcile.md tells the judge to take extra care', () => {
    expect(readFileSync('commands/reconcile.md', 'utf-8')).toMatch(/security_adjacent[\s\S]{0,400}(no values|never)/i);
  });
});
