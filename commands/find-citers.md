---
description: Show all playbooks and incidents that cite a given fact id
allowed-tools: Bash(npx:*)
argument-hint: "<fact-id>"
---

Arguments: $ARGUMENTS

- If `$ARGUMENTS` is empty, ask the user which fact id to look up.
- Playbooks are found through `vault.playbook_paths` in the plugin config (globs, default `.documentation/**/*.md`); if a known playbook is missing from the result, check that setting.
- Otherwise, run `npx --no @theglitchking/hit-em-with-the-docs find-citers "$ARGUMENTS" --json` and parse the JSON output.

Present the result to the user in a readable format:
- If `fact_exists` is `false`, tell the user the fact id wasn't found and suggest running `/hit-em-with-the-docs:audit-facts` to see all known facts.
- Otherwise, list the citers (playbook paths), incidents that produced it, and incidents that strengthened/weakened it.

If any of the playbook paths look suspicious or out of place, flag them for the user.
