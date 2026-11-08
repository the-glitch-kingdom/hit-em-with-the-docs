import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Generated output must exist BEFORE anything validates it.
 *
 * The knowledge-base index generation used to run at "Step 3.5", AFTER the Step 2 link
 * check, so the checker read the PREVIOUS run's `symptoms/INDEX.md`. Consequences observed
 * on a real 644-file tree:
 *
 *   - two consecutive `maintain` runs on identical inputs reported different broken-link
 *     counts (24, then 5);
 *   - a fix to the symptoms generator appeared not to work until maintain was run twice.
 *
 * This is a source-order assertion rather than a behavioural one on purpose: mocking the
 * whole orchestrator to observe call order costs more than it proves, and the property that
 * matters — "generate, then check" — is visible in the file and is what regressed.
 */
describe('maintain step order', () => {
  const src = readFileSync(
    resolve(__dirname, '../../../src/core/maintain/orchestrator.ts'),
    'utf-8'
  );

  it('generates knowledge-base indexes before the link check', () => {
    const generate = src.indexOf('maybe_generate_kb_indexes(');
    const check = src.indexOf('await check_links(');

    expect(generate).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(-1);
    expect(generate).toBeLessThan(check);
  });

  it('regenerates domain indexes before the link check too', () => {
    // Same property, one layer up: INDEX.md/REGISTRY.md are also derived artifacts.
    const regenerate = src.indexOf('regenerate_indexes(');
    const check = src.indexOf('await check_links(');

    expect(regenerate).toBeGreaterThan(-1);
    expect(regenerate).toBeLessThan(check);
  });
});
