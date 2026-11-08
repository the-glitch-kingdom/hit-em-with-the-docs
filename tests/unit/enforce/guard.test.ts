/**
 * Lifecycle enforcement guard (2.8.0).
 *
 * This is the only part of hewtd that can DENY a tool call, so the tests care
 * as much about what it lets through as about what it stops. A guard that
 * over-fires gets disabled, and a disabled guard enforces nothing.
 */

import { describe, it, expect } from 'vitest';
import { evaluate, DEFAULT_ENFORCEMENT } from '../../../src/core/enforce/guard.js';

const docs_dir = '.documentation';
const ev = (input: Parameters<typeof evaluate>[0], policy = DEFAULT_ENFORCEMENT) =>
  evaluate({ docsDir: docs_dir, ...input }, policy);

describe('guard — only denies indexes hewtd actually generates', () => {
  // hewtd writes `<docs>/INDEX.md` and `<docs>/<domain>/INDEX.md` and nothing else
  // (core/maintain/orchestrator.ts joins docsPath with a single domain segment).
  // Denying by basename alone froze every hand-written sub-feature index: the deny is
  // final, and the "run `hewtd index`" advice it offered does nothing to those files.

  it('denies the root and domain-level indexes', () => {
    for (const f of [
      '.documentation/INDEX.md',
      '.documentation/REGISTRY.md',
      '.documentation/api/INDEX.md',
      '.documentation/knowledge-base/REGISTRY.md',
    ]) {
      expect(ev({ toolName: 'Edit', filePath: f }).action).toBe('deny');
    }
  });

  it('allows a hand-written index below domain level', () => {
    // These are prose that merely share the name. hewtd has never written one:
    // `hewtd index` leaves them byte-identical.
    for (const f of [
      '.documentation/features/tiers/INDEX.md',
      '.documentation/knowledge-base/symptoms/INDEX.md',
      '.documentation/standards/testing/INDEX.md',
      '.documentation/agents/diane/INDEX.md',
    ]) {
      expect(ev({ toolName: 'Edit', filePath: f }).action).toBe('allow');
    }
  });

  it('uses the supplied domain list, so a slash-containing custom domain still denies', () => {
    const file_path = '.documentation/features/tiers/INDEX.md';
    // Default (no list): one segment below the root is generated, deeper is not.
    expect(ev({ toolName: 'Edit', filePath: file_path }).action).toBe('allow');
    // Declared as a domain by this project => hewtd does generate it => deny.
    expect(
      evaluate({ docsDir: docs_dir, toolName: 'Edit', filePath: file_path, domains: ['features/tiers'] }).action
    ).toBe('deny');
  });

  it('applies to absolute paths too', () => {
    expect(
      ev({ toolName: 'Edit', filePath: '/home/u/proj/.documentation/api/INDEX.md' }).action
    ).toBe('deny');
    expect(
      ev({ toolName: 'Edit', filePath: '/home/u/proj/.documentation/features/tiers/INDEX.md' })
        .action
    ).toBe('allow');
  });
});

describe('guard — denies the destructive cases', () => {
  it('denies editing a generated INDEX.md', () => {
    const d = ev({ toolName: 'Edit', filePath: '.documentation/api/INDEX.md' });
    expect(d.action).toBe('deny');
    expect(d.action === 'deny' && d.reason).toMatch(/generated artifact/i);
    expect(d.action === 'deny' && d.reason).toMatch(/hewtd index/);
  });

  it('denies writing a generated REGISTRY.md, at the root and at domain level', () => {
    expect(ev({ toolName: 'Write', filePath: '.documentation/REGISTRY.md' }).action).toBe('deny');
    expect(ev({ toolName: 'Write', filePath: '.documentation/standards/REGISTRY.md' }).action).toBe(
      'deny'
    );
  });

  it('denies rm of a doc under the docs tree, and names the archive alternative', () => {
    const d = ev({ toolName: 'Bash', command: 'rm .documentation/api/old-guide.md' });
    expect(d.action).toBe('deny');
    expect(d.action === 'deny' && d.reason).toMatch(/hewtd archive/);
    expect(d.action === 'deny' && d.reason).toMatch(/unarchive/);
  });

  it('denies the other ways to destroy a file', () => {
    for (const cmd of [
      'git rm .documentation/api/x.md',
      'rm -f .documentation/api/x.md',
      'rm -rf .documentation/api/x.md',
      'shred .documentation/api/x.md',
      'cd /tmp && rm .documentation/api/x.md',
      'echo hi; rm .documentation/api/x.md',
      'true && rm .documentation/api/x.md',
    ]) {
      expect(ev({ toolName: 'Bash', command: cmd }).action, cmd).toBe('deny');
    }
  });
});

