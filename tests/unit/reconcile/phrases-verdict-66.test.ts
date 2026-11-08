import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyReviews } from '../../../src/core/reconcile/apply';
import { renderReview, parseReview, writeGapsReview, type ReviewEntry } from '../../../src/core/reconcile/review';
import { hashContent, loadLedger } from '../../../src/core/reconcile/ledger';
import { parseFrontmatter } from '../../../src/utils/frontmatter';
import { validatePartialMetadata } from '../../../src/core/metadata/schema';

let root: string, docs: string, ledgerFile: string;
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const head = (title: string, symptoms: string) =>
  `---\ntitle: ${title}\ndomains:\n  - backend\ntier: guide\nlast_verified: "2020-01-01"\n${symptoms}---\n\n# ${title}\n\nBody.\n`;
const read = (rel: string) => readFileSync(join(docs, rel), 'utf-8');
const entry = (path: string, phrases: string[]): ReviewEntry => ({ path, content_hash: hashContent(read(path)), verdict: 'phrases', phrases });
const run = async (entries: ReviewEntry[], tick = true) => {
  const f = join(root, '.hewtd/reconcile/review-1-gaps.md');
  mkdirSync(join(root, '.hewtd/reconcile'), { recursive: true });
  let text = renderReview({ batch: '1', shard: 1, scope: 'gaps' }, entries);
  if (tick) text = text.replace(/- \[ \] accept/g, '- [x] accept');
  writeFileSync(f, text);
  return applyReviews({ root, docsPath: docs, files: [f], ledger: await loadLedger(ledgerFile), ledgerFile, today: '2026-11-07' });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ph-'));
  docs = join(root, '.documentation');
  ledgerFile = join(root, '.hewtd/reconcile.json');
  mkdirSync(join(docs, 'backend'), { recursive: true });
  writeFileSync(join(docs, 'backend/str.md'), head('Str', 'symptoms:\n  - deploy is stuck\n'));
  writeFileSync(join(docs, 'backend/obj.md'), head('Obj', 'symptoms:\n  - user_phrase: roll back the release\n    target: backend/obj.md\n    cites:\n      - fact-1\n'));
  writeFileSync(join(docs, 'backend/none.md'), head('None', ''));
  writeFileSync(join(docs, 'backend/other.md'), head('Other', ''));
  writeFileSync(join(root, '.gitignore'), '.hewtd/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('phrases verdict (#66)', () => {
  it('adds exactly the phrases to string, object and absent symptoms; one commit; last_verified untouched', async () => {
    const before = g('rev-list', '--count', 'HEAD');
    const res = await run([entry('backend/str.md', ['kick off the pipeline again']), entry('backend/obj.md', ['undo last release safely']), entry('backend/none.md', ['where do logs go'])]);
    expect(res.outcomes.map((o) => o.status)).toEqual(['applied', 'applied', 'applied']);
    expect(Number(g('rev-list', '--count', 'HEAD')) - Number(before)).toBe(1);
    expect(read('backend/str.md')).toContain('  - deploy is stuck\n  - kick off the pipeline again\n');
    const obj = parseFrontmatter<Record<string, any>>(read('backend/obj.md')).data;
    expect(obj.symptoms[0].user_phrase).toEqual(['roll back the release', 'undo last release safely']);
    expect(obj.symptoms[0].cites).toEqual(['fact-1']);
    expect(parseFrontmatter<Record<string, any>>(read('backend/none.md')).data.symptoms).toEqual(['where do logs go']);
    for (const f of ['str', 'obj', 'none']) {
      const d = parseFrontmatter<Record<string, any>>(read(`backend/${f}.md`)).data;
      expect(String(d.last_verified)).toContain('2020');
      expect(validatePartialMetadata({ symptoms: d.symptoms }).valid).toBe(true);
    }
    expect((await loadLedger(ledgerFile)).entries['backend/str.md']!.verdict).toBe('phrases');
  });

  it('rerun is a no-op; unaccepted and untouched docs stay byte-identical', async () => {
    const other = read('backend/other.md');
    await run([entry('backend/str.md', ['kick off the pipeline again'])]);
    const head1 = g('rev-parse', 'HEAD');
    const again = await run([entry('backend/str.md', ['kick off the pipeline again'])]);
    expect(again.outcomes[0]!.status).not.toBe('applied');
    expect(g('rev-parse', 'HEAD')).toBe(head1);
    expect(read('backend/other.md')).toBe(other);
  });

  it('unticked entry is untouched; stale hash refused; secret phrase refused at render', async () => {
    const before = read('backend/str.md');
    const res = await run([entry('backend/str.md', ['kick off the pipeline again'])], false);
    expect(res.outcomes[0]!.status).toBe('rejected');
    expect(read('backend/str.md')).toBe(before);
    const e = entry('backend/str.md', ['kick off the pipeline again']);
    writeFileSync(join(docs, 'backend/str.md'), before + 'x\n');
    expect((await run([e])).outcomes[0]!.status).toBe('stale');
    writeFileSync(join(docs, 'backend/str.md'), before);
    // the review writer refuses a secret-shaped phrase outright
    expect(() => renderReview({ batch: '1', shard: 1, scope: 'gaps' }, [entry('backend/str.md', [`why does ${'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'} fail login`])])).toThrow(/secret/);
  });

  it('re-enforces the cap and skips phrases already present', async () => {
    writeFileSync(join(docs, 'backend/str.md'), head('Str', 'symptoms:\n' + ['a b c', 'd e f', 'g h i', 'j k l'].map((s) => `  - ${s}\n`).join('')));
    const res = await run([entry('backend/str.md', ['kick off the pipeline again', 'rotate signing keys safely', 'a b c'])]);
    expect(res.outcomes[0]!.status).toBe('applied');
    const s = parseFrontmatter<Record<string, any>>(read('backend/str.md')).data.symptoms;
    expect(s).toHaveLength(5);
  });

  it('writeGapsReview writes one unticked phrases entry per doc', async () => {
    const f = (await writeGapsReview({ root, docsPath: docs, proposals: [{ doc: 'backend/str.md', accepted: [{ query: 'one two three' }] }] }))!;
    expect(f).toMatch(/review-1-gaps\.md$/);
    const r = await parseReview(f);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ accepted: false, entry: { verdict: 'phrases', path: 'backend/str.md', phrases: ['one two three'] } });
    expect(await writeGapsReview({ root, docsPath: docs, proposals: [] })).toBeUndefined();
  });
});
