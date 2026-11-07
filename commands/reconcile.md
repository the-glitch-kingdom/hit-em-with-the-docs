---
description: Reconcile existing docs with the code - triage, judge each doc against what it cites, propose fixes for you to accept, apply serially
allowed-tools: Bash(npx:*), Read, Write, Agent
argument-hint: "<domain|folder|files...> | --next N | --status | --outside  [--serial|--team]"
---

Arguments: $ARGUMENTS

This is the **LLM judgment pass** for `hewtd reconcile`. The CLI is deterministic and never calls a model: it triages, writes review-file skeletons, and applies what you accept. You read docs and the code they cite, and fill in the review entries. Nothing in the docs tree changes until the user accepts and you run `--apply`.

`hewtd` below means `npx --no @theglitchking/hit-em-with-the-docs`.

## 0. Quick modes

- `--status`: run `hewtd reconcile --status` (add `--next N` to list the next N unreviewed docs), show it, stop.
- `--next N` with no scope: resume from the ledger. Triage `hewtd reconcile --next N --json` and continue at step 1.
- `--outside`: docs outside the docs root (tool-read, misplaced, junk, not a doc). Run `hewtd reconcile --outside` and follow its output: it proposes integrate-and-remove for misplaced docs and deletion for junk, each applied only on acceptance. Files matching `keep_in_place` are never moved.

## 1. Triage

```bash
hewtd reconcile <scope...> --json [--serial|--team] [--next N]
```

The scope must be committed: the CLI refuses a dirty or untracked in-scope file. Tell the user to commit or stash and stop if it does.

Show the user: docs per lane (`clean`, `fields-only`, `check`, `archive-candidate`), the work estimate (judgment docs and bytes), the `mode` and shard count, and any `warnings` (for example a shallow clone, where staleness is unknown). Honour `--serial` / `--team` from the arguments; otherwise follow the plan's `mode`.

Then write the skeletons:

```bash
hewtd reconcile <same scope and flags> --write-review
```

It prints one review file per shard under `.hewtd/reconcile/review-<batch>-<shard>.md` and never overwrites an existing file. In serial mode there is one file; archive candidates go in shard 1.

## 2. Judgment

Each review file has, per doc, a heading `## <docs-relative path>`, a `- [ ] accept` line, and a ```json block holding a ReviewEntry. For every entry fill:

- `verdict`: `verify` (doc matches the code; stamps `last_verified`), `rewrite` (needs a larger rewrite; put the full proposed body in `draft`), `archive` (obsolete; put the why in `reason`), `unverifiable` (cannot be checked from the repo; sets `confidence: low`), or `fields` (frontmatter only).
- `frontmatter`: keys to set, for example `purpose` and `symptoms`. Never `last_verified`; only the `verify` verdict stamps it.
- `patch`: `[{old, new}]` exact-text body edits. Each `old` must occur exactly once in the body.
- `sources`: every file you actually read to decide. Do not list files you did not open. A file read in a related repo (`reconcile.related_repos`) is listed as `<name>:<path>`.
- `reason`: for `archive` and `unverifiable`.

Rules: draft metadata from the doc's own text and the code it cites only. Do not invent symptoms or purposes. If a claim cannot be checked, say `unverifiable`; do not guess. Do not touch `content_hash`, `path`, `lane` or `reasons`. Leave `verdict: null` for a doc you did not get to. Use the `missing` references and `reasons` in the entry as the starting evidence. Do not edit anything under the docs tree.

Related repos: each project keeps its docs in its own `.documentation`. When a triage entry says `details owned by <name>: summarize and cross-link`, or the doc duplicates details a related repo owns, propose a `patch` that keeps a short summary and adds a link to the owning repo's doc (read that repo's `.documentation` to pick the target). Related repos are read-only: never propose integrating, moving or copying a sibling doc, and never edit anything outside this project.

Leave `- [ ] accept` unticked. The user ticks it, or you tick it after they say yes.

### Serial mode

One review file. Go through the docs in order (`fields-only` and `check` lanes): read the doc, read the code it cites, write its entry. Save the file as you go so a stopped run resumes cleanly.

### Team mode

Spawn one subagent per shard, all in parallel in a single turn (Agent tool), from the triage JSON `shards` list. Each subagent gets: its shard's doc list, its review file path (from the `--write-review` output), the entry format and rules above, and these hard rules:

- It writes ONLY its own review file. It never edits the docs tree, any other review file, or the ledger.
- It records every file it read in that entry's `sources`.
- It does not run `hewtd reconcile --apply`.

Wait for all of them, then read every review file and sanity-check: JSON still parses, every filled entry has a verdict, `patch.old` strings are plausible. Only then continue.

## 3. Overviews

Clusters of 5+ linked docs with no `kind: overview` doc show up as `OVERVIEW_MISSING` warnings in `hewtd audit`. For clusters in scope, draft one overview per cluster:

1. Read the cluster's docs.
2. Copy `templates/overview.template.md`, fill every placeholder: `kind: overview`, a `purpose` that starts with the flow, 2-3 real `symptoms` (broad questions), and one link per member doc, in flow order, linking rather than copying content.
3. Write the draft to `.hewtd/reconcile/overviews/<slug>.md`, outside the docs tree, and show it in the report.

On acceptance create it with `hewtd integrate .hewtd/reconcile/overviews/<slug>.md -a` (never place it by hand); on rejection delete the draft file.

## 4. Domains

If docs fit no existing domain, add a proposal to the report (name, keywords, which docs). Never create or move folders. If the user wants it, point them at `/hit-em-with-the-docs:domain`.

## 5. Present and accept

Summarise all shards together: per verdict counts, then each entry with the verdict, the evidence (quote or `file:line` from `sources`), and the proposed change. Let the user accept, edit or reject each entry and each overview. Do not proceed until they have signed off. Tick `- [x] accept` only on entries they accept (edit the review file, keep the JSON valid). Unticked entries are left alone and stay unreviewed in the ledger.

## 6. Apply

```bash
hewtd reconcile --apply .hewtd/reconcile/review-<batch>-*.md
```

Apply is serial, one commit per batch, archives through the normal archive path, and regenerates the touched indexes. It reports per doc: applied, stale (the doc changed since the review was written; re-run triage for it), rejected, already-applied, skipped or error. A doc in two review files is an error. Show the outcomes.

Then suggest `hewtd audit` and `hewtd link-check`, and `hewtd reconcile --status` to see progress; `--next N` continues with the next unreviewed docs. Two runs on an unchanged scope produce no changes.

## What NOT to do

- Do not edit docs, frontmatter or folders directly. Everything goes through a review file and `--apply`.
- Do not write or set `last_verified` yourself, and do not commit.
- Do not tick `accept` without the user's say-so.
- Do not run the judgment pass on `clean` docs.
- Do not send repo content to any service other than the Claude session you are in.
