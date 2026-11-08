import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildRepoIndex, checkDocReferences } from '../../../src/core/reconcile/references.js';

let root: string;
const put = (p: string, c: string): void => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), c); };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'refs-def-'));
  put('src/auth.py', 'def require_role(role):\n    return role\n');
  put('a0/caller.py', 'require_role("y")\n'); // sorts before the definition, only references
  put('progress.json', '{"saveProgressForm": 1}\n');
  put('src/Form.tsx', 'export const saveProgressForm = () => {};\n');
  put('src/only.ts', 'doOnlyReferenced();\n');
  put('db/001.sql', 'CREATE TABLE IF NOT EXISTS public.user_accounts (id int);\n');
  put('src/models.py', 'class M:\n    __tablename__ = "order_items"\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('symbol definition site (#69)', () => {
  it('points at the defining file, not the first referencing one, and says which', async () => {
    const rs = await checkDocReferences(buildRepoIndex(root), 'Uses `require_role()`, `saveProgressForm()`, `doOnlyReferenced()`, `user_accounts()` and `order_items()`.');
    const at = (n: string) => rs.find((r) => r.ref === n);
    expect(at('require_role')).toMatchObject({ where: 'src/auth.py', whereKind: 'definition' });
    expect(at('saveProgressForm')).toMatchObject({ where: 'src/Form.tsx', whereKind: 'definition' });
    expect(at('doOnlyReferenced')).toMatchObject({ where: 'src/only.ts', whereKind: 'reference' });
    expect(at('user_accounts')).toMatchObject({ where: 'db/001.sql', whereKind: 'definition' });
    expect(at('order_items')).toMatchObject({ where: 'src/models.py', whereKind: 'definition' });
  });

  it('prefers a source file over JSON when nothing defines the name', async () => {
    put('zz.ts', 'useJsonOnlyName();\n');
    put('a.json', '{"useJsonOnlyName": 1}\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    const rs = await checkDocReferences(buildRepoIndex(root), 'Calls `useJsonOnlyName()`.');
    expect(rs[0]).toMatchObject({ where: 'zz.ts', whereKind: 'reference' });
  });

  it('a definition in source beats one in tests or mocks that sorts first', async () => {
    put('__mocks__/task.ts', 'export class TaskResponse {}\n');
    put('app/tests/fake.py', 'class TaskResponse:\n    pass\n');
    put('src/schemas/task.py', 'class TaskResponse:\n    pass\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    const rs = await checkDocReferences(buildRepoIndex(root), 'Returns `TaskResponse`.');
    expect(rs[0]).toMatchObject({ where: 'src/schemas/task.py', whereKind: 'definition' });
  });
});
