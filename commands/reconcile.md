---
description: Reconcile existing docs with the code - triage, judge each doc against what it cites, propose fixes for you to accept, apply serially
allowed-tools: Bash(npx:*), Read, Write, Agent
argument-hint: "<domain|folder|files...> | --overview \"<question>\" | --gaps <file> | --next N | --status | --outside  [--serial|--team]"
---

Arguments: $ARGUMENTS

This is the **LLM judgment pass** for `hewtd reconcile`. The CLI is deterministic and never calls a model: it triages, writes review-file skeletons, and applies what you accept. You read docs and the code they cite, and fill in the review entries. Nothing in the docs tree changes until the user accepts and you run `--apply`.

`hewtd` below means `npx --no @theglitchking/hit-em-with-the-docs`.

## 0. Secrets first

Before any triage, judgment or sharding, scan for secrets. No model may see a secret, so this runs first and the judgment pass never opens a flagged file.

```bash
hewtd reconcile --secrets <scope...> --json
```

The scan covers the docs in scope, `archive/`, the outside lane, `.hewtd/` and every file the docs cite. `--json` prints masked findings only: `rule`, `file:line`, the first 4 characters plus the length, and a sha256 fingerprint. Never a value.

If there are findings, show that masked list and stop. Offer the `secret` verdicts (move the value to `.env.hewtd` and leave a pointer in the doc), let the user accept or reject each, apply them with `--apply`, and only then continue to triage. For a false positive, point the user at `reconcile.secrets.allow` in the plugin config (a fingerprint or pattern, with a reason). For a rule that is noisy across the repo, `reconcile.secrets.disabled_rules` (a list of rule ids) turns the whole rule off; say so plainly, because it also hides every real finding of that rule, and prefer `allow` for one-off cases. If there are none, go on to step 1.

Triage repeats the scan and puts any doc with a finding, in itself or in a file it cites, into the `secret` lane. Files with findings are listed under `blocked_files` and dropped from the doc's `cited` list. Since 2.22.0 `blocked_files` also lists cited code files withheld for weak hits only (`generic-secret`, `url-password`) on docs that are not in the secret lane; those docs keep their lane, and you still never open the withheld files.

**Secret rules.** They bind the judgment pass and every team agent:

- Never open a doc in the `secret` lane, or any file in `blocked_files`.
- Never echo, quote or paraphrase a value, in chat, review files, drafts, `reason` or `sources`.
- If a value is seen anyway, stop, and report only the `file:line`.

## 0b. Quick modes

- `--status`: run `hewtd reconcile --status` (add `--next N` to list the next N unreviewed docs), show it, stop.
- `--next N` with no scope: resume from the ledger. Triage `hewtd reconcile --next N --json` and continue at step 1.
- `--overview "<question>"` ranks docs with built-in BM25; if the plugin config sets `reconcile.search_command` (an argv template with `{query}`, run without a shell), the doc paths it prints come first.
- `--outside`: docs outside the docs root (tool-read, misplaced, junk, not a doc). Run `hewtd reconcile --outside` and follow its output: it proposes integrate-and-remove for misplaced docs and deletion for junk, each applied only on acceptance. Files matching `keep_in_place` are never moved.

## 1. Triage

```bash
hewtd reconcile <scope...> --json [--serial|--team] [--next N]
```

The scope must be committed: the CLI refuses a dirty or untracked in-scope file. Tell the user to commit or stash and stop if it does.

Show the user: docs per lane (`clean`, `fields-only`, `check`, `archive-candidate`), the work estimate (judgment docs and bytes), the `mode` and shard count, and any `warnings` (for example a shallow clone, where staleness is unknown, or a `reconcile.schema_sources` pattern that matches no git-tracked file: those tables and columns stay `unknown`; schema files may be `.sql`, `.prisma` or SQLAlchemy/Django `.py` models). Honour `--serial` / `--team` from the arguments; otherwise follow the plan's `mode`. Table and column refs are `unknown` (not checked, never `missing`) until the plugin config lists `reconcile.schema_sources`, a list of globs such as `["**/migrations/**/*.sql", "**/schema.prisma"]`; triage prints the schema files it found (`schema files:`), so offer to set it from that list when the docs cite tables.

Then write the skeletons:

```bash
hewtd reconcile <same scope and flags> --write-review
```

It prints one review file per shard under `.hewtd/reconcile/review-<batch>-<shard>.md` and never overwrites an existing file. In serial mode there is one file; archive candidates go in shard 1. Secret-lane docs get their own `review-<batch>-secrets.md`: handle it in step 0 yourself and never hand it to an agent.

