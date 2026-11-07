# Reconcile: check existing docs against the code (2.15.0, updated in 2.18.0)

`hewtd reconcile` and `/hit-em-with-the-docs:reconcile` bring an existing docs
tree back in line with the code, in bounded, resumable batches.

- The CLI is deterministic and never calls a model. It triages, writes review
  files and applies what you accepted.
- The judgment (does this doc still match the code it cites?) lives only in the
  slash command (`commands/reconcile.md`).
- Triage and `--write-review` change nothing in the docs tree. `--apply` is the
  only writer.

## Scope

A scope is required. Forms: a domain (`security`), a folder, or doc files
(`security/auth.md`). `--next N` takes the next N unreviewed docs from the
ledger (a doc triage found `clean` counts as reviewed until its content changes). With no scope and no `--next` the command refuses. It also refuses if
any in-scope `.md` file has uncommitted changes (untracked files count).

```bash
hewtd reconcile security --json            # triage a domain
hewtd reconcile --next 20 --json           # resume from the ledger
hewtd reconcile security --write-review    # write review-file skeletons
hewtd reconcile --apply .hewtd/reconcile/review-1-1.md
hewtd reconcile --status [--next 10]       # ledger progress
hewtd reconcile --outside [--write-review] # docs outside the docs root
hewtd reconcile --secrets [scope] [--json] # masked secret scan (2.17.0)
hewtd reconcile --overview "<question>" [--limit N] [--json]  # seed an overview (2.18.0)
hewtd reconcile --write-review --overview <members-file>      # overview review skeleton
```

Flags: `-p/--docs-path`, `--json`, `--serial`, `--team`, `--batch <id>`.

## Lanes

Triage sorts each doc by deterministic checks of what the body cites (paths,
symbols, env vars, `npm`/`npx`/`make` commands, tables and columns, internal
doc links), resolved against `git ls-files`, one batched `git grep`,
`package.json`, the Makefile and parsed schema sources.

| Lane | Meaning |
|---|---|
| `clean` | Already carries `sources` and `last_verified`, nothing missing (a `sources` path that no longer exists counts as missing). |
| `fields-only` | Only frontmatter fields are missing. |
| `check` | Needs the judgment pass. |
| `secret` | The doc, or a file it cites, holds a secret. Blocked: never judged, in no shard (2.17.0). |
| `archive-candidate` | Cited things are missing. Only `missing` counts; `unknown` is neutral. |

