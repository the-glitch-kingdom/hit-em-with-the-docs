import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { apply_reviews } from '../../../src/core/reconcile/apply';
import { render_review, type ReviewEntry } from '../../../src/core/reconcile/review';
import { compute_content_hash, load_ledger, is_reviewed, get_ledger_status } from '../../../src/core/reconcile/ledger';
import { parse_frontmatter } from '../../../src/utils/frontmatter';

let root: string, docs: string, ledger_file: string, n: number;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const read = () => readFileSync(join(docs, 'backend/a.md'), 'utf-8');
const run = async (partial: Partial<ReviewEntry>, today: string, hash = compute_content_hash(read())) => {
  const f = join(root, `.hewtd/reconcile/review-${++n}-gaps.md`);
  mkdirSync(join(root, '.hewtd/reconcile'), { recursive: true });
  writeFileSync(f, render_review({ batch: String(n), shard: 1, scope: 'gaps' }, [{ path: 'backend/a.md', content_hash: hash, ...partial } as ReviewEntry]).replace(/- \[ \] accept/g, '- [x] accept'));
  return apply_reviews({ root, docs_root: docs, files: [f], ledger: await load_ledger(ledger_file), ledger_file, today });
};

beforeEach(() => {
  n = 0;
  root = mkdtempSync(join(tmpdir(), 'mk-'));
  docs = join(root, '.documentation');
  ledger_file = join(root, '.hewtd/reconcile.json');
  mkdirSync(join(docs, 'backend'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/x.ts'), 'export const x = 1;\n');
  writeFileSync(join(docs, 'backend/a.md'), '---\ntitle: A\ndomains:\n  - backend\ntier: guide\n---\n\n# A\n\nBody.\n');
  writeFileSync(join(root, '.gitignore'), '.hewtd/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('metadata verdicts keep the review (#92)', () => {
  it('fields after verify keeps verdict, reviewed_on and last_verified; records fields_on', async () => {
    expect((await run({ verdict: 'verify' }, '2026-11-01')).outcomes[0]!.status).toBe('applied');
    const verified = read();
    expect((await run({ verdict: 'fields', sources: ['src/x.ts'], frontmatter: { last_verified: '2030-01-01' } }, '2026-11-09')).outcomes[0]!.status).toBe('applied');
    const data = parse_frontmatter<Record<string, any>>(read()).data;
    expect(data.sources).toEqual(['src/x.ts']);
    expect(String(data.last_verified)).toContain('2026-11-01');
    const ledger = await load_ledger(ledger_file);
    const e = ledger.entries['backend/a.md']!;
    expect([e.verdict, e.reviewed_on, e.fields_on]).toEqual(['verify', '2026-11-01', '2026-11-09']);
    expect(e.content_hash).toBe(compute_content_hash(read()));
    expect(read()).not.toBe(verified);
    expect(is_reviewed(e, e.content_hash)).toBe(true);
    const st = get_ledger_status(ledger, [{ path: 'backend/a.md', hash: e.content_hash }]);
    expect([st.by_verdict, st.metadata_updated]).toEqual([{ verify: 1 }, 1]);
    // a fresh review of the unchanged doc clears the metadata-updated mark
    await run({ verdict: 'verify' }, '2026-11-09');
    const again = await load_ledger(ledger_file);
    expect(again.entries['backend/a.md']!.fields_on).toBeUndefined();
    expect(get_ledger_status(again, [{ path: 'backend/a.md', hash: e.content_hash }]).metadata_updated).toBe(0);
  });

  it('fields without an earlier review, or after the doc changed, records fields as before', async () => {
    await run({ verdict: 'fields', frontmatter: { purpose: 'p' } }, '2026-11-09');
    expect((await load_ledger(ledger_file)).entries['backend/a.md']!.verdict).toBe('fields');
    await run({ verdict: 'verify' }, '2026-11-10');
    const stale_hash = compute_content_hash(read());
    writeFileSync(join(docs, 'backend/a.md'), read() + 'more\n');
    await run({ verdict: 'fields', frontmatter: { purpose: 'q' } }, '2026-11-11');
    const e = (await load_ledger(ledger_file)).entries['backend/a.md']!;
    expect([e.verdict, e.reviewed_on, e.fields_on]).toEqual(['fields', '2026-11-11', undefined]);
    expect(stale_hash).not.toBe(e.content_hash);
  });

  it('a kept secret review keeps its env_names (review of #92)', async () => {
    mkdirSync(join(root, '.hewtd'), { recursive: true });
    const hash = compute_content_hash(read());
    writeFileSync(ledger_file, JSON.stringify({ version: 1, entries: { 'backend/a.md': { path: 'backend/a.md', lane: 'check', verdict: 'secret', reviewed_on: '2026-11-01', env_names: ['HEWTD_SECRET_DB_PASSWORD'], content_hash: hash } } }));
    await run({ verdict: 'fields', frontmatter: { purpose: 'p' } }, '2026-11-09');
    const e = (await load_ledger(ledger_file)).entries['backend/a.md']!;
    expect([e.verdict, e.env_names, e.fields_on]).toEqual(['secret', ['HEWTD_SECRET_DB_PASSWORD'], '2026-11-09']);
  });
});

