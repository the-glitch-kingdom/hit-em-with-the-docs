import { describe, it, expect } from 'vitest';
import { rmSync } from 'fs';
import { join } from 'path';
import { use_incremental_fixture } from './incremental-82-fixture';

// Issue #82 acceptance checks through the built CLI (part 3); fixture in incremental-82-fixture.ts.
const { state, put, fm, commit_all, index_ok, cold } = use_incremental_fixture();

describe('code changes are incremental (#82)', () => {
  it('a .gitignore edit that turns a missing path ref into not-checkable equals cold (#84)', () => {
    put('.documentation/backend/d1.md', fm('d1', 'Built to `out/app.js`.', 'src/c1.ts'));
    commit_all('cite out/');
    index_ok();
    put('.gitignore', '.hewtd/\n.documentation/INDEX.md\n.documentation/REGISTRY.md\nout/\n');
    commit_all('ignore out/');
    expect(index_ok()).toBe(cold());
  });

  it('a file added where a doc-relative ref points equals cold (#84)', () => {
    put('.documentation/backend/d1.md', fm('d1', 'See `../ops/runbook.md`.', 'src/c1.ts'));
    commit_all('cite ../ops');
    index_ok();
    put('.documentation/ops/runbook.md', fm('runbook', 'Steps.'));
    commit_all('add runbook');
    expect(index_ok()).toBe(cold());
  });

  it('the first file under secret/ makes secret/ refs checkable, equal to cold (#84)', () => {
    put('.documentation/backend/d1.md', fm('d1', 'Stored at `secret/app/prod.yaml`.', 'src/c1.ts'));
    commit_all('cite secret/');
    index_ok();
    put('secret/other.yaml', 'a: 1\n');
    commit_all('real secret folder');
    expect(index_ok()).toBe(cold());
  });

  it('an env var backed by a settings field, and that file changing, equals cold (#84)', () => {
    put('src/settings.py', 'class Settings(BaseSettings):\n    hot_tier_size: int = 1\n');
    put('.documentation/backend/d1.md', fm('d1', 'Set `HOT_TIER_SIZE`.', 'src/c1.ts'));
    commit_all('settings');
    index_ok();
    put('src/settings.py', 'hot_tier_size = 1\n');
    commit_all('not settings any more');
    expect(index_ok()).toBe(cold());
  });

  // #86: a path-shaped value is not a secret only while that file exists, so deleting it must re-scan the doc
  it('deleting a file a doc names under a secret-like key equals cold (#86)', () => {
    put('config/theme/theme.data.json', '{}\n');
    put('.documentation/backend/d1.md', fm('d1', 'Font tokens: config/theme/theme.data.json', 'src/c1.ts'));
    commit_all('cite theme file');
    index_ok();
    rmSync(join(state.root, 'config/theme/theme.data.json'));
    commit_all('delete theme file');
    expect(index_ok()).toBe(cold());
  });
});
