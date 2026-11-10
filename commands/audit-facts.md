---
description: Audit knowledge-base facts for staleness; optionally re-verify a specific fact
allowed-tools: Bash(npx:*)
argument-hint: "[fact-id-to-verify | all]"
---

Arguments: $ARGUMENTS

If `$ARGUMENTS` is empty:
- Run `npx --no @theglitchking/hit-em-with-the-docs audit-facts --json` and parse the result. A fact is stale once its `last_verified` is older than `vault.audit_window_days` in the plugin config (default 90); `--window <days>` overrides it for one run. Facts are matched to playbooks through `vault.playbook_paths` (globs, default `.documentation/**/*.md`).
- Report to the user: list of stale facts (with how many days overdue) and any unverifiable facts (malformed `last_verified`).
- For each stale fact, suggest one of three actions:
  1. Re-verify it: `/hit-em-with-the-docs:audit-facts <fact-id>`
  2. Mark it weakened (if the user knows it's no longer reliable): edit the fact's frontmatter `status: weakened`
  3. Open an incident to investigate the divergence (use `/hit-em-with-the-docs:migrate-incident` or create a new incident folder)

If `$ARGUMENTS` is `all`:
- Run `npx --no @theglitchking/hit-em-with-the-docs audit-facts --run-verify-all --json` and parse the result (an array of per-fact results; only facts with a `verify_command` are run).
- Report how many passed and list each failure with its exit code, stdout and stderr, then offer the same three choices as for a single failed fact below.

If `$ARGUMENTS` is a fact id:
- Run `npx --no @theglitchking/hit-em-with-the-docs audit-facts --run-verify "$ARGUMENTS" --json` and parse the result.
- If `updated` is `true`, confirm the new `last_verified` date to the user.
- If the verify command failed (`exit_code != 0`), show the stdout and stderr, then ask the user how to proceed:
  - Re-run the verify command after fixing the issue
  - Mark the fact weakened
  - Open an incident to track the divergence

Wait for the user's decision before taking any further action.
