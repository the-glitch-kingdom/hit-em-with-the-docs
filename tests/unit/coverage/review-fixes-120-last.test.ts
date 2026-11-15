import { describe, it, expect } from 'vitest';
import { SURFACE_DETECTORS } from '../../../src/core/coverage/surfaces/detectors.js';
import { name_new_doc } from '../../../src/core/coverage/naming.js';
import { detect_declared_lists } from '../../../src/core/coverage/merge.js';

const constants = SURFACE_DETECTORS.find((found) => found.id === 'code-constant')!;
const constants_in = (file: string, text: string) => constants.detect(file, text.split('\n')).map((surface) => [surface.name, surface.value] as const);
const routes_in = (file: string, text: string) => SURFACE_DETECTORS.filter((found) => found.applies(file) && found.id === 'decorator-route').flatMap((found) => found.detect(file, text.split('\n'))).map((surface) => surface.name);

describe('Java method locals are not class constants (#120 review)', () => {
  it('a final local in a method body is skipped; static and access-modified fields stay', () => {
    const text = 'class A {\n  void f() {\n    final int LOCAL_MAX = 7;\n  }\n  private static final int MAX_RETRIES = 5;\n  public final int CAP = 9;\n}';
    expect(constants_in('A.java', text)).toEqual([['MAX_RETRIES', '5'], ['CAP', '9']]);
  });
});

describe('PascalCase C# constants (#120 review)', () => {
  it('const and static readonly fields in .cs files are constants', () => {
    const text = 'class A {\n  public const int MaxSeats = 40;\n  static readonly int[] Tiers = { 1, 2 };\n  void F() {\n    const int Local = 3;\n  }\n}';
    expect(constants_in('A.cs', text)).toEqual([['MaxSeats', '40'], ['Tiers', undefined]]);
  });
  it('a PascalCase name is not a constant outside C#, or without const / static readonly', () => {
    expect(constants_in('a.ts', 'export const MaxSeats = 40;')).toEqual([]);
    expect(constants_in('A.cs', 'class A {\n  public int MaxSeats = 40;\n}')).toEqual([]);
  });
  it('the same screening: a credential-named PascalCase collection is not listed', () => {
    expect(constants_in('A.cs', 'class A {\n  static readonly string[] ApiKeys = { "a" };\n}')).toEqual([]);
  });
});

describe('multi-line and further route forms (#120 review)', () => {
  it('a FastAPI decorator whose path is on the next line', () => {
    expect(routes_in('a.py', '@router.post(\n    "/orders",\n    response_model=Order,\n)\ndef make(): pass\n')).toEqual(['/orders']);
  });
  it('api_route, websocket and add_url_rule', () => {
    expect(routes_in('a.py', "@api.api_route('/any', methods=['GET'])\n@api.websocket('/ws')\napp.add_url_rule('/legacy', view_func=old)\n")).toEqual(['/any', '/ws', '/legacy']);
  });
  it('a single-line decorator is still found once', () => {
    expect(routes_in('a.py', "@app.get('/a')\ndef a(): pass\n")).toEqual(['/a']);
  });
});

describe('a new doc is named from a subject identifier (#120 review)', () => {
  it('an incidental security identifier never names the doc', () => {
    expect(name_new_doc({ queries: ['why session reaped on last used'], facets: ['verify_password', 'last-used', 'offline token'], source_files: ['src/auth/reaper.py'] })).toBe('reaper');
  });
  it('an identifier sharing a word with the question wins over one that does not', () => {
    expect(name_new_doc({ queries: ['how long is the session timeout'], facets: ['retry_budget', 'session_timeout'], source_files: [] })).toBe('session-timeout');
  });
  it('with no shared identifier and no module, the question phrase names it', () => {
    expect(name_new_doc({ queries: ['max retries'], facets: ['TIMEOUT_SECONDS'], source_files: [] })).toBe('max-retries');
  });
  it('a security identifier the question names is still a subject', () => {
    expect(name_new_doc({ queries: ['how is the password verified'], facets: ['verify_password'], source_files: [] })).toBe('verify-password');
  });
});

describe('the hint covers only an entry key or schedule line (#120 review)', () => {
  const beat = "app.conf.beat_schedule = {\n    'nightly': {\n        'task': 'tasks.idle_sweep',\n        'schedule': crontab(hour=2),\n        'options': {'queue': 'slow'},\n    },\n    'sweep': {\n        'task': 'tasks.sweep',\n        'schedule': timedelta(minutes=5),\n    },\n    'report': {\n        'task': 'tasks.report',\n        'schedule': crontab(hour=6),\n    },\n}\n";
  it('a facet on the task path or options line does not cover', () => {
    expect(detect_declared_lists(new Map([['beat.py', beat]]), ['idle'])).toEqual([]);
    expect(detect_declared_lists(new Map([['beat.py', beat]]), ['queue'])).toEqual([]);
  });
  it('the key line and the schedule line cover', () => {
    const [list] = detect_declared_lists(new Map([['beat.py', beat]]), ["'nightly'", 'timedelta\\(minutes=5', 'idle']);
    expect(list!.covers).toEqual(["'nightly'", 'timedelta\\(minutes=5']);
  });
});
