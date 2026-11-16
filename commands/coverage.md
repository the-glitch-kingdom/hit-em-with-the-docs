---
description: Code-to-docs coverage - grade each declared surface absent, named or explained, then draft what is missing for you to accept
allowed-tools: Bash(npx:*), Read, Write
argument-hint: "[--write-review] [--json] [-p <docs path>]"
---

Arguments: $ARGUMENTS

This is the **LLM judgment pass** for `hewtd coverage`. The CLI is deterministic and never calls a model: it lists what the code declares (scheduled jobs, alert rules, HTTP routes, CLI commands and flags, CI workflows and jobs, background tasks, numeric constants, config keys), grades each against the docs, and sends the gaps through the same engine as `reconcile --gaps`. You judge the drafts. Nothing in the docs tree changes until the user accepts and you run `reconcile --apply`.

`hewtd` below means `npx --no @theglitchking/hit-em-with-the-docs`.

## 1. Read the table

```bash
hewtd coverage
```

Per surface kind and code area: `absent` (no doc names it), `named` (a doc names it but says nothing about what it does or holds), `explained` (a doc that cites its source says what it does or states its value). Named is not covered. Surfaces held by `coverage.ignore` in `.claude/hit-em-with-the-docs.json` (a path prefix or glob, or a surface `name`, each with an optional `reason`) are counted apart, never as misses. Report the table to the user in a few lines.

A kind listed under "generate the reference first" is a list the code declares (schedules, alert rules, routes, CLI flags, config keys): recommend generating or linking the reference from the code rather than writing the entries out, so it cannot go stale.

## 2. Draft

```bash
hewtd coverage --write-review --json
```

This writes `review-<batch>-coverage.md` under `.hewtd/reconcile/`: unticked entries, the same shape as `reconcile --gaps` coverage drafts. Class-level and typed collection constants are graded too (3.8.0). Follow **Facts, and what is left for you**, **Security routing** and the value rules in `/hit-em-with-the-docs:reconcile` (section on `--gaps`) exactly: every sentence cites `file:line`; never a host, IP, port, ID, URL, credential, key material, or env/config value or default (names are fine; code constants such as a size, timeout or limit are fine); a unit whose located line is a security check stays with a human.

## 3. Rules for you

- **Protect institutional knowledge.** Never propose rewriting, shortening or archiving a knowledge-base fact, incident or decision because the code does not show it. Coverage only adds what the code declares; it does not judge docs.
- **Never overwrite a doc.** A `create` entry that collides with an existing path gets a numbered sibling; do not edit an entry to point at an existing doc. Extend with a `verify` patch instead.
- **Use the shipped templates** (`templates/doc.template.md`; a knowledge-base fact uses `templates/knowledge-base/fact.template.md`) for any draft you write yourself.
- Entries with `"verdict": null` list `for_judge` items (facet and `file:line`): read the cited lines, write one sentence stating the fact, then set the verdict. If you cannot state it safely, leave it for a human.
- Declared surfaces only. Procedures, git history and runbooks are out of scope for this command.

## 4. Apply

Show the user the entries. Apply only what they accept: `hewtd reconcile --apply <review file>`. Read-only and exit 0 otherwise.
