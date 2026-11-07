import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildRepoIndex, checkDocReferences, extractReferences, type RepoIndex, type ResolvedReference } from '../../../src/core/reconcile/references.js';

let root: string;
const put = (p: string, c: string): void => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), c); };
const st = (rs: ResolvedReference[], ref: string) => rs.find((r) => r.ref === ref)?.status;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'refs-test-'));
  put('src/auth/login.ts', 'export function verifyToken() { return process.env.AUTH_SECRET_KEY; }\n');
  put('package.json', JSON.stringify({ scripts: { build: 'tsc' }, devDependencies: { vitest: '1' } }));
  put('Makefile', 'deploy:\n\techo hi\n');
  put('db/001.sql', 'CREATE TABLE users (\n id int primary key,\n email text,\n PRIMARY KEY (id)\n);\nALTER TABLE users ADD COLUMN age int;\n');
  put('prisma/schema.prisma', 'model Order {\n id Int @id\n total Int\n @@map("orders")\n}\n');
  put('docs/a.md', '# a\n');
  put('docs/note.md', 'mentions ghostSymbolName and GHOST_ENV_VAR\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('reconcile references', () => {
  let idx: RepoIndex;
  beforeAll(() => { idx = buildRepoIndex(root, ['db/*.sql', 'prisma/**/*.prisma']); });

  it('resolves and misses each kind', async () => {
    const body = [
      '`src/auth/login.ts` and `src/auth/gone.ts`, `verifyToken()` and `ghostSymbolName`,',
      '`AUTH_SECRET_KEY` and `GHOST_ENV_VAR`, `npm run build`, `npm run nope`, `make deploy`, `make nope`,',
      '`npx vitest`, `npx unheard-of-tool`, [ok](./a.md), [bad](./zzz.md)',
    ].join('\n');
    const rs = await checkDocReferences(idx, body, { docFile: join(root, 'docs/x.md'), docsPath: join(root, 'docs') });
    expect(st(rs, 'src/auth/login.ts')).toBe('ok');
    expect(st(rs, 'src/auth/gone.ts')).toBe('missing');
    expect(st(rs, 'verifyToken')).toBe('ok');
    expect(rs.find((r) => r.ref === 'verifyToken')?.where).toBe('src/auth/login.ts');
    expect(st(rs, 'ghostSymbolName')).toBe('missing'); // only mentioned in markdown
    expect(st(rs, 'AUTH_SECRET_KEY')).toBe('ok');
    expect(st(rs, 'GHOST_ENV_VAR')).toBe('missing');
    expect(st(rs, 'npm run build')).toBe('ok');
    expect(st(rs, 'npm run nope')).toBe('missing');
    expect(st(rs, 'make deploy')).toBe('ok');
    expect(st(rs, 'make nope')).toBe('missing');
    expect(st(rs, 'npx vitest')).toBe('ok');
    expect(st(rs, 'npx unheard-of-tool')).toBe('unknown');
    expect(st(rs, './a.md')).toBe('ok');
    expect(st(rs, './zzz.md')).toBe('missing');
  });

  it('flags an invented table and column, passes real ones (SQL + Prisma)', async () => {
    const body = '```sql\nSELECT email, age FROM users JOIN orders ON 1=1;\nSELECT * FROM ghost_ledger;\n```\n`users.email` `users.age` `users.phone_number` `orders.total`';
    const rs = await checkDocReferences(idx, body);
    expect(st(rs, 'users')).toBe('ok');
    expect(st(rs, 'orders')).toBe('ok');
    expect(st(rs, 'ghost_ledger')).toBe('missing');
    expect(st(rs, 'users.age')).toBe('ok');
    expect(st(rs, 'users.phone_number')).toBe('missing');
    expect(st(rs, 'orders.total')).toBe('ok');
  });

  it('example-output fences are ignored', () => {
    const rs = extractReferences('```text output\nnpm run phantom `src/x/y.ts`\n```\n```bash\nnpm run real\n```');
    expect(rs.map((r) => r.ref)).toEqual(['npm run real']);
  });

  it('no schema sources: table refs are unknown, never missing', async () => {
    const bare = buildRepoIndex(root, []);
    const rs = await checkDocReferences(bare, '`ghost_ledger.col_x` and ```sql\nSELECT 1 FROM ghost_ledger;\n```'.replace('```sql\n', '\n```sql\n'));
    expect(rs.filter((r) => r.kind === 'table' || r.kind === 'column').length).toBeGreaterThan(0);
    expect(rs.filter((r) => r.kind === 'table' || r.kind === 'column').every((r) => r.status === 'unknown')).toBe(true);
  });
});
