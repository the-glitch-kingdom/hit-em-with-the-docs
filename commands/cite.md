---
description: Insert a cites: entry for a fact into a playbook's symptoms block
allowed-tools: Bash(npx:*), Read
argument-hint: "<fact-id> <playbook-path>"
---

Arguments: $ARGUMENTS

Parse `$ARGUMENTS` as `<fact-id> <playbook-path>`.

- If either is missing, ask the user for the missing one.
- Confirm the fact exists by running `npx --no @theglitchking/hit-em-with-the-docs find-citers <fact-id> --json` and checking `fact_exists`. If the fact doesn't exist, tell the user and stop.
- Read the playbook file to see its current `symptoms:` block (if any).
- If the playbook has multiple `symptoms:` entries, ask the user which one to add the citation to. Offer them by alert_name / user_phrase / error_pattern, then pass the choice to `cite` as `--alert-name <name>`, `--user-phrase <phrase>` or `--error-pattern <pattern>` (exact match on that symptom entry).
- Run `npx --no @theglitchking/hit-em-with-the-docs cite <fact-id> --file <playbook-path> [--alert-name <name> | --user-phrase <phrase> | --error-pattern <pattern>] --dry-run` first to show the proposed change. Get the user's confirmation.
- On confirmation, re-run without `--dry-run` to write the change.
- Suggest the user run `npx --no @theglitchking/hit-em-with-the-docs audit --strict` afterward to confirm the cited fact is valid.