## 2. Judgment

Each review file has, per doc, a heading `## <docs-relative path>`, a `- [ ] accept` line, and a ```json block holding a ReviewEntry. For every entry fill:

- `verdict`: `verify` (doc matches the code; stamps `last_verified`), `rewrite` (needs a larger rewrite; put the full proposed body in `draft`; apply replaces the doc's body with it, keeps the doc's frontmatter and merges `frontmatter` and `sources` like an edit, and reports in `detail` any heading anchor other docs link to or any cited path that the draft drops; once applied the doc counts as reviewed until it is edited), `archive` (obsolete; put the why in `reason`), `merge`, `point` and `overview` (step 3), `unverifiable` (cannot be checked from the repo; sets `confidence: low`), or `fields` (frontmatter only). A `fields` (or `phrases`) entry on a doc whose earlier review still holds (the doc did not change since it) keeps that review: the ledger verdict and `reviewed_on` stay, `fields_on` records the touch, and `--status` counts it as "reviewed, metadata updated since" (whatever the kept verdict is).
- `frontmatter`: keys to set, for example `purpose` and `symptoms`. Never `last_verified`; only the `verify` and `rewrite` verdicts stamp it.
- `patch`: `[{old, new}]` exact-text body edits. Each `old` must occur exactly once in the body.
- `sources`: every file you actually read to decide. Do not list files you did not open. Apply merges them into the doc's existing `sources` (existing first, no duplicates, the doc itself dropped); to remove one, list it in `sources_remove`. A source that is not in the repo is kept and reported. A file read in a related repo (`reconcile.related_repos`) is listed as `<name>:<path>`.
- `external_refs`: names or paths the doc cites that cannot be checked in this repo. Apply unions them into the doc's own `external_refs` (existing first, no duplicates) and never overwrites; it can also sit under `frontmatter`. They are then not checkable (`unknown`), never `missing`.
- `reason`: for `archive` and `unverifiable`.

Every `missing` ref in the entry needs a decision, or it stays `missing` on every later pass. Either fix the doc (a `patch` to the new name or path, or a `rewrite`), or list the ref in `external_refs` when it is not a thing in this repo: a third-party name, another product's file, a negation or history ("no longer uses `x`"), or a placeholder. `missing` itself is read-only and apply ignores it. Skeletons print `missing` and an empty `external_refs: []` on each entry (not on secret-lane, gaps, overview or outside entries). Example:

```json
{
  "path": "api/auth.md",
  "verdict": "verify",
  "missing": ["boto3", "legacy/old_login.py"],
  "external_refs": ["boto3"],
  "patch": [{"old": "legacy/old_login.py", "new": "src/auth/login.py"}],
  "sources": ["src/auth/login.py"],
  "sources_remove": ["src/auth/old.py"]
}
```

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
- The secret rules from step 0 apply to it: never open a `secret`-lane doc or a `blocked_files` file, never echo a value, and on seeing one stop and report only the `file:line`.

Shards never include `secret`-lane docs (triage enforces this); do not add one by hand.

Wait for all of them, then read every review file and sanity-check: JSON still parses, every filled entry has a verdict, `patch.old` strings are plausible. Only then continue.

## 3. Overviews and owners

One owner per fact: a fact lives in one doc, and every other doc holds a one-line summary plus a link to it. Overviews are pointer records, not copies. All writes go through a review entry and `--apply`; never use `hewtd integrate -a`, and never place a file by hand. The step 0 secret rules hold: members and owners in the `secret` lane are never opened, and no value goes into a draft or `pointer.summary`.

### 3a. Overview from a question

```bash
hewtd reconcile --overview "<question>" [--limit N] --json
```

This ranks docs across the whole docs tree, adds linked docs that also scored, writes `.hewtd/reconcile/overview-<slug>.json` (the members file, returned as `file`), and changes no doc. Each member has a `state` (`reconciled`, `unreviewed`, `stale`, `secret`) and may carry `duplicates`. A returned `existingOverview` means update or point at it instead of drafting a second one.

1. **Confirm members with the user.** Show the list with states. Drop wrong members from the members file, add missing ones, and re-run with a better question if the list is off. Do not continue until they confirm.
2. **Unreviewed or stale members first.** Run them through steps 1-2 and 6 so they are reconciled before the overview cites them. If the user would rather not, they stay in with a `(unreviewed)` mark on that member's line and `allow_unreviewed: true` on the entry. `secret` members cannot be included at all.
3. **Skeleton.** `hewtd reconcile --write-review --overview <members-file> [--batch N]` prints a review file holding one `overview` entry (`verdict: null`, empty `draft`), placed in the first member's folder as `overview-<slug>.md`. The target must not already exist.
4. **Draft** from `templates/overview.template.md`. Put the body in `draft` and the fields in `frontmatter`: `kind: overview`, a `purpose` that starts with the flow, and 2-3 real `symptoms` in the words a reader would use (taken from the question and the members' own symptoms, never invented). One pointer record per stage: a one-line summary in your words, then a link to the section that owns it (`[title](path.md#anchor)`). Check each anchor exists in the member. Never copy a section's text. Set `verdict: overview`; read every member you cite and list it in `sources`.
5. Show the draft in the report, then continue at step 5.

Apply refuses an overview whose target exists, whose member changed since the review, or which has an unreviewed member without its mark. If a member changes later, triage sends the overview back to `check`; redraft it.

### 3b. Owners: merge, then point

When a triage entry or members file carries `duplicates` (reason `copy of <owner>#<section>`), the holder carries text another doc owns. For each:

1. Read both sections. The owner is the doc triage named; on a `tie`, ask the user which owns it.
2. **Merge first.** If the copy holds a fact the owner lacks (a step, a flag, a caveat), add an entry on the owner: `verdict: merge`, `path` the owner, `section` its anchor, `patch` folding in only those facts. If the owner already has everything, skip the merge.
3. **Then point.** Add an entry on the holder: `verdict: point`, `remove: {old}` the exact duplicated text (occurs once), `pointer: {summary, target: "<owner path>#<anchor>"}` with a one-line summary, and `depends_on_merge` naming the merge entry's `id` if there is one. Without a merge, set `target_hash` to the owner's current content hash.
4. **Never remove text before the owner holds it.** Apply checks mechanically that every identifier, number, path, flag and command in the removed text appears in the owner's section or in the summary, and refuses otherwise. Expect it: if a token would be lost, fold it into the merge or the summary rather than dropping it. The detected overlap can be part of a section, so run this check yourself on the full `remove` text before proposing.
5. The holder's text is replaced by `<summary> Details: [<owner title>: <heading>](<path>#<anchor>)`. If the owner section later changes, the pointer goes stale and the holder is re-queued.

In an overview, propose merge-then-point for members marked `duplicates` alongside the overview entry, so the overview links the owner's section.

### 3c. Related repos

If the owner is in a sibling repo (`reconcile.related_repos`), the holder keeps a short summary and a cross-link to that repo's doc, as a `point` entry whose `target` is the path inside that repo plus `#anchor`. Read the owner to check the anchor and the no-loss expectations, and list it in `sources` as `<name>:<path>`. Never copy, move or edit anything in the sibling repo; there is no merge into it, so the details must already be there.

## 3b. Staged run and rotation (3.2.0)

To reconcile without touching the live docs, work on a copy: `hewtd reconcile --stage .hewtd/<name>`, then run every mode with `--staged .hewtd/<name>` (triage, `--write-review`, `--apply`, `--secrets`). Apply on a stage makes no commit and reports `secret` and outside-lane entries as `error`. When the user accepts the result, show the plan with `hewtd reconcile --promote --staged <dir>` and run it with `--confirm` only after the user agrees; it keeps the old tree as a read-only committed cold generation and allowlists the cold root in `.gitleaks.toml` / `.secrets.baseline` (3.2.1; opt out with `reconcile.cold_scanner_allowlist: false`). Read the plan's warnings about flagged and unreviewed docs to the user first. Never promote or undo on your own. If the user wants it rolled back: `hewtd reconcile --undo <generation> --confirm`. Cold generations are history: never judge, cite or open files under `reconcile.cold_root`. Credentials listed in a generation's `secrets_findings` stay in git history, so tell the user to rotate them. See `docs/cold-rotation.md`.

## 4. Domains

If docs fit no existing domain, add a proposal to the report (name, keywords, which docs). Never create or move folders. If the user wants it, point them at `/hit-em-with-the-docs:domain`.

## 4b. Search gaps (`--gaps <file>`)

Turns queries the search missed into `symptoms.user_phrase` proposals, new-doc candidates and open questions. The file is a `gaps.v1` list. semantic-memory's `gaps --json` emits this format, and a hand-written list works too (a JSON array, or one question per line). Step 0 still runs first.

```bash
hewtd reconcile --gaps <file> --json
```

It writes only `.hewtd/reconcile/gaps-report-<date>.md` (masked) and changes no doc. Show the three outcomes, plus any `errors` (for example an unknown `used_doc`):

1. **Phrase proposals**: a query whose `used_doc` is a doc here. Queries are already normalized, near-duplicates merged, capped per doc, and secret-shaped ones dropped.
2. **New-doc candidates**: no usable doc, but the query names code. Each lists ranked `sources` and a likely domain.
3. **Open questions**: neither. Report them; nothing to propose.

`dropped` queries are shown by `reason` only. Never paste a dropped query, and never echo a value from a secret-flagged one.

**Phrases.** Write the skeleton with `hewtd reconcile --gaps <file> --write-review` (`review-<batch>-gaps.md`, one unticked `phrases` entry per doc). Let the user accept, edit or drop each phrase. Keep the reader's wording from the real query; do not rewrite it into the author's terms. Tick `accept` only on their say-so, then apply with `hewtd reconcile --apply .hewtd/reconcile/review-<batch>-gaps.md` as in step 6.

**New-doc candidates.** Never auto-created. If the user wants one, read the listed `sources` (skip any in `blocked_files`), draft a doc from what they say, and create it with `hewtd integrate <file>`, which records the sources and blocks secrets. Show the draft first.

## 5. Present and accept

Summarise all shards together: per verdict counts, then each entry with the verdict, the evidence (quote or `file:line` from `sources`), and the proposed change. Let the user accept, edit or reject each entry and each overview. Do not proceed until they have signed off. Tick `- [x] accept` only on entries they accept (edit the review file, keep the JSON valid). Unticked entries are left alone and stay unreviewed in the ledger.

## 6. Apply

```bash
hewtd reconcile --apply .hewtd/reconcile/review-<batch>-*.md
```

Apply is serial, one commit per batch, archives through the normal archive path, and regenerates the touched indexes. It reports per doc: applied, stale (the doc changed since the review was written; re-run triage for it), rejected, already-applied, skipped or error. A doc in two review files is an error. Show the outcomes.

`hewtd reconcile --status` also prints, for reviewed docs, how many refs are covered by `external_refs` and how many are still missing (read from `.hewtd/graph.json`, which `hewtd index` and `reconcile --apply` write; without one it says why: run `hewtd index`, or the export is off (`graph_export: false`), or the docs are not in a git checkout). Use it to find docs whose `missing` refs were never decided.

Then suggest `hewtd audit` and `hewtd link-check`, and `hewtd reconcile --status` to see progress; `--next N` continues with the next unreviewed docs. Two runs on an unchanged scope produce no changes.

## After creating or updating docs (`--changed`)

When you wrote or edited docs yourself (a new file, `hewtd integrate`, an edit to a reviewed doc), you are the judge. Run `hewtd reconcile --changed --write-review` (scope args are optional; dirty docs are expected, no commit first). It writes one review file with exactly the docs created or changed since their last review. For each entry check the doc against the code and set `"verdict": "verify"`, fill `sources`, decide each `missing` ref (a `patch`, or `external_refs`), put `purpose` and `symptoms` under `frontmatter`, tick accept, then `--apply`. Apply stamps `last_verified`, records the verdict and commits the batch. A second `--changed` lists none. `hewtd reconcile --changed --check [--cached]` is the advisory check the pre-commit hook and CI run: it exits 1 only when `reconcile.require_review` is true.

## When the reconcile is done (`--finish`)

After a whole-tree reconcile (and after `--promote --confirm`), run `hewtd reconcile --finish` and show the user the inventory: credentials in `.env.hewtd` (names only), stages, review files, graph files, git hygiene. Never delete `.env.hewtd` yourself, and never print a value from it. When the user says they rotated a credential, record it with `hewtd reconcile --finish --rotated <ENV_NAME>`. `--fix` redacts secret values quoted in review files and adds missing `.gitignore` lines; `--confirm` removes only rejected/abandoned stages, the graph cache and redacted review files: run either only with the user's say-so.

## What NOT to do

- Never delete `.env.hewtd`, cold generations or anything under the docs tree.
- Do not edit docs, frontmatter or folders directly. Everything goes through a review file and `--apply`.
- Do not write or set `last_verified` yourself, and do not commit.
- Do not tick `accept` without the user's say-so.
- Do not run the judgment pass on `clean` docs or `secret`-lane docs.
- Do not skip step 0, and never print a detected value.
- Do not send repo content to any service other than the Claude session you are in.
