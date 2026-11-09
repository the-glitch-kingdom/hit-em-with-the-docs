import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { apply_reviews } from '../../../src/core/reconcile/apply';
import { render_review, type ReviewEntry } from '../../../src/core/reconcile/review';
import { compute_content_hash, load_ledger } from '../../../src/core/reconcile/ledger';
import { find_missing_tokens } from '../../../src/core/reconcile/noloss';

let root: string, docs: string, ledger_file: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const read = (rel: string) => readFileSync(join(docs, rel), 'utf-8');
const OWNER = '---\ntitle: Deploy guide\ndomains:\n  - backend\n---\n\n# Deploy guide\n\n## Release\n\nRun `deploy.sh` first.\n\n## Other\n\nx\n';
const COPY = '---\ntitle: Admin\ndomains:\n  - backend\n---\n\n# Admin\n\nIntro.\n\nRun `deploy.sh --canary` and wait 30 minutes.\n\nOutro.\n';
const OLD = 'Run `deploy.sh --canary` and wait 30 minutes.';
const h = (rel: string) => compute_content_hash(read(rel));
const run = async (entries: ReviewEntry[]) => {
  let t = render_review({ batch: '1', shard: 1, scope: 'backend' }, entries);
  t = t.replace(/- \[ \] accept/g, '- [x] accept');
  const f = join(root, '.hewtd/reconcile/review-1-1.md');
  mkdirSync(join(root, '.hewtd/reconcile'), { recursive: true });
  writeFileSync(f, t);
  return apply_reviews({ root, docs_root: docs, files: [f], ledger: await load_ledger(ledger_file), ledger_file, today: '2026-11-07' });
};
const point = (over: Partial<ReviewEntry> = {}): ReviewEntry => ({
  path: 'backend/admin.md', content_hash: h('backend/admin.md'), verdict: 'point', remove: { old: OLD },
  pointer: { summary: 'Release with a canary (`--canary`) for 30 minutes.', target: 'backend/deploy.md#release' }, target_hash: h('backend/deploy.md'), ...over,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mp-'));
  docs = join(root, '.documentation');
  ledger_file = join(root, '.hewtd/reconcile.json');
  mkdirSync(join(docs, 'backend'), { recursive: true });
  writeFileSync(join(docs, 'backend/deploy.md'), OWNER);
  writeFileSync(join(docs, 'backend/admin.md'), COPY);
  writeFileSync(join(root, '.gitignore'), '.hewtd/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('no-loss tokens', () => {
  it('lists flags and durations absent from owner and summary', () => {
    expect(find_missing_tokens(OLD, 'Run `deploy.sh` first.', 'Canary release.').sort()).toEqual(['--canary', '30']);
    expect(find_missing_tokens(OLD, 'x', 'Use `deploy.sh --canary`, 30 minutes.')).toEqual([]);
  });
});

describe('no-loss tokens (review fixes)', () => {
  const none = 'Unrelated owner text about something else.';
  it('bare numbers, quoted strings, URLs, table cells and code-block commands all count', () => {
    expect(find_missing_tokens('Listens on port 8080 with 3 retries.', none, '')).toEqual(expect.arrayContaining(['8080', '3']));
    expect(find_missing_tokens('Set the "Staging Gate" toggle to "on".', none, '')).toEqual(expect.arrayContaining(['Staging', 'Gate', 'on']));
    expect(find_missing_tokens('| env | url |\n|---|---|\n| prod | https://x.example.com |', none, '')).toEqual(expect.arrayContaining(['prod', 'https://x.example.com']));
    expect(find_missing_tokens('```sh\nmake release\nkubectl rollout undo web\n```', none, '')).toEqual(expect.arrayContaining(['kubectl', 'rollout', 'undo', 'web']));
  });
  it('matches whole tokens only, never fragments of other words', () => {
    expect(find_missing_tokens('run with -v and a 30s timeout', 'Use --verbose and a 130s timeout.', '')).toEqual(expect.arrayContaining(['-v', '30s']));
    expect(find_missing_tokens('run with -v and a 30s timeout', 'Use -v and a 30s timeout.', '')).toEqual([]);
  });
  it('plain prose words may be reworded', () => {
    expect(find_missing_tokens('Then simply wait for the release to finish.', 'Wait until it completes.', '')).toEqual([]);
  });
});

describe('merge (review fix)', () => {
  it('refuses a patch that deletes owner text', async () => {
    const before = read('backend/deploy.md');
    const merge: ReviewEntry = { path: 'backend/deploy.md', content_hash: h('backend/deploy.md'), verdict: 'merge', section: 'release', patch: [{ old: 'Run `deploy.sh` first.', new: '' }] };
    const res = await run([merge]);
    expect(res.outcomes[0]).toMatchObject({ status: 'error' });
    expect(res.outcomes[0]!.detail).toMatch(/merge would drop owner text; missing: .*deploy\.sh/);
    expect(read('backend/deploy.md')).toBe(before);
  });
});

describe('point', () => {
  it('refuses when the copy holds a flag the owner lacks, writes nothing', async () => {
    const res = await run([point({ pointer: { summary: 'Canary release.', target: 'backend/deploy.md#release' } })]);
    expect(res.outcomes[0]).toMatchObject({ status: 'error' });
    expect(res.outcomes[0]!.detail).toMatch(/missing: .*--canary/);
    expect(read('backend/admin.md')).toBe(COPY);
  });

  it('applies after a merge adds the content, merge first, one commit, ledger verdicts', async () => {
    const merge: ReviewEntry = { path: 'backend/deploy.md', content_hash: h('backend/deploy.md'), verdict: 'merge', section: 'release', patch: [{ old: 'Run `deploy.sh` first.', new: 'Run `deploy.sh` first, or `deploy.sh --canary` and wait 30 minutes.' }] };
    const res = await run([point({ depends_on_merge: 'backend/deploy.md' }), merge]);
    expect(res.outcomes.map((o) => o.status)).toEqual(['applied', 'applied']);
    expect(read('backend/deploy.md')).toContain('--canary');
    const t = read('backend/admin.md');
    expect(t).toContain('Release with a canary (`--canary`) for 30 minutes. Details: [Deploy guide: Release](deploy.md#release)');
    expect(t).not.toContain(OLD);
    expect(t).toContain('Intro.');
    expect(g('rev-list', '--count', 'HEAD')).toBe('3');
    const l = (await load_ledger(ledger_file)).entries;
    expect(l['backend/admin.md']!.verdict).toBe('point');
    expect(l['backend/deploy.md']!.verdict).toBe('merge');
  });

  it('refuses a missing anchor and a stale owner hash', async () => {
    let res = await run([point({ pointer: { summary: 'Release with a canary (`--canary`) for 30 minutes.', target: 'backend/deploy.md#nope' } })]);
    expect(res.outcomes[0]!.detail).toMatch(/anchor #nope/);
    res = await run([point({ target_hash: 'bad' })]);
    expect(res.outcomes[0]!.detail).toMatch(/owner doc changed/);
    expect(read('backend/admin.md')).toBe(COPY);
  });

  it('refuses a point whose merge was not applied', async () => {
    const res = await run([point({ depends_on_merge: 'missing' })]);
    expect(res.outcomes[0]!.detail).toMatch(/was not applied/);
  });

  it('a related-repo owner becomes a cross-link and nothing is written there', async () => {
    const sib = join(root, '..', `sib-${Date.now()}`);
    mkdirSync(join(sib, 'docs'), { recursive: true });
    const owner_text = OWNER.replace('Run `deploy.sh` first.', 'Run `deploy.sh --canary` and wait 30 minutes.');
    writeFileSync(join(sib, 'docs/deploy.md'), owner_text);
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude/hit-em-with-the-docs.json'), JSON.stringify({ reconcile: { related_repos: [{ name: 'sib', path: sib }] } }));
    try {
      const target = `${relative(docs, join(sib, 'docs/deploy.md'))}#release`;
      const res = await run([point({ pointer: { summary: 'Canary release.', target }, target_hash: compute_content_hash(owner_text) })]);
      expect(res.outcomes[0]!.detail ?? '').toBe('');
      expect(read('backend/admin.md')).toContain(`](${relative(join(docs, 'backend'), join(sib, 'docs/deploy.md'))}#release)`);
      expect(readFileSync(join(sib, 'docs/deploy.md'), 'utf-8')).toBe(owner_text);
    } finally { rmSync(sib, { recursive: true, force: true }); }
  });
});
