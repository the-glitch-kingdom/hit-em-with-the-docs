import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { apply_reviews } from '../../../src/core/reconcile/apply';
import { render_review, type ReviewEntry } from '../../../src/core/reconcile/review';
import { compute_content_hash, load_ledger, write_ledger } from '../../../src/core/reconcile/ledger';
import { triage_docs } from '../../../src/core/reconcile/triage';
import { load_plugin_config } from '../../../src/utils/config';
import { parse_frontmatter } from '../../../src/utils/frontmatter';

let root: string, docs: string, ledger_file: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const doc = (t: string) => `---\ntitle: ${t}\ndomains:\n  - backend\n---\n\n# ${t}\n\nBody.\n`;
const h = (rel: string) => compute_content_hash(readFileSync(join(docs, rel), 'utf-8'));
const DRAFT = '# Deploy flow\n\n1. Build. See [A](a.md).\n2. Ship. See [B](b.md).\n';
const entry = (over: Partial<ReviewEntry> = {}): ReviewEntry => ({
  path: 'backend/overview-deploy.md', content_hash: compute_content_hash(''), verdict: 'overview', draft: DRAFT,
  members: [{ path: 'backend/a.md', content_hash: h('backend/a.md') }, { path: 'backend/b.md', content_hash: h('backend/b.md') }],
  frontmatter: { title: 'Deploy flow', domains: ['backend'], purpose: 'The deploy flow.', last_validated: '2020-01-01' }, ...over,
});
const run = async (entries: ReviewEntry[]) => {
  const f = join(root, '.hewtd/reconcile/review-1-1.md');
  mkdirSync(join(root, '.hewtd/reconcile'), { recursive: true });
  writeFileSync(f, render_review({ batch: '1', shard: 1, scope: 'backend' }, entries).replace(/- \[ \] accept/g, '- [x] accept'));
  return apply_reviews({ root, docs_path: docs, files: [f], ledger: await load_ledger(ledger_file), ledger_file, today: '2026-11-07' });
};
const reconcile = async (...rels: string[]) => {
  const l = await load_ledger(ledger_file);
  for (const r of rels) l.entries[r] = { path: r, lane: 'check', verdict: 'verify', content_hash: h(r) };
  await write_ledger(ledger_file, l);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ov-'));
  docs = join(root, '.documentation');
  ledger_file = join(root, '.hewtd/reconcile.json');
  mkdirSync(join(docs, 'backend'), { recursive: true });
  writeFileSync(join(docs, 'backend/a.md'), doc('A'));
  writeFileSync(join(docs, 'backend/b.md'), doc('B'));
  writeFileSync(join(root, '.gitignore'), '.hewtd/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('overview verdict', () => {
  it('refuses unreconciled members and lists them', async () => {
    await reconcile('backend/a.md');
    const res = await run([entry()]);
    expect(res.outcomes[0]).toMatchObject({ status: 'error' });
    expect(res.outcomes[0]!.detail).toContain('backend/b.md');
    expect(res.outcomes[0]!.detail).not.toContain('backend/a.md');
    expect(existsSync(join(docs, 'backend/overview-deploy.md'))).toBe(false);
  });

  it('allow_unreviewed needs the (unreviewed) mark on the link', async () => {
    await reconcile('backend/a.md');
    let res = await run([entry({ allow_unreviewed: true })]);
    expect(res.outcomes[0]!.detail).toMatch(/\(unreviewed\)/);
    res = await run([entry({ allow_unreviewed: true, draft: DRAFT.replace('[B](b.md).', '[B](b.md) (unreviewed).') })]);
    expect(res.outcomes[0]!.status).toBe('applied');
  });

  it('refuses a member whose hash changed since the review', async () => {
    await reconcile('backend/a.md', 'backend/b.md');
    const e = entry();
    writeFileSync(join(docs, 'backend/b.md'), doc('B') + '\nEdited.\n');
    const res = await run([e]);
    expect(res.outcomes[0]!.detail).toMatch(/changed since.*backend\/b\.md/);
    expect(existsSync(join(docs, 'backend/overview-deploy.md'))).toBe(false);
  });

  it('creates kind: overview without last_validated, commits once, then a member edit sends it to check', async () => {
    await reconcile('backend/a.md', 'backend/b.md');
    const res = await run([entry()]);
    expect(res.outcomes[0]!.status).toBe('applied');
    const { data } = parse_frontmatter<Record<string, unknown>>(readFileSync(join(docs, 'backend/overview-deploy.md'), 'utf-8'));
    expect(data.kind).toBe('overview');
    expect(data.last_validated).toBeUndefined();
    expect(g('rev-list', '--count', 'HEAD')).toBe('2');
    const led = await load_ledger(ledger_file);
    expect(led.entries['backend/overview-deploy.md']).toMatchObject({ verdict: 'overview', members: { 'backend/a.md': h('backend/a.md') } });

    const cfg = await load_plugin_config(root);
    const tri = async () => (await triage_docs({ root, docs_path: docs, rels: ['backend/overview-deploy.md'], config: cfg, ledger: await load_ledger(ledger_file) })).docs[0]!;
    expect((await tri()).reasons.join()).not.toMatch(/member changed/);
    writeFileSync(join(docs, 'backend/a.md'), doc('A') + '\nEdited.\n');
    const after = await tri();
    expect(after.lane).toBe('check');
    expect(after.reasons).toContain('member changed: backend/a.md');
  });
});
