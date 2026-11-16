import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { join, resolve } from 'path';

// The terminal --help says how to use coverage and reconcile --gaps, not just what each flag is (#120). Built CLI.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
const help = (command: string): string => execFileSync('node', [CLI, command, '--help'], { encoding: 'utf8' });

describe('--help carries the usage guide (#120)', () => {
  it('coverage --help names every step, output field and config key', () => {
    const text = help('coverage');
    for (const term of ['hewtd coverage --write-review', '/hit-em-with-the-docs:coverage', 'hewtd reconcile --apply', '"verdict": null', 'needs_human', 'security_adjacent', 'withheld_facets', 'for_judge', 'coverage.ignore', 'targets.code_coverage', 'docs/coverage.md'])
      expect(text, term).toContain(term);
  });
  it('reconcile --help names the review and the gaps flow', () => {
    const text = help('reconcile');
    for (const term of ['--write-review', '/hit-em-with-the-docs:reconcile', 'hewtd reconcile --apply', '--include-blind', 'needs_human', 'review-<batch>-gaps.md', 'review-<batch>-coverage.md', 'docs/reconcile.md', 'docs/gaps-format.md'])
      expect(text, term).toContain(term);
  });
});
