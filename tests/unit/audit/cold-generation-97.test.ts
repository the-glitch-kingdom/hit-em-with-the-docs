import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { check_documentation, count_actionable_issues } from '../../../src/core/audit/auditor.js';
import { compute_tree_checksum } from '../../../src/core/reconcile/rotation.js';

// #97: audit warns, never errors, when a cold generation changed or went missing.
let root: string;
const put = (rel: string, text: string): void => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const record = (checksum: string): void => put('.claude/hit-em-with-the-docs.json', JSON.stringify({ cold_storage: [{ generation: '2026-01-01', path: '.documentation-cold/2026-01-01', source_commit: 'abc', rotated_at: '2026-01-01T00:00:00Z', checksum, secrets_findings: [], untracked_files: [] }] }));
const audit = () => check_documentation({ docs_root: join(root, '.documentation'), repo_root: root, silent: true });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'audit-cold-'));
  put('.documentation/backend/a.md', '---\ntitle: a\ndomains:\n  - backend\n---\n\n# a\n');
  put('.documentation-cold/2026-01-01/backend/old.md', '# old\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('audit and cold generations (#97)', () => {
  it('is silent about an intact generation', async () => {
    record(compute_tree_checksum(join(root, '.documentation-cold/2026-01-01')));
    expect((await audit()).issues.filter((issue) => issue.rule.startsWith('COLD_GENERATION'))).toEqual([]);
  });

  it('warns, naming the generation, when it changed; the warning never counts as actionable', async () => {
    record(compute_tree_checksum(join(root, '.documentation-cold/2026-01-01')));
    writeFileSync(join(root, '.documentation-cold/2026-01-01/backend/old.md'), '# tampered\n');
    const issues = (await audit()).issues.filter((issue) => issue.rule.startsWith('COLD_GENERATION'));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: 'COLD_GENERATION_CHANGED', severity: 'warning' });
    expect(issues[0]!.message).toContain('2026-01-01');
    expect(issues[0]!.code).toBeUndefined();
    expect(count_actionable_issues(issues)).toBe(0);
  });

  it('warns when the generation folder is missing', async () => {
    record('deadbeef');
    rmSync(join(root, '.documentation-cold'), { recursive: true });
    chmodSync(root, 0o755);
    expect((await audit()).issues.map((issue) => issue.rule)).toContain('COLD_GENERATION_MISSING');
  });
});
