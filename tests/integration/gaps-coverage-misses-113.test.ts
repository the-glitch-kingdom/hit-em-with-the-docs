import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Labelled fixture (tests/fixtures/coverage-113) classified through the built CLI (#113).
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const FIXTURE = join(resolve(__dirname, '../..'), 'tests/fixtures/coverage-113');
const token = 'AK' + 'IA' + 'Q7ZR3LMP9XVB2NCK'; // runtime fragments: no secret literal in the repo
let root: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root } });
const gaps = [
  { id: 'missing-detail', tier: 'dev', query: 'how often is the cache purged', facets: ['cache_ttl', 'purge_interval'], missing_facets: ['purge_interval'], nearest_doc: { path: 'ops/cache.md', facet_coverage: '1/2', rank: null } },
  { id: 'absent', query: 'what does the csv export job do', facets: ['csv_export_job'] },
  { id: 'covered', query: 'which queue holds failed jobs', facets: ['dead_letter_queue', 'max_retries'], nearest_doc: { path: 'ops/queue.md', facet_coverage: '2/2', rank: 9 } },
  { id: 'two-a', query: 'when does the nightly report run', facets: ['nightly_report_job'] },
  { id: 'two-b', query: 'how big is a report batch', facets: ['report_batch_size'] },
  { id: 'instruction-only', query: 'when is the vacuum window', facets: ['vacuum_window'] },
  { id: 'security', query: 'how does the permission check on delete work', facets: ['check_delete_permission'] },
  { id: 'credential', query: 'which key does deploy use', facets: ['deploy_key_id'] },
  { id: 'blind', tier: 'blind', blind: true, query: 'how are invoices rounded', facets: ['invoice_rounding'] },
  { id: 'code-line', query: 'how long is the eviction ttl', facets: ['eviction_ttl = 24 \\* 60 \\* 60'] },
  { query: 'where is the zzz thing', used_doc: null },
];
const run = (extra: string[] = []) => { const r = hewtd(['reconcile', '--gaps', 'gaps.json', '--json', ...extra]); return { r, out: JSON.parse(r.stdout) }; };
const proposal_for = (out: any, key: string) => out.coverage.proposals.find((p: any) => p.closes.some((c: any) => c.key === key));
const all_text = (): string => (readdirSync(root, { recursive: true }) as string[]).filter((f) => !f.startsWith('.git/') && (f.startsWith('.documentation') || f.startsWith('.hewtd')) && /\.(md|json)$/.test(f)).map((f) => { try { return readFileSync(join(root, f), 'utf-8'); } catch { return ''; } }).join('\n');

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gaps-113-'));
  cpSync(FIXTURE, root, { recursive: true });
  writeFileSync(join(root, 'src/deploy.ts'), `export const deploy_key_id = "${token}";\n`);
  writeFileSync(join(root, '.gitignore'), '.hewtd/\n');
  writeFileSync(join(root, 'gaps.json'), JSON.stringify({ version: 1, source: 'fixture', gaps }));
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('reconcile --gaps with facets (built CLI, labelled fixture)', () => {
  it('classifies each labelled miss', () => {
    const { r, out } = run();
    expect(r.status).toBe(0);
    expect(proposal_for(out, 'missing-detail')).toMatchObject({ kind: 'extend', doc: 'ops/cache.md', missing_facets: ['purge_interval'] });
    expect(proposal_for(out, 'absent')).toMatchObject({ kind: 'new', source_files: ['src/reports/export.ts'] });
    expect(proposal_for(out, 'covered')).toMatchObject({ kind: 'covered', doc: 'ops/queue.md' });
    const two = proposal_for(out, 'two-a');
    expect(two).toMatchObject({ kind: 'new', domain: 'ops' });
    expect(two.closes.map((c: any) => c.key)).toEqual(['two-a', 'two-b']); // two misses, one proposal
    expect(proposal_for(out, 'instruction-only')).toMatchObject({ kind: 'instruction-only', instruction_files: ['CLAUDE.md'] });
    // #115: a credential line is withheld and the miss goes to a human with the reason, instead of being blocked
    expect(out.coverage.needs_human).toEqual([expect.objectContaining({ keys: ['credential'], reason: expect.stringContaining('src/deploy.ts:1') }), { keys: ['security'], source_files: ['src/auth/guard.ts'], reason: 'security check (permission or role check) at src/auth/guard.ts:1: a person must state it' }]);
    expect(out.coverage.blocked).toEqual([]);
    expect(out.coverage.skipped.some((s: any) => s.keys.includes('blind') && /blind/.test(s.reason))).toBe(true);
    expect(proposal_for(out, 'code-line').flags).toContain('facet-shape');
    expect(out.warnings.some((w: string) => /blind/.test(w))).toBe(true);
    expect(out.warnings.some((w: string) => /code line/.test(w))).toBe(true);
    expect(out.questions.map((q: any) => q.query)).toEqual(['where is the zzz thing']); // a gap without facets classifies as in 3.4.1
    expect(JSON.stringify(out)).not.toContain(token);
  });
  it('--write-review writes unticked drafts; nothing lands without --apply; apply adds docs, never overwrites', () => {
    const { out } = run(['--write-review']);
    const review_path = join(root, out.coverage_review);
    const review = readFileSync(review_path, 'utf-8');
    expect(review).not.toMatch(/- \[x\] accept/);
    // #115: only a simple constant is stated: report_batch_size (two) and purge_interval (missing-detail); functions, strings and the code-line facet wait for the judge
    expect((review.match(/"verdict": "create"/g) ?? []).length).toBe(1);
    expect((review.match(/"verdict": null/g) ?? []).length).toBe(2); // absent, code-line
    expect(review).toContain('"verdict": "verify"');
    expect(g('status', '--porcelain', '-uno')).toBe('');
    expect(existsSync(join(root, '.documentation/features'))).toBe(false);
    expect(review + all_text()).not.toContain(token);
    expect(review).not.toMatch(/\b3600\b|half-even/); // a constant is stated only for a missing facet (900, 200); cache_ttl and strings are not
    writeFileSync(review_path, review.replaceAll('- [ ] accept', '- [x] accept'));
    const applied = hewtd(['reconcile', '--apply', review_path]);
    expect(applied.status).toBe(0);
    const cache = readFileSync(join(root, '.documentation/ops/cache.md'), 'utf-8');
    expect(cache).toContain('`purge_interval` is `900` (`src/cache/store.ts`, line 2).');
    expect(existsSync(join(root, '.documentation/features/what-does-the-csv-export-job-do.md'))).toBe(false); // a null-verdict entry waits for the judge: ticked or not, apply leaves it
    expect(readFileSync(join(root, '.documentation/ops/nightly-report-job.md'), 'utf-8')).toContain('`report_batch_size` is `200` (`src/jobs/scheduler.ts`, line 2).');
    // never overwrites: replaying the same review is a no-op, and a fresh create on a taken path errors
    const head = g('rev-parse', 'HEAD');
    hewtd(['reconcile', '--apply', review_path]);
    expect(g('rev-parse', 'HEAD')).toBe(head);
    const before = readFileSync(join(root, '.documentation/ops/cache.md'), 'utf-8');
    const clash = join(root, '.hewtd/reconcile/review-9-coverage.md');
    writeFileSync(clash, review.replaceAll('- [ ] accept', '- [x] accept').replaceAll('ops/nightly-report-job.md', 'ops/cache.md').replace(/"path": "ops\/cache.md",\n  "content_hash": "[0-9a-f]+",\n  "verdict": "verify"/, '"path": "ops/skip-me.md",\n  "content_hash": "x",\n  "verdict": null'));
    const refused = hewtd(['reconcile', '--apply', clash]);
    expect(refused.stdout + refused.stderr).toMatch(/already exists \(never overwrites\)/);
    expect(readFileSync(join(root, '.documentation/ops/cache.md'), 'utf-8')).toBe(before);
  });
  it('an entry waiting for the judge (null verdict) changes nothing and stamps nothing, even ticked (#115)', () => {
    writeFileSync(join(root, 'gaps.json'), JSON.stringify({ version: 1, source: 'f', gaps: [{ id: 'fn', query: 'how is the cache purged', facets: ['cache_ttl', 'purge_cache'] }] }));
    const { out } = run(['--write-review']);
    const file = join(root, out.coverage_review);
    const text = readFileSync(file, 'utf-8');
    expect(text).toContain('"verdict": null');
    expect(text).toContain('"for_judge"');
    writeFileSync(file, text.replaceAll('- [ ] accept', '- [x] accept'));
    const before = readFileSync(join(root, '.documentation/ops/cache.md'), 'utf-8');
    const applied = hewtd(['reconcile', '--apply', file]);
    expect(applied.stdout + applied.stderr).toMatch(/no verdict/);
    expect(readFileSync(join(root, '.documentation/ops/cache.md'), 'utf-8')).toBe(before);
  });
  it('size constants are classified, one withheld facet keeps its miss, and a miss with every facet withheld is held for a human, not dropped (#115)', () => {
    writeFileSync(join(root, 'src/up.ts'), 'export const CHUNK_SIZE = 10 * 1024 * 1024;\n');
    g('add', '-A'); g('commit', '-qm', 'up');
    writeFileSync(join(root, 'gaps.json'), JSON.stringify({ version: 1, source: 'f', gaps: [
      { id: 'size', query: 'how big is an upload chunk', facets: ['CHUNK_SIZE'] },
      { id: 'mixed', query: 'where does it connect', facets: ['db-prod\\.acme-corp\\.internal', 'CHUNK_SIZE'] },
      { id: 'all', query: 'what is the address', facets: ['10\\.20\\.30\\.40'] },
    ] }));
    const { out } = run();
    expect(proposal_for(out, 'size')).toBeTruthy();
    expect(proposal_for(out, 'mixed')).toBeTruthy();
    expect(out.held_back).toEqual([{ keys: ['all'], reason: expect.stringContaining('every facet withheld') }]);
    expect(JSON.stringify(out)).not.toMatch(/acme-corp|10\.20\.30\.40/);
    expect(readFileSync(join(root, out.report), 'utf-8')).toContain('needs a human: every facet withheld');
  });
  it('--include-blind drafts from the blind entry', () => {
    const { out } = run(['--include-blind', '--write-review']);
    expect(out.coverage.skipped.some((s: any) => s.keys.includes('blind'))).toBe(false);
    expect(readFileSync(join(root, out.coverage_review), 'utf-8')).toContain('invoice_rounding');
  });
  it('the eval question-set JSONL is accepted directly', () => {
    writeFileSync(join(root, 'set.jsonl'), '{"id":"j1","tier":"dev","q":"what does the csv export job do","facets":["csv_export_job"]}\n');
    const r = hewtd(['reconcile', '--gaps', 'set.jsonl', '--json']);
    expect(JSON.parse(r.stdout).coverage.proposals[0]).toMatchObject({ kind: 'new' });
  });
  it('a file without facets is classified exactly as before', () => {
    writeFileSync(join(root, 'old.txt'), 'where is the zzz thing\n');
    const out = JSON.parse(hewtd(['reconcile', '--gaps', 'old.txt', '--json']).stdout);
    expect(Object.keys(out).sort()).toEqual(['candidates', 'dropped', 'errors', 'proposals', 'questions', 'report']);
  });

  describe('apply create edge cases and engine guards', () => {
    const only_absent = () => { writeFileSync(join(root, 'gaps.json'), JSON.stringify({ version: 1, source: 'f', gaps: [gaps[3], gaps[4]] })); const { out } = run(['--write-review']); const file = join(root, out.coverage_review); return { file, text: readFileSync(file, 'utf-8') }; };
    const accept = (text: string) => text.replaceAll('- [ ] accept', '- [x] accept');
    const applied_in = (file: string, text: string) => { writeFileSync(file, accept(text)); const r = hewtd(['reconcile', '--apply', file]); return r.stdout + r.stderr; };
    it('refuses a create path outside the docs root and a non-.md path', () => {
      const { file, text } = only_absent();
      expect(applied_in(file, text.replaceAll('ops/nightly-report-job.md', '../escaped.md'))).toMatch(/inside the docs root|error/i);
      expect(existsSync(join(root, 'escaped.md'))).toBe(false);
      expect(applied_in(file, text.replaceAll('ops/nightly-report-job.md', 'ops/x.txt'))).toMatch(/\.md path|error/i);
      expect(existsSync(join(root, '.documentation/ops/x.txt'))).toBe(false);
    });
    it('an edited draft that trips the gate is refused at apply', () => {
      const { file, text } = only_absent();
      const out = applied_in(file, text.replace('## What the code defines', 'Connect to db.internal.example.com on port 5432.\\n\\n## What the code defines'));
      expect(out).toMatch(/security gate/);
      expect(existsSync(join(root, '.documentation/ops/nightly-report-job.md'))).toBe(false);
    });
    it('a doc cited by a phrases entry and a coverage entry applies cleanly in two separate runs', () => {
      writeFileSync(join(root, 'gaps.json'), JSON.stringify({ version: 1, source: 'f', gaps: [gaps[0], { query: 'how often is the cache purged', used_doc: '.documentation/ops/cache.md' }, { query: 'how often is the cache purged now', used_doc: '.documentation/ops/cache.md' }] }));
      const { out } = run(['--write-review']);
      const coverage = join(root, out.coverage_review);
      const files = readdirSync(join(root, '.hewtd/reconcile')).filter((f) => f.endsWith('.md')).map((f) => join(root, '.hewtd/reconcile', f));
      const phrases = files.find((f) => f !== coverage);
      expect(applied_in(coverage, readFileSync(coverage, 'utf-8'))).not.toMatch(/error [1-9]/);
      if (phrases) expect(hewtd(['reconcile', '--apply', phrases]).status).toBe(0);
      expect(readFileSync(join(root, '.documentation/ops/cache.md'), 'utf-8')).toContain('purge_interval');
    });
    it('invalid and pathological facet regexes are reported, skipped and never hang', () => {
      const bad = ['(unclosed[', '(a+)+$', '(a|aa)*b'].map((f, n) => ({ id: `r${n}`, query: `q${n} thing here`, facets: [f] }));
      writeFileSync(join(root, 'src/long.ts'), 'a'.repeat(30000) + '\n');
      g('add', '-A'); g('commit', '-qm', 'long');
      writeFileSync(join(root, 'gaps.json'), JSON.stringify({ version: 1, source: 'f', gaps: bad }));
      const r = spawnSync('node', [CLI, 'reconcile', '--gaps', 'gaps.json', '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root }, timeout: 20000 });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).errors.filter((e: string) => /facet \d skipped/.test(e))).toHaveLength(3);
    }, 30000);
    it('no fake value, host, IP or id appears in --json, drafts or review files', () => {
      writeFileSync(join(root, 'src/net.ts'), 'export const db_url = "postgres://u:p@db.internal.example.com:5432/x";\nexport const host_ip = "10.20.30.40";\nexport const account_id = "123456789012";\nexport const csv_net_job = 1;\n');
      g('add', '-A'); g('commit', '-qm', 'net');
      writeFileSync(join(root, 'gaps.json'), JSON.stringify({ version: 1, source: 'f', gaps: [{ id: 'n', query: 'what is the net setup', facets: ['db_url', 'host_ip', 'account_id'] }, { id: 'm', query: 'what is the net job', facets: ['csv_net_job'] }] }));
      const { r, out } = run(['--write-review']);
      expect(out.coverage.blocked.length + out.coverage.proposals.length).toBeGreaterThan(0);
      const text = r.stdout + (out.coverage_review ? readFileSync(join(root, out.coverage_review), 'utf-8') : '') + all_text();
      for (const v of ['db.internal.example.com', '10.20.30.40', '123456789012', 'postgres://', 'u:p@']) expect(text).not.toContain(v);
    });
  });
});
