# Reconcile: check existing docs against the code (2.15.0)

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
ledger. With no scope and no `--next` the command refuses. It also refuses if
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
| `clean` | Already carries `sources` and `last_verified`, nothing missing. |
| `fields-only` | Only frontmatter fields are missing. |
| `check` | Needs the judgment pass. |
| `archive-candidate` | Cited things are missing. Only `missing` counts; `unknown` is neutral. |

Staleness (commits touching the cited paths since the doc's last commit) raises
priority only. In a shallow clone it is `unknown` and triage warns. It is never
used to write `last_verified`.

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
serial. `--serial` and `--team` override. Overlapping link clusters are never
split, so one huge cluster is one big shard; run per domain instead.
Agents only write review files; `--apply` stays serial.

Config lives in `.claude/hit-em-with-the-docs.json` under `reconcile`; every
key is optional and invalid values fall back to the defaults:

```json
{ "reconcile": {
    "keep_in_place": ["README.md", ".github/**", ".claude/**"],
    "ledger_path": ".hewtd/reconcile.json",
    "schema_sources": ["**/migrations/**/*.sql", "**/schema.prisma"],
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

`keep_in_place` always wins, also at apply time. An accepted `integrate` moves
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
- **Rejected, doc in two review files**: remove it from one file and rerun.
- **Nothing applied**: entries need `- [x] accept` and a non-null verdict.
- **Stray `.hewtd/` in a subdirectory**: state is rooted at the git root; a
  directory created by an older build can be deleted.

## Limitations

- No read log for `sources`: the slash command must only list files it read.
- Clusters are not size-capped.
- Team defaults are provisional. Triage was measured on one real tree (121
  docs, whole-tree plan: 4 shards); wall time versus serial was not measured.
  Retune from the ledger's `reviewed_on` dates after real runs.
- Superseded: the drafting commands deferred in #50 (E) and #51 (section 3)
  are covered by `/reconcile`.
