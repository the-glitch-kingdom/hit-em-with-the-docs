import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { build_repo_index, check_doc_references } from '../../../src/core/reconcile/references.js';

describe('review fix (#77): hewtd output is never a symbol source', () => {
  it('a name found only in a committed .hewtd/graph.json stays unresolved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'refs-hewtd-'));
    try {
      mkdirSync(join(root, '.hewtd'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, '.hewtd', 'graph.json'), '{"docs":{"a.md":{"refs":[{"target":"GhostNameZero"}]}}}\n');
      writeFileSync(join(root, '.hewtd', 'graph-cache.json'), '{"names":["GhostNameZero"]}\n');
      writeFileSync(join(root, 'src', 'real.ts'), 'export const realName = 1;\n');
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['add', '-A'], { cwd: root });
      const refs = await check_doc_references(build_repo_index(root), 'Uses `GhostNameZero()` and `realName()`.');
      expect(refs.find((ref) => ref.ref === 'GhostNameZero')?.where).toBeUndefined();
      expect(refs.find((ref) => ref.ref === 'realName')?.where).toBe('src/real.ts');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
