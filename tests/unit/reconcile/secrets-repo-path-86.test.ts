import { describe, it, expect } from 'vitest';
import { scan_text } from '../../../src/core/reconcile/secrets';

// Secret-shaped strings are built at runtime from a seeded generator so the repo never holds a scannable literal.
const make_draw = (seed: number) => (n: number) => { let out = ''; for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out += 'abcdefghijklmnopqrstuvwyzABCDEFGHIJKLMNOPQRSTUVWYZ0123456789'[(seed >> 8) % 62]; } return out; };
const draw = make_draw(86);
const config = { allow: [], disabled_rules: [] } as Parameters<typeof scan_text>[2];
const found = (text: string) => scan_text(text, 'doc.md', config).some((finding) => finding.rule === 'generic-secret');

describe('repo-relative paths are not generic-secret (#86)', () => {
  it.each([
    'config/theme/theme.data.json', 'src/core/reconcile/apply.ts', 'docs/getting-started/install-guide.md', '.github/workflows/release-pipeline.yml',
    'packages/web-client/src/components/UserProfileCard.tsx', 'tests/unit/reconcile/secrets-review.test.ts', 'config/default_settings.toml',
  ])('%s', (path) => {
    expect(found(`tokens: ${path}`)).toBe(false);
    expect(found(`### 1. Font tokens: \`${path}\``)).toBe(false);
  });

  it('random values shaped <random>/<random>.json are still reported (ceiling 2 of 200)', () => {
    let misses = 0;
    for (let i = 0; i < 200; i++) if (!found(`tokens: ${draw(12 + (i % 12))}/${draw(10 + (i % 9))}.json`)) misses++;
    expect(misses).toBeLessThanOrEqual(2);
  });
});
