import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { scan_text, compute_entropy } from '../../../src/core/reconcile/secrets';

// Secret-shaped strings are built at runtime from a seeded generator so the repo never holds a scannable literal.
const make_draw = (seed: number, alphabet: string) => (n: number) => { let out = ''; for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out += alphabet[(seed >> 8) % alphabet.length]; } return out; };
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const REAL = ['config/theme/theme.data.json', 'src/core/reconcile/apply.ts', 'docs/getting-started/install-guide.md', '.github/workflows/release-pipeline.yml',
  'packages/web-client/src/components/UserProfileCard.tsx', 'apps/frontend/.lttf/baseline-assets.json', 'app/tests/fixtures/cloudfront.log'];
let root: string;
// The repo root travels on the secrets config (load_plugin_config sets it); a path is exempt only when that file exists there.
const config = () => Object.defineProperty({ allow: [], disabled_rules: [] }, 'root', { value: root, enumerable: false }) as Parameters<typeof scan_text>[2];
const found = (text: string) => scan_text(text, 'doc.md', config()).some((finding) => finding.rule === 'generic-secret');

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'repo-path-86-'));
  for (const path of REAL) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), 'x'); }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('repo-relative paths are not generic-secret (#86)', () => {
  it.each(REAL)('%s, a file in the repo', (path) => {
    expect(found(`tokens: ${path}`)).toBe(false);
    expect(found(`### 1. Font tokens: \`${path}\``)).toBe(false);
  });

  it('a path-shaped value that is not a file in the repo is still reported (review: letters-only parts passed the word test)', () => {
    for (const [seed, alphabet] of [[86, LOWER + LOWER.toUpperCase() + '0123456789'], [87, LOWER], [88, LOWER.toUpperCase()]] as const) {
      const draw = make_draw(seed, alphabet);
      const values: string[] = [];
      while (values.length < 200) { const value = `${draw(10 + (values.length % 6))}/${draw(10 + (values.length % 9))}.json`; if (compute_entropy(value) >= 3.5 && !/x{3}/i.test(value)) values.push(value); } // xxx reads as a placeholder (is_placeholder), on main too
      expect(values.filter((value) => !found(`tokens: ${value}`))).toEqual([]);
    }
  });

  it('without a repo root nothing path-shaped is exempt', () => {
    expect(scan_text('tokens: config/theme/theme.data.json', 'doc.md', { allow: [], disabled_rules: [] } as Parameters<typeof scan_text>[2]).some((finding) => finding.rule === 'generic-secret')).toBe(true);
  });
});
