---
description: Manage custom documentation domains (list | add | remove) beyond the built-in 15
allowed-tools: Bash(npx:*)
argument-hint: "list | add <id> -k <keywords> | remove <id>"
---

Arguments: $ARGUMENTS

This command wraps `npx --no @theglitchking/hit-em-with-the-docs domain ...`. The plugin ships 15 built-in domains; this lets the user add/remove their own at runtime without recompiling. Dispatch on the first word of `$ARGUMENTS`:

## `list` (or empty arguments)

- Run `npx --no @theglitchking/hit-em-with-the-docs domain list` and report the built-in vs custom domains, their category, load priority, and description. Nothing to confirm — this is read-only.

## `add <id>`

Adds a custom domain: writes the entry to `.claude/hit-em-with-the-docs.json` (under `domains: []`), scaffolds `.documentation/<id>/` with INDEX.md/REGISTRY.md, and refreshes the root indexes.

- Required fields the user must supply:
  - `<id>` — kebab-case (e.g. `mobile`, `ml-pipeline`). A built-in id (e.g. `security`, `api`) is rejected.
  - `-k, --keywords <comma,separated,keywords>` — **REQUIRED**. These drive auto-classification in `integrate`. If the user did not provide keywords, **ask for them** before running.
- Optional fields (ask only if relevant): `-n, --name <name>` (defaults to a title-cased id), `-d, --description <desc>`, `-c, --category <category>` (one of `core | development | features | advanced`, default `features`), `--load-priority <n>` (1-10, default 5).
- **Preview first:** run with `--dry-run` to show the user the proposed config entry and the folder that will be scaffolded:
  ```bash
  npx --no @theglitchking/hit-em-with-the-docs domain add <id> -k "<keywords>" [-n "<name>"] [-d "<desc>"] [-c <category>] [--load-priority <n>] --dry-run
  ```
- Show the user the proposed config entry and folder path. On their confirmation, re-run the **exact same command without `--dry-run`** to apply.
- After it applies, suggest the user run `hewtd maintain` to fully refresh the indexes and pick the new domain up everywhere.

## `remove <id>` (alias `rm`) — DESTRUCTIVE INTENT, confirm before applying

Removes a custom domain from config. It is NON-DESTRUCTIVE on disk — it never deletes the folder or docs — but any docs in `.documentation/<id>/` become **orphaned** (no longer a recognized domain). Built-in domains cannot be removed.

- **Always run the dry-run first** to get the orphaned-doc count:
  ```bash
  npx --no @theglitchking/hit-em-with-the-docs domain remove <id> --dry-run
  ```
- Show the user exactly what will happen, e.g.:
  > Will remove custom domain `<id>`. N document(s) in `.documentation/<id>/` will be ORPHANED (left on disk, NOT deleted).
- **Only on EXPLICIT confirmation** from the user, re-run for real:
  ```bash
  npx --no @theglitchking/hit-em-with-the-docs domain remove <id>
  ```
- If the dry-run reports a rejection (e.g. the id is a built-in domain, or no such custom domain exists), relay the error and do not re-run.

## Notes

- If the first word is anything other than `list`, `add`, `remove`, or `rm`, tell the user the valid subcommands are `list`, `add <id>`, and `remove <id>`.
