import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SURFACE_DETECTORS } from '../../../src/core/coverage/surfaces/detectors.js';
import { detect_declared_lists } from '../../../src/core/coverage/merge.js';
import { plan_coverage_misses } from '../../../src/core/coverage/plan.js';
import { load_plugin_config } from '../../../src/utils/config.js';

const detector = SURFACE_DETECTORS.find((found) => found.id === 'code-constant')!;
const run = (file: string, text: string) => detector.detect(file, text.split('\n')).map((surface) => [surface.name, surface.value] as const);

describe('Java, Kotlin and C# typed collections (#120 review)', () => {
  it('Java Map.of, int[] and List.of are named, never stated', () => {
    const text = 'class A {\n  private static final Map<Integer,Integer> TIER_CAPS = Map.of(1,10,2,50);\n  private static final int[] BACKOFF_SECONDS = {1,5,30};\n  static final List<Integer> BOUNDS = List.of(1,5);\n}';
    expect(run('A.java', text)).toEqual([['TIER_CAPS', undefined], ['BACKOFF_SECONDS', undefined], ['BOUNDS', undefined]]);
  });
  it('C# static readonly arrays', () => {
    expect(run('A.cs', 'class A {\n  static readonly int[] RETRY_STEPS = {1, 5};\n  public static readonly IReadOnlyList<int> CAPS = new[] { 1, 2 };\n}')).toEqual([['RETRY_STEPS', undefined], ['CAPS', undefined]]);
  });
  it('Kotlin listOf at top level and in a companion object', () => {
    expect(run('a.kt', 'val BOUNDS = listOf(1, 2)\nclass A {\n  companion object {\n    val TIERS = mapOf(1 to 2)\n  }\n  fun f() {\n    val LOCAL_SET = setOf(1)\n  }\n}')).toEqual([['BOUNDS', undefined], ['TIERS', undefined]]);
  });
  it('same name and value screening', () => {
    expect(run('A.java', 'class A {\n  static final List<String> API_KEYS = List.of("a");\n}')).toEqual([]);
    expect(run('A.java', 'class A {\n  static final List<String> LIMITS = List.of("' + 'AK' + 'IA' + 'Q7ZR3LMP9XVB2NCK");\n}')).toEqual([]);
  });
  it('an untyped Java local array is not a constant', () => {
    expect(run('A.java', 'class A {\n  void f() {\n    int[] LOCAL_X = {1};\n  }\n}')).toEqual([]);
  });
});

describe('declared lists come from the surface detectors (#120 review)', () => {
  const beat = "app.conf.beat_schedule = {\n    'nightly': {\n        'task': 'tasks.nightly',\n        'schedule': crontab(hour=2, minute=0),\n    },\n    'sweep': {\n        'task': 'tasks.sweep',\n        'schedule': timedelta(minutes=5),\n    },\n    'report': {\n        'task': 'tasks.report',\n        'schedule': crontab(hour=6),\n    },\n}\n\n\n\n\n\ndef helper():\n    return 1\n";
  it('a celery beat file with crontab() and timedelta entries is a schedules list', () => {
    const [list] = detect_declared_lists(new Map([['beat.py', beat]]));
    expect(list).toMatchObject({ kind: 'schedules', count: 3 });
  });
  it('covers names facets that are entries, not the helper', () => {
    const [list] = detect_declared_lists(new Map([['beat.py', beat]]), ['crontab\\(hour=2', 'def helper']);
    expect(list!.covers).toEqual(['crontab\\(hour=2']);
  });
  it('Flask blueprint and FastAPI router files are route lists', () => {
    const flask = "@bp.route('/a')\ndef a(): pass\n@bp.route('/b')\ndef b(): pass\n@bp.route('/c')\ndef c(): pass\n";
    const fast = "@api.get('/a')\ndef a(): pass\n@router.post('/b')\ndef b(): pass\n@router.get('/c')\ndef c(): pass\n";
    expect(detect_declared_lists(new Map([['v.py', flask], ['f.py', fast]])).map((list) => [list.file, list.kind, list.count])).toEqual([['f.py', 'routes', 3], ['v.py', 'routes', 3]]);
  });
});

describe('plan: beat.py with unrelated misses (#120 review)', () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'surf120-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/beat.py'), "app.conf.beat_schedule = {\n    'nightly': {\n        'task': 'tasks.nightly',\n        'schedule': crontab(hour=2, minute=0),\n    },\n    'sweep': {\n        'task': 'tasks.sweep',\n        'schedule': timedelta(minutes=5),\n    },\n    'report': {\n        'task': 'tasks.report',\n        'schedule': crontab(hour=6),\n    },\n}\n\n\n\n\n\n\n\ndef load_question_set(path):\n    return path\n\n\n\n\n\n\n\n\n\ndef parse_jsonl(text):\n    return text\n\n\n\n\n\n\n\n\n\n\n\ndef check_gaps_v1(doc):\n    return doc\n");
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'i'], { cwd: repo });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  it('three unrelated misses stay three units; the schedules hint only on entries', async () => {
    const gaps = [
      { query: 'how is the question set loaded', used_doc: null, id: 'a', facets: ['load_question_set'] },
      { query: 'what is the jsonl format', used_doc: null, id: 'b', facets: ['parse_jsonl'] },
      { query: 'what is gaps v1', used_doc: null, id: 'c', facets: ['check_gaps_v1'] },
      { query: 'when does nightly run', used_doc: null, id: 'd', facets: ["crontab\\(hour=2"] },
    ];
    const r = await plan_coverage_misses({ repo_root: repo, docs_root: join(repo, '.documentation'), config: await load_plugin_config(repo), gaps, today: '2026-11-15' });
    const hinted = r.proposals.filter((proposal) => proposal.generated_reference.some((list) => list.kind === 'schedules'));
    expect(r.proposals).toHaveLength(4);
    expect(hinted.map((proposal) => proposal.closes.map((closed) => closed.key))).toEqual([['d']]);
  });
});