describe('guard — warns without blocking', () => {
  it('warns when a doc is marked deprecated but not archived', () => {
    const d = ev({
      toolName: 'Edit',
      filePath: '.documentation/api/old.md',
      text: 'status: deprecated',
    });
    expect(d.action).toBe('warn');
    expect(d.action === 'warn' && d.context).toMatch(/hewtd archive/);
  });

  it('warns when a rival docs/ tree is started', () => {
    const d = ev({ toolName: 'Write', filePath: 'docs/my-notes.md' });
    expect(d.action).toBe('warn');
    expect(d.action === 'warn' && d.context).toMatch(/hewtd integrate/);

    // …and on a loose doc dropped at the repo root.
    expect(ev({ toolName: 'Write', filePath: 'architecture-notes.md' }).action).toBe('warn');
  });

  it('warns on a hand-rolled mv into archive/ (it loses archived_from)', () => {
    const d = ev({
      toolName: 'Bash',
      command: 'mv .documentation/api/old.md .documentation/archive/api/old.md',
    });
    expect(d.action).toBe('warn');
    expect(d.action === 'warn' && d.context).toMatch(/archived_from/);
  });
});

describe('guard — reminds about gotchas when a PR is opened or merged', () => {
  it('warns on gh pr create and gh pr merge', () => {
    for (const command of [
      'gh pr create --title "x" --body "y"',
      'gh pr merge 41 --squash',
      'git push -u origin feat/x && gh pr create --fill',
      'GH_TOKEN=abc gh pr merge --auto',
    ]) {
      const d = ev({ toolName: 'Bash', command });
      expect(d.action).toBe('warn');
      if (d.action === 'warn') expect(d.context).toContain('gotcha');
    }
  });

  it('stays silent on other gh pr commands and on prose that mentions them', () => {
    for (const command of [
      'gh pr view 41',
      'gh pr list',
      'echo gh-pr-create',
      "git commit -F - <<'MSG'\nfeat: warn on\ngh pr merge\nMSG",
    ]) {
      expect(ev({ toolName: 'Bash', command }).action).toBe('allow');
    }
  });
});

describe('guard — archived content is referenceable, never concrete', () => {
  it('warns when editing an archived doc, at any depth', () => {
    for (const f of [
      '.documentation/archive/api/old.md',
      '.documentation/features/archive/retired.md',
    ]) {
      const d = ev({ toolName: 'Edit', filePath: f });
      expect(d.action, f).toBe('warn');
      expect(d.action === 'warn' && d.context).toMatch(/historical/i);
      expect(d.action === 'warn' && d.context).toMatch(/unarchive/);
    }
  });

  it('warns rather than denies — editing history is pointless, not destructive', () => {
    const d = ev({ toolName: 'Write', filePath: '.documentation/archive/api/old.md' });
    expect(d.action).not.toBe('deny');
  });

  it('still denies DELETING an archived doc', () => {
    // Archived ≠ disposable. The archive is the thing that makes retirement
    // reversible; deleting out of it throws away the history it exists to hold.
    const d = ev({ toolName: 'Bash', command: 'rm .documentation/archive/api/old.md' });
    expect(d.action).toBe('deny');
  });

  it("does not claim an archive/ folder outside the docs tree", () => {
    expect(ev({ toolName: 'Write', filePath: 'src/archive/notes.md' }).action).toBe('allow');
  });
});

