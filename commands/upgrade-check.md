---
description: After an update, list what this repo must change (config keys, pre-commit hook, version skew, schema, instruction drift)
allowed-tools: Bash(npx:*)
---

Run `npx --no @theglitchking/hit-em-with-the-docs upgrade-check` and relay the checklist. It is read-only; it compares the repo with the installed version using the release notes in `upgrade-notes.json` (from 3.1.0), reading every release after `last_upgrade_check` in `.claude/hit-em-with-the-docs.json`.

- `--fix` applies only the safe items: relink skills, upgrade an existing hewtd hook block, add new config keys at their defaults. It records `last_upgrade_check` only once no item needs action, so the open items stay listed.
- `--record` records `last_upgrade_check` after the user has handled the remaining items; run it only when the user says so.
- `--json` prints the report for scripts and CI.

Items marked `[action]` need a human. Instruction drift lists `file:line` in `CLAUDE.md`, `AGENTS.md` and `.claude/rules/**` that name a command whose behaviour changed; never edit those files on the user's behalf without asking.