Staleness (commits touching the cited paths since the doc's last body change)
raises priority only. The body-change point is the oldest of the consecutive
latest commits whose body (frontmatter stripped) equals the current body, so
frontmatter-only commits, such as a `last_verified` stamp, do not reset it
(walk capped at 50 commits). In a shallow clone it is `unknown` and triage warns. It is never
used to write `last_verified`.

## Secrets first (2.17.0)

Reconcile looks for secrets before it judges anything, so no model ever sees one.

```bash
hewtd reconcile --secrets [scope] [--json]
```

- **What is detected**: private-key blocks, Anthropic/OpenAI/AWS/Stripe/GitHub/
  Slack/Google/Vault keys and tokens, Azure connection strings, JWTs,
  `user:password@` URLs and generic `secret = "..."` assignments. Emails are
  `personal` kind: reported for review, never blocking.
- **Scope**: with a scope, only those docs. With none, the docs root, `archive/`,
  tracked `*.md` outside the docs root and all of `.hewtd/`. Archive, outside and
  `.hewtd/` hits are reported, never judged.
- **Output is masked**: `rule file:line first4...length` plus a fingerprint
  prefix, e.g. `vault-token docs/ops.md:12 hvs....28`. `--json` prints masked
  findings only. A value is never printed, logged or passed through argv or temp files.
- **Placeholders** such as `XXXX`, `<token>`, `${VAR}`, `changeme` and
  `example` are ignored.
- **Allowlist**: `reconcile.secrets.allow` is a list of
  `{ "fingerprint" | "pattern", "file"?, "reason" }`. `reason` is required;
  `file` is an exact path or glob. `reconcile.secrets.disabled_rules` turns
  rules off by id. Invalid entries are dropped with a warning.
- **The `secret` lane**: a doc with its own secret, or one citing a file with
  one, goes in this lane with masked reasons. It is in no judgment shard (team
  mode too). The flagged cited file is listed in `blocked_files` and dropped
  from `cited`.
- **The `secret` verdict**: `--write-review` proposes it with a masked entry per
  finding. On accept, `--apply` appends each value to `.env.hewtd` (mode 0600,
  git-ignored first) and replaces it with a pointer,
  `<secret: HEWTD_SECRET_NAME, see .env.hewtd>`. The name is the assignment name
  on that line, else `rule_docslug`. The ledger keeps `env_names` only. A
  failure rolls back the doc, `.env.hewtd` and `.gitignore`.
- **Report**: every `--secrets` run, and any apply that moved values, writes
  `.hewtd/reconcile/secrets-report-<date>.md` (masked; a history yes/no per
  finding; personal data in its own review-only section).
- **Next steps** (the report lists them): rotate the secret; put the new value in
  the real secret store and delete its `.env.hewtd` line; if it was ever
  committed, git history still holds it, so purge with `git filter-repo` if
  you need to; then reindex.
- **Guarantees**: every write (review files, ledger, apply entries, the staged
  diff, the report) is checked first. A hit in the staged diff rolls the whole
  batch back.

## Reference statuses

Each cited thing resolves to `ok`, `missing` or `unknown`. Only `missing`
pushes a doc toward `archive-candidate`; `unknown` is neutral.

- Scripts are collected from every tracked `package.json`, not just the root.
- `unknown` (never `missing`): a link or path that leaves the project root
  (including a leading-slash path), a host-like URL that does not resolve in the
  repo (`example.com/docs/x`), a name that no code defines but another doc also
  mentions (an external name; the citing doc's own mention does not count), and a reference into a related repo that is not checked out.
- Tables and columns are checked only against `schema_sources`. It defaults to
  `[]`, so nothing is checked until you list globs, for example
  `["**/migrations/**/*.sql", "**/schema.prisma"]`. Triage lists the schema
  files it found (`schemaFiles` in JSON, `schema files:` in text) so you can
  pick the globs.
- Cited bytes and staleness count resolved path references and `sources`
  only, not symbol hits.

## Overviews and one owner per fact (2.18.0)

Two problems this solves: a question that spans several docs has no single page
that answers it, and the same fact is copied into several docs so the copies
drift. Overviews answer the first; merge-then-point answers the second. Both go
through the same review file, `--apply`, ledger and secret guards as every other
verdict.

### Overviews from a question

```bash
hewtd reconcile --overview "how does semantic search retrieve and rank vault documents" --json
```

- Ranks docs across the whole tree with field-weighted BM25 (title, `purpose`,
  `symptoms` weigh 3; headings 2; body 1), expands by linked docs that also
  scored, and keeps at most `--limit` members (default 12). `archive/`,
  `drafts/`, `INDEX`/`REGISTRY`, generated, plan-tier and secret-lane docs are
  skipped, and `sources` is never indexed.
- Optional `reconcile.search_command` (an argv template with `{query}`, split on
  whitespace, run without a shell, 30 s timeout) puts its results first. Only
  paths that are indexed docs are kept. If it fails, reconcile warns and uses BM25.
- Each member is tagged `reconciled`, `unreviewed`, `stale` or `secret` from the
  ledger, and an existing `kind: overview` doc that already covers enough members is reported.
- The only file written is `.hewtd/reconcile/overview-<slug>.json`
  (overwritten on a re-seed of the same question). Search hits can be noise, so
  confirm the member list before going on; drop members by editing that file.
- Members that hold a copy of another member's section carry `duplicates`.

```bash
hewtd reconcile --write-review --overview .hewtd/reconcile/overview-<slug>.json
```

writes a review skeleton with an `overview` entry (`verdict: null`, empty
`draft`, the target in the first member's folder as `overview-<slug>.md`). The
judging step fills `draft` and `frontmatter`, then `--apply`.

The `overview` verdict:

- Applies only when every member is **reconciled**: verdict `verify`, or lane
  `clean`, with a matching content hash. A member that is not yet reconciled needs
  `allow_unreviewed: true` and an `(unreviewed)` mark on its link line. A
  secret-lane member is always refused.
- The target must not exist (`overview target already exists` otherwise).
- The new doc gets `kind: overview` and no `last_validated`. The ledger entry stores
  each member's hash.
- **Staleness**: when a member changes, the overview goes to the `check` lane with
  reason `member changed: <path>` and its verdict is dropped, so it stays queued
  under `--next` until re-applied.

### One owner per fact: merge, then point

A fact lives in one doc, its owner. Every other doc keeps a one-line summary and
a pointer. Reconcile finds copies, then proposes two entries:

- **Detection.** Sections are compared across the whole tree by 5-word shingle
  Jaccard (>= 0.5, sections at least `retrieval.near_duplicate_min_chars`). The
  owner is the doc whose own heading, title, `purpose` and filename best match the
  shared text, then the older first commit. On a tie, tied docs are flagged and
  the owner is not. Triage flags the holder in the `check` lane with reason
  `copy of <owner>#<section>` (plus ` (tie: a, b)`).
- **`merge`** on the owner: `{path, section, patch}` adds whatever the copy had that
  the owner lacks. Apply checks the section exists before and after.
- **`point`** on the copy: `{path, remove: {old}, pointer: {summary, target}}`
  replaces the copied text with the pointer record. `target` is `domain/owner.md#anchor`
  (docs-root-relative). `target_hash` (the owner's hash) is required unless the entry
  has `depends_on_merge` naming the merge entry's `id` (default: its path).
  Apply runs merges first, then points.

Pointer record format:

```
<one-line summary>. Details: [<owner title>: <heading>](<relative path>#<anchor>)
```

**No-loss check (mechanical).** Before a point is written, the tokens of the removed
text (numbers, paths, identifiers, code spans) must all appear in the owner section
or the summary. Otherwise the entry is refused with `missing: <tokens>`: merge the
detail into the owner first. The check never relies on the model's judgment.

**Anchors.** The anchor must exist in the owner at apply time (checked strictly,
GitHub-style slugs, `{#id}` honored, duplicates `-1`, `-2`). The general
`hewtd link-check` also reports `LINK_BROKEN_ANCHOR` warnings (advisory only).

**Staleness.** Applying a point stores a pointer record (`target` plus a hash of the
owner section) in the copy's ledger entry. If that section changes, triage sends the
copy to `check` with `pointer target changed: <target>`; if the heading was renamed
or removed, `pointer target changed: <target> (section missing)`. The verdict is
dropped until a point (or new review) is applied again; a plain `verify` does not
clear it. Pointers not written by reconcile are not tracked, and editing the pointing
doc by hand drops its record.

**Related repos.** A pointer target outside the docs tree is accepted only inside a
configured `reconcile.related_repos` path. That owner is read for the anchor and
no-loss checks and never written: the sibling-repo rule (summarize and
cross-link) is the same one-owner rule across repos.

## Related repos (2.16.0)

Projects that split code across repos keep each repo's docs in that repo.
Reconcile follows that rule: **docs stay in the owning repo. Summarize and
cross-link, never copy or move.**

`reconcile.related_repos` is `[{ "name", "path" }]`, `path` relative to the
project root, `name` matching `[\w.-]+`. Invalid entries are dropped one by one.

- Sibling repos are read-only. Reconcile never writes there; `--apply` reports
  an error for any entry that resolves outside the project root, and the
  outside lane scans only this project.
- A reference that misses locally is looked up in the siblings and resolves with
  `where: "<name>:<path>"`. Names found only in a sibling's code count too.
  `sources` may list `<name>:<path>`; links into `<sibling>/.documentation` are checked.
- A sibling's bytes and commits since the doc's last body change count toward
  the doc's size and staleness.
- If a configured sibling is not checked out, triage warns and unresolved
  references become `unknown`.
- **Ownership hint**: when at least 2 references resolve in one sibling, they
  are more than 50% of the checkable references, and the doc has no `ok` link
  into that sibling's docs, the doc moves from `clean` or `fields-only` up to
  `check` and carries `owner: <name>` ("details owned by <name>: summarize and
  cross-link"). An `archive-candidate` keeps its lane. The fix is a short
  summary plus a link to the owning doc; the hint clears once that link exists.

## Review file and apply

`--write-review` writes `<git root>/.hewtd/reconcile/review-<batch>-<shard>.md`
(secret-lane docs go to their own `review-<batch>-secrets.md`, never into a shard file)
(never overwrites). Each doc is a `## <path>` heading, a `- [ ] accept` line and
a JSON entry: `path`, `content_hash`, `verdict`, and optionally `frontmatter`,
`patch` (`{old,new}` pairs; each `old` must occur exactly once in the body),
`draft`, `sources`, `reason`.

Verdicts: `verify`, `rewrite`, `archive`, `unverifiable`, `fields`, `secret`,
`overview`, `merge`, `point` (2.18.0); outside entries use `integrate` and `delete`.

`--apply <files...>`:

- Serial, one commit per batch. Skips entries not ticked `accept` or with a
  null verdict.
- Re-checks `content_hash`; a doc that changed since triage is reported
  `stale` and left alone.
- A doc in two review files is rejected and the exit code is non-zero.
- A second run reports `already-applied` and changes nothing.
- Only `verify` stamps `last_verified` (today). `unverifiable` sets
  `confidence: low`. `fields` and `rewrite` never stamp. A `last_verified`
  inside the entry's frontmatter is ignored. `sources` are written exactly as
  listed.
- `archive` goes through `hewtd archive` machinery (creates `archive/`, link
  guard, reindex). No domain folder is created or moved.
- `rewrite` drafts are written to `.hewtd/reconcile/drafts/`, outside the tree.
  Rewrite entries alone do not produce a commit.
- Touched domains have their indexes regenerated.
- **All or nothing.** Files are staged with `git add -A -f` (so a gitignored
  `archive/` still commits). If anything fails after the first write (index
  regeneration, stage, commit) every touched file returns to its pre-apply
  state (uncommitted edits and pre-existing untracked files included), files and
  directories the batch created are removed, nothing is committed and the
  ledger is not saved. Rolled-back entries are reported as `error`
  (`rolled back: <msg>`).
- **Exit code**: 1 on any error outcome (also for rollback and for entries
  resolving outside the project root), with a summary line; 0 otherwise.
- `rewrite` is not a review: the doc stays unreviewed and stays in `--next`.
  Its draft is rewritten on a rerun.

## Ledger

`.hewtd/reconcile.json` (config `reconcile.ledger_path`, relative to the git
root of the docs path, not the current directory). One entry per doc: lane,
verdict, `reviewed_on`, `applied_commit`, `review_file`, and a content hash.
A doc counts as reviewed only while its hash is unchanged. `--status` shows
counts per lane and verdict and the next unreviewed docs.

## Team mode

Auto when judged docs (`fields-only` + `check`) reach `team.min_docs` (12) or
judged bytes reach `team.min_bytes` (250 KB). Lockfiles do not count toward
bytes. Shards: `max(ceil(docs/docs_per_agent), ceil(bytes/min_bytes))`, capped
at `team.max_agents` and the doc count; a plan that would be one shard runs
serial. `--serial` and `--team` override. Linked docs share a shard when
they fit a fair share of the job; a larger cluster is split in path order so no
agent carries most of it.
Agents only write review files; `--apply` stays serial.

Config lives in `.claude/hit-em-with-the-docs.json` under `reconcile`; every
key is optional and invalid values fall back to the defaults:

```json
{ "reconcile": {
    "keep_in_place": ["README.md", ".github/**", ".claude/**"],
    "ledger_path": ".hewtd/reconcile.json",
    "schema_sources": [],
    "related_repos": [{ "name": "api", "path": "../api" }],
    "team": { "min_docs": 12, "min_bytes": 250000, "max_agents": 4, "docs_per_agent": 8 }
} }
```

## Outside lane

`hewtd reconcile --outside` lists tracked markdown outside the docs root
(works from any subdirectory; the git root of the docs path is used):

| Class | Meaning | Proposal |
|---|---|---|
| `tool-read` | Read by tooling or scripts (README, CLAUDE.md, matches `keep_in_place`, or named by a script) | left alone |
| `junk` | Generated or scratch output | `delete` |
| `not-a-doc` | Not documentation | `delete` |
| `misplaced` | A real doc outside the tree | `integrate` (you or the slash command decide) |

Files named inside tracked config (`*.json`, `*.yaml`, `*.yml`, `*.toml`) are
classed `not-a-doc` ("referenced by <file>"); files under `archive`,
`_archive` or `archived` folders are `junk` ("archived copy"). A config or
script must name the exact path (`docs/release-notes.md` does not claim `notes.md`).
`keep_in_place` always wins, also at apply time. An integrated doc gets
`last_updated` from git (today if untracked) and no `last_validated`. An accepted `integrate` moves
the file into the tree and removes the original in one commit, with
`moved_from` and a `provenance:` line (first and last commit date, authors),
and repoints links from docs in the tree. Nothing is deleted without an
accepted entry. Links from other outside files are not repointed.

## Safety rules

- Nothing changes without an accepted, hash-matching review entry.
- `last_verified` is never derived from git dates.
- Ledger, review files and drafts live under `.hewtd/`, not in the docs tree.

## Troubleshooting

- **"uncommitted changes in scope"**: commit or stash the listed files, rerun.
- **"no scope"**: pass a domain, folder, files, or `--next N`.
- **Entry reported `stale`**: the doc changed after triage. Re-triage and
  re-judge it; the old proposal is never applied.
- **Staleness shows `unknown`, shallow clone warning**: run
  `git fetch --unshallow`. Triage still works without the signal.
- **Rejected, doc in two review files** (or twice in one): remove the duplicate and rerun.
- **Outside entry: "target ... already exists"**: a doc with that filename is
  already in the chosen domain. Pick another `domain` in the entry, or merge by hand.
- **Outside entry: "uncommitted changes in docs that link here"**: the move would
  repoint links in those docs and commit them; commit or stash them first.
- **Many refs show `unknown` for URLs or `/abs/paths`**: by design. Only
  `missing` counts against a doc.
- **Tables reported nowhere / not checked**: set `reconcile.schema_sources`
  (default `[]`); triage prints the schema files it found.
- **A reference to another repo shows missing or unknown**: add that repo to
  `reconcile.related_repos`, check it out, and rerun.
- **`owner: <name>` hint on a clean doc**: summarize the details and link to the
  owning repo's doc; do not copy it.
- **Staleness resets after a `last_verified` stamp**: it does not; only body
  changes reset it.
- **Apply exits 1 with "rolled back"**: nothing was committed; fix the
  reported error and rerun the same review file.
- **Config ignored from a subdirectory**: fixed in 2.16.0; config is read from
  the docs path's project root, not the current directory.
- **False positive flagged as a secret**: add it to `reconcile.secrets.allow`
  (by `fingerprint` from the report, the full hash or any prefix of at least 12 hex
  chars as shown there, or a `pattern`) with a `reason`.
- **"cannot git-ignore .env.hewtd"**: `.gitignore` is not writable; fix its
  permissions and rerun. Nothing was changed.
- **"NAME already exists in .env.hewtd with a different value"**: rename or
  remove the existing line, then rerun.
- **Apply rolled back with "would write a secret to the staged diff"**: the doc
  still holds the value; accept its `secret` verdict first.
- **Nothing applied**: entries need `- [x] accept` and a non-null verdict.
- **Stray `.hewtd/` in a subdirectory**: state is rooted at the git root; a
  directory created by an older build can be deleted.

- **`copy of owner.md#section` flag**: the doc repeats another doc's section. Merge any
  missing detail into the owner, then point.
- **Point refused with `missing: ...`**: the removed text holds facts the owner section and
  summary lack. Merge them into the owner (or the summary) and rerun.
- **`pointer target changed: ...`**: re-read the owner section; re-apply a `point` if the
  summary still holds, or rewrite the summary.
- **`overview target already exists` / member not reconciled**: pick another target, or
  reconcile the members first (or mark `(unreviewed)` with `allow_unreviewed`).
- **`LINK_BROKEN_ANCHOR: no heading #x`**: warning only; the heading was renamed or removed.

## Limitations

- No read log for `sources`: the slash command must only list files it read.
- Team defaults are provisional. Triage was measured on one real tree (121
  docs, whole-tree plan: 4 shards); wall time versus serial was not measured.
  Retune from the ledger's `reviewed_on` dates after real runs.
- Superseded: the drafting commands deferred in #50 (E) and #51 (section 3)
  are covered by `/reconcile`.
