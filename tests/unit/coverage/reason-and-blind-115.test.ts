import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build_drafts } from '../../../src/core/coverage/draft.js';
import { find_sensitive_word } from '../../../src/core/security/gate.js';
import type { Proposal } from '../../../src/core/coverage/merge.js';
import { classify_gaps, parse_gaps } from '../../../src/core/reconcile/gaps.js';
import { render_gaps_report } from '../../../src/core/reconcile/gaps-report.js';
import { load_plugin_config } from '../../../src/utils/config.js';

const config = { allow: [], disabled_rules: [] };
const proposal = (extra: Partial<Proposal>): Proposal => ({ kind: 'new', closes: [{ key: 'q1', query: 'how long is the cache ttl', count: 1 }], count: 1, missing_facets: ['cache_ttl'], sources: [{ file: 'src/cache.ts', line: 1 }], source_files: ['src/cache.ts'], cited_by: [], instruction_files: [], flags: [], notes: [], generated_reference: [], ...extra });
const run = (proposals: Proposal[]) => build_drafts({ repo_root: '/nonexistent', docs_root: '/nonexistent/.documentation', proposals, secrets_config: config, today: '2026-11-14' });

describe('needs_human carries a reason (#115)', () => {
  it('names the matched word or path and where it was, never a value', async () => {
    const [in_path, in_question, in_facet] = (await Promise.all([
      run([proposal({ source_files: ['src/auth/guard.ts'] })]),
      run([proposal({ closes: [{ key: 'q2', query: 'how does the permission check work', count: 1 }] })]),
      run([proposal({ missing_facets: ['jwt_expiry'] })]),
    ])).map((r) => r.needs_human[0]!);
    expect(in_path.reason).toBe('security-sensitive: `auth` in a source path');
    expect(in_question.reason).toBe('security-sensitive: `permission` in the question');
    expect(in_facet.reason).toBe('security-sensitive: `jwt` in a facet');
    expect(in_path).toMatchObject({ keys: ['q1'], source_files: ['src/auth/guard.ts'] });
  });
  it('find_sensitive_word returns the word, undefined when none', () => {
    expect(find_sensitive_word('check_auth_token')).toBe('auth');
    expect(find_sensitive_word('retry_limit')).toBeUndefined();
  });
  it('the gaps report shows the reason', async () => {
    const needs = (await run([proposal({ source_files: ['src/auth/guard.ts'] })])).needs_human;
    const empty = { proposals: [], candidates: [], questions: [], dropped: [], facet_gaps: [], warnings: [] };
    const report = render_gaps_report(empty, config, '2026-11-14', { decisions: [], proposals: [], drafts: { entries: [], needs_human: needs, blocked: [], skipped: [] }, warnings: [] });
    expect(report).toContain('- q1 (src/auth/guard.ts): security-sensitive: `auth` in a source path');
  });
});

describe('the blind warning says what happened (#115)', () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'blind115-'));
    mkdirSync(join(repo, '.documentation/ops'), { recursive: true });
    writeFileSync(join(repo, '.documentation/ops/a.md'), '# a\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  const warnings = async (include_blind?: boolean) => {
    const ctx = { docs_root: join(repo, '.documentation'), repo_root: repo };
    const gaps = parse_gaps(JSON.stringify([{ id: 'b1', blind: true, query: 'how are invoices rounded', facets: ['invoice_rounding'] }]), ctx).gaps;
    return (await classify_gaps(gaps, { root: repo, docs_root: ctx.docs_root, config: await load_plugin_config(repo), ...(include_blind && { include_blind }) })).warnings.find((text) => /blind/.test(text))!;
  };
  it('without --include-blind: not drafted', async () => {
    expect(await warnings()).toMatch(/classified but not drafted without --include-blind/);
  });
  it('with --include-blind: drafted, and the text no longer claims otherwise', async () => {
    const text = await warnings(true);
    expect(text).toMatch(/b1/);
    expect(text).toMatch(/classified and drafted \(--include-blind was passed\)/);
    expect(text).not.toMatch(/not drafted/);
  });
});
