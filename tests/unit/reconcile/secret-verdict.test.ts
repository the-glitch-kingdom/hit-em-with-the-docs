import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { apply_reviews } from '../../../src/core/reconcile/apply';
import { render_review, write_review_skeletons, parse_review, type ReviewEntry } from '../../../src/core/reconcile/review';
import { hash_content, load_ledger } from '../../../src/core/reconcile/ledger';
import { fingerprint } from '../../../src/core/reconcile/secrets';
import type { TriageResult } from '../../../src/core/reconcile/triage';

// Secret-shaped strings are built at runtime so the repo holds no scannable literal.
const rnd = (n: number, seed = 7) => { let x = seed; let s = ''; const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += a[x % a.length]; } return s; };
const tok = 'hv' + 's.' + rnd(24);
const tok2 = 'hv' + 's.' + rnd(24, 11);

let root: string, docs: string, ledger_file: string;
const g = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf-8' }).trim();
const doc = (body: string) => `---\ntitle: a\ndomains:\n  - backend\n---\n\n# a\n\n${body}\n`;
const read = (rel: string) => readFileSync(join(docs, rel), 'utf-8');
const env = () => join(root, '.env.hewtd');
const entry = (over: Partial<ReviewEntry> = {}): ReviewEntry => ({ path: 'backend/a.md', content_hash: hash_content(read('backend/a.md')), verdict: 'secret', ...over });
const run = async (e: ReviewEntry) => {
  mkdirSync(join(root, '.hewtd/reconcile'), { recursive: true });
  const f = join(root, '.hewtd/reconcile/review-1-1.md');
  writeFileSync(f, render_review({ batch: '1', shard: 1, scope: 'backend' }, [e]).replace('- [ ] accept', '- [x] accept'));
  return apply_reviews({ root, docs_path: docs, files: [f], ledger: await load_ledger(ledger_file), ledger_file, today: '2026-11-07' });
};
const seed = (body: string, gitignore = '.hewtd/\n') => {
  writeFileSync(join(docs, 'backend/a.md'), doc(body));
  writeFileSync(join(root, '.gitignore'), gitignore);
  g('add', '-A'); g('commit', '-qm', 'seed');
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'secverd-'));
  docs = join(root, '.documentation');
  ledger_file = join(root, '.hewtd/reconcile.json');
  mkdirSync(join(docs, 'backend'), { recursive: true });
  g('init', '-q');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('secret verdict', () => {
  it('review skeleton proposes a secret entry with masked findings and env names, no value', async () => {
    seed(`VAULT_TOKEN=${tok}\nVAULT_TOKEN_2=${tok2}`);
    const triage = { docs: [{ path: 'backend/a.md', lane: 'secret', reasons: ['x'] }], shards: [] } as unknown as TriageResult;
    const [file] = await write_review_skeletons({ root, docs_path: docs, triage, scope: 's' });
    const text = readFileSync(file!, 'utf-8');
    expect(text).not.toContain(tok);
    expect(text).not.toContain(tok2);
    const [{ entry: e }] = (await parse_review(file!)).entries as [{ entry: ReviewEntry }];
    expect(e.verdict).toBe('secret');
    expect(e.secrets?.map((s) => s.env)).toEqual(['HEWTD_SECRET_VAULT_TOKEN', 'HEWTD_SECRET_VAULT_TOKEN_2']);
    expect(e.secrets![0]!.masked).toBe('hvs.…28');
  });

  it('moves values to a 0600 ignored .env.hewtd, leaves pointers, commits no value', async () => {
    seed(`VAULT_TOKEN=${tok}\nagain ${tok}`);
    const res = await run(entry({ secrets: [{ rule: 'vault-token', line: 9, masked: 'x', fingerprint: fingerprint(tok), env: 'HEWTD_SECRET_VAULT_TOKEN' }] }));
    expect(res.outcomes[0]).toMatchObject({ status: 'applied' });
    const after = read('backend/a.md');
    expect(after).not.toContain(tok);
    expect(after).toContain('<secret: HEWTD_SECRET_VAULT_TOKEN, see .env.hewtd>');
    expect(readFileSync(env(), 'utf-8')).toContain(`HEWTD_SECRET_VAULT_TOKEN=${tok}`);
    expect(statSync(env()).mode & 0o777).toBe(0o600);
    expect(() => g('check-ignore', '-q', '.env.hewtd')).not.toThrow();
    expect(g('show', 'HEAD').split('\n').filter((l) => l.startsWith('+')).join('\n')).not.toContain(tok);
    expect(g('ls-files')).not.toContain('.env.hewtd');
    expect(g('show', 'HEAD:.gitignore')).toContain('.env.hewtd');
    const led = (await load_ledger(ledger_file)).entries['backend/a.md']!;
    expect(led).toMatchObject({ verdict: 'secret', env_names: ['HEWTD_SECRET_VAULT_TOKEN'] });
    expect(JSON.stringify(led)).not.toContain(tok);
  });

  it('an existing name with a different value is an error and nothing is written', async () => {
    seed(`VAULT_TOKEN=${tok}`, '.hewtd/\n.env.hewtd\n');
    writeFileSync(env(), `HEWTD_SECRET_VAULT_TOKEN=${tok2}\n`);
    const before = read('backend/a.md');
    const res = await run(entry({ secrets: [{ rule: 'vault-token', line: 9, masked: 'x', fingerprint: fingerprint(tok), env: 'HEWTD_SECRET_VAULT_TOKEN' }] }));
    expect(res.outcomes[0]).toMatchObject({ status: 'error', detail: expect.stringContaining('different value') });
    expect(read('backend/a.md')).toBe(before);
    expect(readFileSync(env(), 'utf-8')).toBe(`HEWTD_SECRET_VAULT_TOKEN=${tok2}\n`);
    expect(res.outcomes[0]!.detail).not.toContain(tok);
  });

  it('refuses when .env.hewtd cannot be ignored; doc and .gitignore untouched', async () => {
    seed(`VAULT_TOKEN=${tok}`, '.hewtd/\n');
    rmSync(join(root, '.gitignore'));
    mkdirSync(join(root, '.gitignore')); // a directory: cannot be appended to
    const before = read('backend/a.md');
    const res = await run(entry());
    expect(res.outcomes[0]).toMatchObject({ status: 'error', detail: expect.stringContaining('cannot git-ignore') });
    expect(read('backend/a.md')).toBe(before);
    expect(existsSync(env())).toBe(false);
  });

  it('a failed batch rolls .env.hewtd and .gitignore back', async () => {
    seed(`VAULT_TOKEN=${tok}`);
    writeFileSync(join(root, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const gi = readFileSync(join(root, '.gitignore'), 'utf-8');
    const before = read('backend/a.md');
    const res = await run(entry());
    expect(res.outcomes[0]).toMatchObject({ status: 'error', detail: expect.stringContaining('rolled back') });
    expect(read('backend/a.md')).toBe(before);
    expect(existsSync(env())).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toBe(gi);
    expect(readdirSync(join(docs, 'backend'))).toContain('a.md');
  });

  it('a value in YAML frontmatter leaves frontmatter that still parses (review fix)', async () => {
    writeFileSync(join(docs, 'backend/a.md'), `---\ntitle: a\ndomains:\n  - backend\napi_token: ${tok}\n---\n\n# a\n\nbody\n`);
    writeFileSync(join(root, '.gitignore'), '.hewtd/\n');
    g('add', '-A'); g('commit', '-qm', 'seed');
    const res = await run(entry());
    expect(res.outcomes[0]!.status).toBe('applied');
    const { parse_frontmatter } = await import('../../../src/utils/frontmatter');
    const fm = parse_frontmatter<Record<string, unknown>>(read('backend/a.md')).data;
    expect(fm.api_token).toMatch(/^<secret: HEWTD_SECRET_\w+, see \.env\.hewtd>$/);
    expect(read('backend/a.md')).not.toContain(tok);
  });

  it('a short url password is replaced only where it was found, not in prose (review fix)', async () => {
    const pw = 'hunter' + '2';
    seed(`Connect with postgres://app:${pw}@db/main.\n\nThe ${pw} account is a ${pw} test persona.`);
    const res = await run(entry());
    expect(res.outcomes[0]!.status).toBe('applied');
    const t = read('backend/a.md');
    expect(t).toContain('postgres://app:<secret: ');
    expect(t).toContain(`The ${pw} account is a ${pw} test persona.`);
  });

  it('a malformed .env.hewtd line errors without quoting any of it (review fix)', async () => {
    seed(`VAULT_TOKEN=${tok}`);
    writeFileSync(env(), `HEWTD_SECRET_X="${tok2}\n`);
    const res = await run(entry());
    expect(res.outcomes[0]!.status).toBe('error');
    expect(res.outcomes[0]!.detail).toMatch(/malformed/);
    expect(JSON.stringify(res)).not.toContain(tok2.slice(4));
  });

  it('secret-lane docs get their own review file, never a shard file (review fix)', async () => {
    seed(`VAULT_TOKEN=${tok}`);
    writeFileSync(join(docs, 'backend/b.md'), doc('plain text, no secrets here at all'));
    g('add', '-A'); g('commit', '-qm', 'b');
    const triage = { docs: [{ path: 'backend/a.md', lane: 'secret', reasons: ['x'] }, { path: 'backend/b.md', lane: 'check', reasons: ['y'] }], shards: [{ id: 1, docs: ['backend/b.md'], bytes: 1 }] } as unknown as TriageResult;
    const files = await write_review_skeletons({ root, docs_path: docs, triage, scope: 's' });
    const names = files.map((f) => f.split('/').pop());
    expect(names.sort()).toEqual(['review-1-1.md', 'review-1-secrets.md']);
    expect(readFileSync(files.find((f) => f.endsWith('-1.md'))!, 'utf-8')).not.toContain('backend/a.md');
  });
});