describe('guard — does not over-fire', () => {
  it('allows editing an ordinary document', () => {
    expect(ev({ toolName: 'Edit', filePath: '.documentation/api/guide.md' }).action).toBe('allow');
  });

  it('allows an INDEX.md that has nothing to do with the docs tree', () => {
    // Someone else's INDEX.md is not hewtd's business.
    expect(ev({ toolName: 'Write', filePath: 'src/INDEX.md' }).action).toBe('allow');
  });

  it('stays silent on markdown that is plainly not documentation', () => {
    // The warn is narrow on purpose: a noisy guard is a disabled guard.
    for (const f of [
      'src/components/Button.md',
      'tests/fixtures/sample.md',
      'packages/ui/README.md',
      'templates/thing.template.md',
    ]) {
      expect(ev({ toolName: 'Write', filePath: f }).action, f).toBe('allow');
    }
  });

  it('does not nag about a project README, CHANGELOG, or planning file', () => {
    for (const f of [
      'README.md',
      'CHANGELOG.md',
      'CONTRIBUTING.md',
      'CLAUDE.md',
      'AGENTS.md',
      '.planning/some-phase/phase.md',
      '.claude/notes.md',
      'node_modules/foo/README.md',
    ]) {
      expect(ev({ toolName: 'Write', filePath: f }).action, f).toBe('allow');
    }
  });

  it('allows rm of files that are not docs', () => {
    for (const cmd of [
      'rm src/index.ts',
      'rm -rf dist',
      'rm /tmp/scratch.md',
      'npm run build',
    ]) {
      expect(ev({ toolName: 'Bash', command: cmd }).action, cmd).toBe('allow');
    }
  });

  it("allows hewtd's own commands, including archive", () => {
    for (const cmd of [
      'hewtd archive .documentation/api/old.md',
      'npx hit-em-with-the-docs index',
      'hewtd maintain --fix',
    ]) {
      expect(ev({ toolName: 'Bash', command: cmd }).action, cmd).toBe('allow');
    }
  });

  it('ignores tools it has no opinion about', () => {
    expect(ev({ toolName: 'Read', filePath: '.documentation/api/INDEX.md' }).action).toBe('allow');
    expect(ev({ toolName: 'Grep', filePath: '.documentation/api/INDEX.md' }).action).toBe('allow');
  });
});

describe('guard — the escape hatch', () => {
  it('respects block_index_edits: false', () => {
    const d = ev(
      { toolName: 'Edit', filePath: '.documentation/api/INDEX.md' },
      { blockIndexEdits: false, blockDocDeletion: true }
    );
    expect(d.action).toBe('allow');
  });

  it('respects block_doc_deletion: false', () => {
    const d = ev(
      { toolName: 'Bash', command: 'rm .documentation/api/old.md' },
      { blockIndexEdits: true, blockDocDeletion: false }
    );
    expect(d.action).toBe('allow');
  });

  it('disabling one rule does not disable the other', () => {
    const policy = { blockIndexEdits: false, blockDocDeletion: true };
    expect(ev({ toolName: 'Bash', command: 'rm .documentation/a.md' }, policy).action).toBe('deny');
  });
});

