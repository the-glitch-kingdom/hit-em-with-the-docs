# upgrade-check (3.3.0, #104)

`hewtd update` (from the plugin runtime) installs a new version but cannot know what your repo must
change for it. `hewtd upgrade-check` answers that: it reads the release notes for every release you
have not yet checked and compares them with this repo.

```bash
hewtd upgrade-check            # read-only checklist
hewtd upgrade-check --fix      # apply only the safe items
hewtd upgrade-check --json     # the report as JSON, for scripts and CI
```

`/hit-em-with-the-docs:update` runs it after the update, and `/hit-em-with-the-docs:status` suggests it
when the installed version differs from the latest or from `last_upgrade_check`.

## What it checks

Each item prints `[ok]`, `[info]` or `[action]` (needs a human). `(--fix)` marks the ones `--fix` can do.

| Check | Reports |
|---|---|
| Version skew | hewtd copies that differ from the installed version: plugin cache, global CLI, npx cache, `node_modules` |
| Config keys | keys new since your last check that are not set in `.claude/hit-em-with-the-docs.json`, with defaults; changed defaults |
| Pre-commit hook | the hewtd block missing or out of date. With a custom `core.hooksPath` the exact lines to add are printed |
| Skill symlinks | `.claude/skills/` links that are missing or do not point at the installed package |
| Doc template | a repo `doc.template.md` that differs from `templates/doc.template.md` (never overwritten) |
| Frontmatter schema | a `vault.schema.yml` that disagrees with hewtd's frontmatter contract |
| Instruction drift | `file:line` in `CLAUDE.md`, `AGENTS.md` and `.claude/rules/**` that name a command whose behaviour changed, with the release note |

Instruction drift uses the `patterns` of each `behaviour_changes` entry, so it is deliberately broad:
a line that merely mentions the command is listed.

## The notes file

`upgrade-notes.json` ships at the package root, keyed by version. It covers 3.1.0 onward; older
releases have no notes. Every release must add an entry (a unit test fails otherwise).

```json
{
  "3.2.2": {
    "summary": "one line",
    "config_keys": [{ "key": "reconcile.require_review", "default": false, "note": "..." }],
    "changed_defaults": [{ "key": "k", "from": 1, "to": 2, "note": "..." }],
    "behaviour_changes": [{ "issue": 103, "note": "what changed", "patterns": ["regex over an instruction line"] }],
    "hook_block": null,
    "template_changes": null
  }
}
```

## The recorded version

`last_upgrade_check` in `.claude/hit-em-with-the-docs.json` is the version last checked. Only releases
after it (up to the installed one) are read; when it is unset, reading starts at 3.1.0.
`--fix` writes it only when no `[action]` item is left, so the open items are listed again on the
next run instead of being hidden. Once a human has handled (or accepted) the remaining items, run
`hewtd upgrade-check --record` to record the installed version; later runs then start after it.
Neither `--fix` nor `--record` writes a config file that is not valid JSON (comments, trailing
commas): that is reported as an `[action]` item to fix by hand, and the file is left as it is.

Version skew counts only the copies in use: Claude Code keeps earlier plugin versions next to the
active one in its cache, and those are listed as `old plugin cache, unused`, not as skew. A pre-commit
hook that was never installed is `[info]` (the hook is opt-in); a custom `core.hooksPath` without the
block is `[action]` with the exact lines to add.

## What `--fix` does, and never does

`--fix` relinks skills, upgrades an existing hewtd hook block in place, and adds new config keys at
their defaults. Without `--fix` nothing is written anywhere (repo, `$HOME`, npm).

It never edits `CLAUDE.md`, `AGENTS.md`, rules, `vault.schema.yml` or a repo doc template, never
creates a hook on a custom `core.hooksPath`, and never updates the other hewtd copies.

## Testing

Tests use a temp `HOME`. `HEWTD_NPM_ROOT` overrides the global npm root (empty means none); these are test seams.
