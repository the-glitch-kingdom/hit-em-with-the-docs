# Reconcile: check existing docs against the code (2.15.0, updated in 2.16.0)

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
| `archive-candidate` | Cited things are missing. Only `missing` counts; `unknown` is neutral. |

Staleness (commits touching the cited paths since the doc's last body change)
raises priority only. The body-change point is the oldest of the consecutive
latest commits whose body (frontmatter stripped) equals the current body, so
frontmatter-only commits, such as a `last_verified` stamp, do not reset it
(walk capped at 50 commits). In a shallow clone it is `unknown` and triage warns. It is never
used to write `last_verified`.

## Reference statuses

Each cited thing resolves to `ok`, `missing` or `unknown`. Only `missing`
pushes a doc toward `archive-candidate`; `unknown` is neutral.

- Scripts are collected from every tracked `package.json`, not just the root.
- `unknown` (never `missing`): a link or path that leaves the project root
  (including a leading-slash path), a host-like URL that does not resolve in the
  repo (`example.com/docs/x`), a name that appears only in markdown and not in
  code, and a reference into a related repo that is not checked out.
- Tables and columns are checked only against `schema_sources`. It defaults to
  `[]`, so nothing is checked until you list globs, for example
  `["**/migrations/**/*.sql", "**/schema.prisma"]`. Triage lists the schema
  files it found (`schemaFiles` in JSON, `schema files:` in text) so you can
  pick the globs.
- Cited bytes and staleness count resolved path references and `sources`
  only, not symbol hits.

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
(never overwrites). Each doc is a `## <path>` heading, a `- [ ] accept` line and
a JSON entry: `path`, `content_hash`, `verdict`, and optionally `frontmatter`,
`patch` (`{old,new}` pairs; each `old` must occur exactly once in the body),
`draft`, `sources`, `reason`.

Verdicts: `verify`, `rewrite`, `archive`, `unverifiable`, `fields`; outside
entries use `integrate` and `delete`.

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
  regeneration, stage, commit) the batch is restored from HEAD, files and
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
`_archive`, `archived` or `old` folders are `junk` ("archived copy").
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
- **Nothing applied**: entries need `- [x] accept` and a non-null verdict.
- **Stray `.hewtd/` in a subdirectory**: state is rooted at the git root; a
  directory created by an older build can be deleted.

## Limitations

- No read log for `sources`: the slash command must only list files it read.
- Team defaults are provisional. Triage was measured on one real tree (121
  docs, whole-tree plan: 4 shards); wall time versus serial was not measured.
  Retune from the ledger's `reviewed_on` dates after real runs.
- Superseded: the drafting commands deferred in #50 (E) and #51 (section 3)
  are covered by `/reconcile`.