describe('guard — deletion is matched structurally, not textually (#21, #26)', () => {
  // The old rule asked two independent questions of the whole command string:
  // "is `rm` present anywhere" and "is a docs path present anywhere". Neither
  // asked whether the path was an OPERAND of the deletion, or whether the text
  // sat in a heredoc body the shell never executes. Same shape as #19: matching
  // a substring where the structure was the thing that mattered.

  const bash = (command: string) => ev({ toolName: 'Bash', command }).action;

  describe('heredoc bodies are data, not commands', () => {
    it('allows an issue comment whose body quotes a deletion (#21)', () => {
      // The sentence being blocked was documentation of this guard's own behavior.
      const command = [
        `gh issue comment 1141 --body "$(cat <<'EOF'`,
        'Untracking these means a cached-remove, which trips the same guard.',
        'e.g. `rm .documentation/api/endpoints.md` — see .documentation/INDEX.md',
        'EOF',
        ')"',
      ].join('\n');
      expect(bash(command)).toBe('allow');
    });

    it('allows a commit message that names a deletion in prose (#26 case 2)', () => {
      const command = [
        `git commit -F - <<'MSG'`,
        'docs: untrack generated reports',
        'rm .documentation/api/endpoints.md was the old way',
        'MSG',
      ].join('\n');
      expect(bash(command)).toBe('allow');
    });

    it('handles an unquoted heredoc tag and a <<- indented terminator', () => {
      const command = ['cat <<-EOF', 'rm .documentation/api/endpoints.md', '\tEOF'].join('\n');
      expect(bash(command)).toBe('allow');
    });

    it('still denies a real deletion AFTER a heredoc block closes', () => {
      const command = [
        `git commit -F - <<'MSG'`,
        'some prose',
        'MSG',
        'rm .documentation/api/endpoints.md',
      ].join('\n');
      expect(bash(command)).toBe('deny');
    });
  });

  describe('the docs path must be an operand of the deletion', () => {
    it('allows deleting something outside the tree while naming a doc', () => {
      expect(bash('rm /tmp/scratch.md && echo see .documentation/api/endpoints.md')).toBe('allow');
    });

    it('allows an unrelated existence check alongside a scratch delete (#26 case 4)', () => {
      const command =
        '[ -f .documentation/features/tiers/x.md ] && echo published; ' +
        'find .documentation/drafts -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +';
      expect(bash(command)).toBe('allow');
    });

    it('denies a deletion in any segment of a compound command', () => {
      expect(bash('cd /tmp && rm .documentation/api/endpoints.md')).toBe('deny');
    });

    it('sees past sudo and leading env assignments', () => {
      expect(bash('sudo rm .documentation/api/endpoints.md')).toBe('deny');
      expect(bash('FOO=bar rm .documentation/api/endpoints.md')).toBe('deny');
    });

    it('still denies a quoted path and flag-carrying forms', () => {
      expect(bash('rm ".documentation/api/endpoints.md"')).toBe('deny');
      expect(bash('rm -rf .documentation/api/endpoints.md')).toBe('deny');
      expect(bash('unlink .documentation/api/endpoints.md')).toBe('deny');
      expect(bash('shred .documentation/api/endpoints.md')).toBe('deny');
    });
  });

  describe('git rm --cached is an index operation, not a deletion (#26 case 1)', () => {
    it('allows --cached, which leaves every file on disk', () => {
      expect(bash('git rm --cached .documentation/api/endpoints.md')).toBe('allow');
      expect(bash('git rm -r --cached .documentation/reports/health.md')).toBe('allow');
    });

    it('still denies git rm without --cached', () => {
      expect(bash('git rm .documentation/api/endpoints.md')).toBe('deny');
      expect(bash('git rm -f .documentation/api/endpoints.md')).toBe('deny');
    });
  });

  describe('drafts/ and reports/ are not published documentation', () => {
    // The auditor already exempts exactly these from domain validation
    // (core/audit/rules.ts) — reports/ is hewtd's own generated output and
    // drafts/ is scratch. `archive` preserves neither, so refusing is pure friction.
    it('allows deleting a draft', () => {
      expect(bash('rm .documentation/drafts/wip.md')).toBe('allow');
    });

    it('allows deleting generated reports', () => {
      expect(bash('rm .documentation/reports/health-2026.md')).toBe('allow');
    });

    it('still denies deleting a published doc in a domain folder', () => {
      expect(bash('rm .documentation/api/endpoints.md')).toBe('deny');
    });
  });

  describe('unrelated commands stay untouched', () => {
    it('allows an in-place edit — the guard has no deletion to report', () => {
      // #26 case 5 reported this as blocked; it does not reproduce. `sed` is not
      // a deletion, so no deny fires and no archive advice is offered.
      expect(bash('sed -i "s/^version: 1.0.0$/version: 1.0.1/" .documentation/plans/x.md')).toBe(
        'allow'
      );
    });

    it('does not warn about an archive move merely quoted in a heredoc', () => {
      const command = [`gh issue comment 1 --body "$(cat <<'EOF'`, 'mv x archive/y', 'EOF', ')"'].join(
        '\n'
      );
      expect(bash(command)).toBe('allow');
    });

    it('still warns on a real hand-rolled move into archive/', () => {
      expect(bash('mv .documentation/api/old.md .documentation/api/archive/old.md')).toBe('warn');
    });
  });
});
