import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { apply_reviews } from '../../../src/core/reconcile/apply';
import { render_review, type ReviewEntry } from '../../../src/core/reconcile/review';
import { hash_content, load_ledger } from '../../../src/core/reconcile/ledger';
import { triage } from '../../../src/core/reconcile/triage';
import { load_plugin_config } from '../../../src/utils/config';

let root: string, docs: string, ledger_file: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const read = (rel: string) => readFileSync(join(docs, rel), 'utf-8');
const OWNER = '---\ntitle: Deploy guide\ndomains:\n  - backend\n---\n\n# Deploy guide\n\n## Release\n\nRun `deploy.sh --canary` and wait 30 minutes.\n\n## Other\n\nx\n';
const COPY = '---\ntitle: Admin\ndomains:\n  - backend\n---\n\n# Admin\n\nIntro.\n\nRun `deploy.sh --canary` and wait 30 minutes.\n\nOutro.\n';
const point = (): ReviewEntry => ({
  path: 'backend/admin.md', content_hash: hash_content(read('backend/admin.md')), verdict: 'point',
  remove: { old: 'Run `deploy.sh --canary` and wait 30 minutes.' },
  pointer: { summary: 'Canary release (`deploy.sh --canary`) for 30 minutes.', target: 'backend/deploy.md#release' },
  target_hash: hash_content(read('backend/deploy.md')),
});
const tri = async () => (await triage({ root, docsPath: docs, rels: ['backend/admin.md'], config: await load_plugin_config(root), ledger: await load_ledger(ledger_file) })).docs[0]!;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ps-'));
  docs = join(root, '.documentation');
  ledger_file = join(root, '.hewtd/reconcile.json');
  mkdirSync(join(docs, 'backend'), { recursive: true });
  writeFileSync(join(docs, 'backend/deploy.md'), OWNER);
  writeFileSync(join(docs, 'backend/admin.md'), COPY);
  writeFileSync(join(root, '.gitignore'), '.hewtd/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
  const f = join(root, '.hewtd/reconcile/review-1-1.md');
  mkdirSync(join(root, '.hewtd/reconcile'), { recursive: true });
  writeFileSync(f, render_review({ batch: '1', shard: 1, scope: 'backend' }, [point()]).replace(/- \[ \] accept/g, '- [x] accept'));
  const res = await apply_reviews({ root, docsPath: docs, files: [f], ledger: await load_ledger(ledger_file), ledgerFile: ledger_file, today: '2026-11-07' });
  expect(res.outcomes[0]!.status).toBe('applied');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pointer staleness', () => {
  it('records the target and section hash on apply', async () => {
    expect((await load_ledger(ledger_file)).entries['backend/admin.md']!.pointer).toMatchObject({ target: 'backend/deploy.md#release' });
  });

  it('an edit outside the section changes nothing', async () => {
    writeFileSync(join(docs, 'backend/deploy.md'), read('backend/deploy.md').replace('\nx\n', '\ny changed\n'));
    expect((await tri()).reasons.join()).not.toMatch(/pointer target/);
  });

  it('an edit inside the section sends the pointing doc to check', async () => {
    writeFileSync(join(docs, 'backend/deploy.md'), read('backend/deploy.md').replace('30 minutes', '45 minutes'));
    const d = await tri();
    expect(d.lane).toBe('check');
    expect(d.reasons).toContain('pointer target changed: backend/deploy.md#release');
  });

  it('a renamed heading reports the section missing', async () => {
    writeFileSync(join(docs, 'backend/deploy.md'), read('backend/deploy.md').replace('## Release', '## Shipping'));
    const d = await tri();
    expect(d.lane).toBe('check');
    expect(d.reasons.join()).toMatch(/pointer target changed: backend\/deploy.md#release \(section missing\)/);
  });
});

describe('pointer tracking survives later edits (review fix)', () => {
  it('a verify on the pointing doc does not end tracking; an owner change still sends it to check', async () => {
    const f = join(root, '.hewtd/reconcile/review-2-1.md');
    const verify: ReviewEntry = { path: 'backend/admin.md', content_hash: hash_content(read('backend/admin.md')), verdict: 'verify', sources: ['backend/deploy.md'] };
    writeFileSync(f, render_review({ batch: '2', shard: 1, scope: 'backend' }, [verify]).replace(/- \[ \] accept/g, '- [x] accept'));
    const res = await apply_reviews({ root, docsPath: docs, files: [f], ledger: await load_ledger(ledger_file), ledgerFile: ledger_file, today: '2026-11-08' });
    expect(res.outcomes[0]!.status).toBe('applied');
    expect((await load_ledger(ledger_file)).entries['backend/admin.md']!.pointer).toMatchObject({ target: 'backend/deploy.md#release' });
    writeFileSync(join(docs, 'backend/deploy.md'), read('backend/deploy.md').replace('30 minutes', '45 minutes'));
    expect((await tri()).reasons).toContain('pointer target changed: backend/deploy.md#release');
  });
});

