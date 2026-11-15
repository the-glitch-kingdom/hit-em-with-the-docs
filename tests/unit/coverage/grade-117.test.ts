import { describe, it, expect } from 'vitest';
import { grade_surfaces, summarize_grades } from '../../../src/core/coverage/grade.js';
import type { Surface } from '../../../src/core/coverage/surfaces/index.js';
import type { DocText } from '../../../src/core/coverage/decide.js';

const doc = (path: string, text: string, sources: string[] = []): DocText => ({ path, text, sources });
const surface = (kind: Surface['kind'], name: string, file: string, value?: string): Surface => ({ kind, name, file, line: 1, source_kind: 'x', ...(value && { value }) });
const grade_of = (s: Surface, docs: DocText[]): string => grade_surfaces([s], docs)[0]!.grade;

describe('grade_surfaces (#117)', () => {
  it('absent: no doc names it', () => {
    expect(grade_of(surface('scheduled-job', 'purge_sessions', 'a/jobs.py'), [doc('ops/x.md', 'sessions are purged somehow')])).toBe('absent');
  });
  it('named: listed in a doc that says nothing about it', () => {
    const docs = [doc('ops/alerts.md', '# Alerts\n\n- HighErrorRate\n- DiskFull\n\n| Alert | Severity |\n| DiskFull | page |\n')];
    expect(grade_of(surface('alert-rule', 'DiskFull', 'monitoring/rules.yml'), docs)).toBe('named');
  });
  it('explained: a doc citing the source states what it does', () => {
    const docs = [doc('ops/alerts.md', '# Alerts\n\nDiskFull fires when a volume has under ten percent free space, and pages the on-call.\n', ['monitoring/rules.yml'])];
    expect(grade_of(surface('alert-rule', 'DiskFull', 'monitoring/rules.yml'), docs)).toBe('explained');
  });
  it('a sentence in a doc that does not cite the source is only named', () => {
    const docs = [doc('ops/other.md', 'DiskFull fires when a volume has under ten percent free space.')];
    expect(grade_of(surface('alert-rule', 'DiskFull', 'monitoring/rules.yml'), docs)).toBe('named');
  });
  it('a doc citing the source by path in its text counts as citing', () => {
    const docs = [doc('ops/other.md', 'In monitoring/rules.yml, DiskFull fires when a volume has under ten percent free space.')];
    expect(grade_of(surface('alert-rule', 'DiskFull', 'monitoring/rules.yml'), docs)).toBe('explained');
  });
  it('a section under a heading with the name explains it', () => {
    const docs = [doc('ops/jobs.md', '# Jobs\n\n## purge_sessions\n\nRemoves expired sessions every night and logs the count that was removed.\n', ['a/jobs.py'])];
    expect(grade_of(surface('scheduled-job', 'purge_sessions', 'a/jobs.py'), docs)).toBe('explained');
  });
  it('split forms match: camel, snake and kebab spellings, whole identifiers only', () => {
    const s = surface('background-task', 'send_receipt', 'app/tasks.py');
    expect(grade_of(s, [doc('a.md', 'The sendReceipt task emails a receipt after payment succeeds.', ['app/tasks.py'])])).toBe('explained');
    expect(grade_of(s, [doc('a.md', 'the send-receipt task')])).toBe('named');
    expect(grade_of(s, [doc('a.md', 'send_receipt_all is different, and so is resend_receipt')])).toBe('absent');
    expect(grade_of(surface('config-key', 'API_BASE', 'x.py'), [doc('a.md', 'API_BASE_URL is the thing')])).toBe('absent');
  });
  it('constants: explained when the doc states the value next to the name, in any spelling of the number', () => {
    const s = surface('constant', 'CACHE_TTL', 'src/limits.ts', '3600');
    expect(grade_of(s, [doc('a.md', 'The CACHE_TTL is 3,600 seconds.')])).toBe('explained');
    expect(grade_of(s, [doc('a.md', 'CACHE_TTL controls how long entries live.', ['src/limits.ts'])])).toBe('explained'); // purpose from the citing doc
    expect(grade_of(s, [doc('a.md', 'CACHE_TTL is listed here.')])).toBe('named');
    expect(grade_of(surface('constant', 'MAX_UPLOAD_BYTES', 'a.ts', '10 * 1024 * 1024'), [doc('a.md', 'MAX_UPLOAD_BYTES = 10 * 1024 * 1024')])).toBe('explained');
  });
  it('a constant without a stateable value is graded on the sentence rule alone', () => {
    const s = surface('constant', 'SECRET_TTL', 'app/settings.py');
    expect(grade_of(s, [doc('a.md', 'SECRET_TTL is 60', ['app/settings.py'])])).toBe('named'); // a value is not purpose
  });
  it('archive docs do not count; knowledge-base facts do, and the surface is never judged wrong for a fact the code lacks', () => {
    const s = surface('scheduled-job', 'purge_sessions', 'a/jobs.py');
    expect(grade_of(s, [doc('archive/old.md', 'purge_sessions removes sessions each night.', ['a/jobs.py'])])).toBe('absent');
    const fact = doc('knowledge-base/facts/f.md', 'purge_sessions removes sessions each night after the migration, because the old store leaked.', ['a/jobs.py']);
    const graded = grade_surfaces([s], [fact]);
    expect(graded[0]).toMatchObject({ grade: 'explained', explained_by: 'knowledge-base/facts/f.md' });
    expect(Object.keys(graded[0]!).sort()).toEqual(['explained_by', 'file', 'grade', 'kind', 'line', 'name', 'named_in', 'source_kind']);
  });
  it('routes and flags match literally with boundaries', () => {
    expect(grade_of(surface('http-route', '/users', 'a.ts'), [doc('a.md', 'GET /users returns a page of users')])).toBe('named');
    expect(grade_of(surface('http-route', '/users', 'a.ts'), [doc('a.md', 'GET /api/users and /users/list only')])).toBe('absent');
    expect(grade_of(surface('cli-flag', '--dry-run', 'a.py'), [doc('a.md', 'Use `--dry-run` to preview.')])).toBe('named');
    expect(grade_of(surface('cli-flag', '--dry', 'a.py'), [doc('a.md', 'Use `--dry-run` to preview.')])).toBe('absent');
  });
  it('a generic single-word job or command name counts only inside backticks', () => {
    expect(grade_of(surface('ci-job', 'build', 'a.yml'), [doc('a.md', 'we build the thing')])).toBe('absent');
    expect(grade_of(surface('ci-job', 'build', 'a.yml'), [doc('a.md', 'the `build` job')])).toBe('named');
  });
  it('is deterministic and keeps surface order', () => {
    const surfaces = [surface('constant', 'B_LIMIT', 'a.ts', '2'), surface('constant', 'A_LIMIT', 'a.ts', '1')];
    const docs = [doc('z.md', 'A_LIMIT is 1'), doc('a.md', 'A_LIMIT is 1')];
    const graded = grade_surfaces(surfaces, docs);
    expect(graded.map((g) => g.name)).toEqual(['B_LIMIT', 'A_LIMIT']);
    expect(graded[1]!.named_in).toEqual(['a.md', 'z.md']);
    expect(grade_surfaces(surfaces, docs)).toEqual(graded);
  });
});

describe('summarize_grades (#117)', () => {
  it('counts per kind and per area, with a total', () => {
    const graded = grade_surfaces([
      surface('alert-rule', 'DiskFull', 'monitoring/rules.yml'), surface('alert-rule', 'Gone', 'monitoring/rules.yml'),
      surface('constant', 'CACHE_TTL', 'src/a/limits.ts', '5'), surface('constant', 'ROOT_LIMIT', 'limits.py', '9'),
    ], [doc('a.md', 'DiskFull fires when space runs low and pages.', ['monitoring/rules.yml']), doc('b.md', 'CACHE_TTL is 5')]);
    expect(summarize_grades(graded)).toEqual({
      total: { total: 4, absent: 2, named: 0, explained: 2 },
      by_kind: { 'alert-rule': { total: 2, absent: 1, named: 0, explained: 1 }, constant: { total: 2, absent: 1, named: 0, explained: 1 } },
      by_area: { '.': { total: 1, absent: 1, named: 0, explained: 0 }, monitoring: { total: 2, absent: 1, named: 0, explained: 1 }, src: { total: 1, absent: 0, named: 0, explained: 1 } },
    });
  });
});
