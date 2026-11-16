import { describe, it, expect } from 'vitest';
import { SURFACE_DETECTORS } from '../../../src/core/coverage/surfaces/detectors.js';

const detector = SURFACE_DETECTORS.find((found) => found.id === 'code-constant')!;
const run = (file: string, text: string) => detector.detect(file, text.split('\n')).map((surface) => [surface.name, surface.value] as const);

describe('class-level constants (#120 section 7)', () => {
  it('Python class body constants', () => {
    const text = 'class UploadService:\n    CHUNK_SIZE = 10 * 1024 * 1024\n    EXPIRY_HOURS = 24\n\n    def run(self):\n        LOCAL_CAP = 5\n';
    expect(run('svc/upload.py', text)).toEqual([['CHUNK_SIZE', '10 * 1024 * 1024'], ['EXPIRY_HOURS', '24']]);
  });
  it('an indented assignment outside a class is not a constant', () => {
    expect(run('svc/a.py', 'def f():\n    MAX_TRIES = 3\n')).toEqual([]);
  });
  it('Java static final and C# const fields', () => {
    expect(run('A.java', 'class A {\n  private static final int MAX_RETRIES = 5;\n}')).toEqual([['MAX_RETRIES', '5']]);
    expect(run('A.cs', 'class A {\n  public const int PAGE_SIZE = 50;\n}')).toEqual([['PAGE_SIZE', '50']]);
  });
  it('TS class static readonly, but not a local const', () => {
    expect(run('a.ts', 'class A {\n  static readonly TTL_SECONDS = 60;\n  run() {\n    const LOCAL_LIMIT = 3;\n  }\n}')).toEqual([['TTL_SECONDS', '60']]);
  });
  it('a port or credential name under a class is listed without a value', () => {
    expect(run('s.py', 'class S:\n    DB_PORT = 5432\n')).toEqual([['DB_PORT', undefined]]);
  });
});

describe('typed collection constants (#120 section 7)', () => {
  it('Python annotated list and TS Record are named, never stated', () => {
    expect(run('a.py', 'BOUNDS: List[int] = [1, 5, 10]\n')).toEqual([['BOUNDS', undefined]]);
    expect(run('a.ts', 'export const STEPS: Record<number, number> = {\n  1: 2,\n};\n')).toEqual([['STEPS', undefined]]);
    expect(run('a.py', 'class A:\n    TIERS: tuple = (1, 2)\n')).toEqual([['TIERS', undefined]]);
  });
  it('a credential-named collection or one holding a key is not listed', () => {
    expect(run('a.py', 'API_KEYS: List[str] = ["a"]\n')).toEqual([]);
    expect(run('a.py', 'LIMITS: List[str] = ["' + 'AK' + 'IA' + 'Q7ZR3LMP9XVB2NCK"]\n')).toEqual([]);
  });
  it('an unannotated collection is still not a constant', () => {
    expect(run('a.py', 'BOUNDS = [1, 2]\n')).toEqual([]);
  });
});
