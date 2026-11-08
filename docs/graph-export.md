
# Graph export

## Purpose

A plain, versioned file that maps each doc to the code it cites, so another tool (first consumer: semantic-memory) can rank by freshness, flag dead references and fold duplicate sections. hewtd never reads the file back; a missing file means "no export".

## Location and when it is written

`<git root>/.hewtd/graph.json`, written by `hewtd index` and after every `hewtd reconcile --apply`. Set `graph_export: false` in the hewtd config to turn it off (nothing is written). hewtd never edits `.gitignore`; add `.hewtd/graph.json` yourself if you do not want it committed (a one-time hint appears when the file is not ignored).

- `reconcile --apply` rewrites it only when at least one entry was applied; a rolled-back batch leaves it alone.
- A byte-identical rebuild does not touch the file, so its mtime stays.
- `--dry-run` prints `Would update` and writes nothing.
- Outside a git repo the export is skipped with a notice.
- The graph goes through the secret guard before it is written. An export failure is a warning and never fails `index`.
- Cost: the export runs a full triage (including the secret scan and duplicate detection). On a large tree `hewtd index` takes seconds instead of a fraction of a second (about 3 to 5 s on 87 docs with git history); `graph_export: false` restores the old speed.
- `.hewtd/graph-cache.json` is a separate cache of body-change dates. It holds dates only and is safe to delete.

The file has no timestamp. `source_commit` (HEAD sha, or `null` outside git) makes it reproducible: regenerating an unchanged tree is byte-identical (sorted keys, stable ordering, 2-space JSON, trailing newline).

## Fields

JSON Schema: `schemas/graph.v1.schema.json` (shipped in the npm package). Types: `src/core/graph/schema.ts`.

| Field | Meaning |
|---|---|
| `version` | Always `1` for this format. |
| `source_commit` | HEAD sha or `null`. |
| `docs` | Map of docs-relative path to the entry below. |
| `symbols` | Map of symbol name to `{file, cited_by: [doc]}`. |

Docs under `drafts/`, `generated: true` docs and `tier: plan` docs are not in the graph, nor is `archive/`.

Doc entry:

| Field | Meaning |
|---|---|
| `body_changed` | Date (`YYYY-MM-DD`) of the last commit that changed the body (frontmatter-only commits do not move it), or `null`. |
| `verdict` | One value, see below. |
| `last_verified` | From frontmatter; set only by a real verification, never from git dates. `null` if none. |
| `refs` | Cited references: `kind` (`file`, `symbol`, `env`, `command`, `table`, `column`, `doc`), `target`, optional `file` (symbol's file), optional `repo` (a `related_repos` sibling), `resolved`, optional `code_changed`. |
| `owner_of` | `<path>#<anchor>` sections this doc owns. |
| `points_to` | `{from: '#anchor'\|null, to: '<path>#<anchor>'}` pointers to the owning section. |
| `duplicates` | `{section: '#anchor', owner: '<path>#<anchor>'}` sections duplicating another doc's. |

Limits of the data: `points_to.from` is always `null` (the ledger records only the target); `duplicates.section` is `#<owner anchor>`; a file ref that resolves to a directory has no `code_changed`; in a shallow clone dates are limited by the history present.

`resolved`: `true` found, `false` missing, `null` could not be checked (triage `unknown`, for example no schema source or a related repo not checked out). Do not count `null` as dead. `code_changed` is the last commit date of the resolved file; drift is `code_changed > body_changed`.

## Verdict mapping

| Verdict | Source |
|---|---|
| `verified` | Ledger verdict `verify` with a matching content hash, or triage lane `clean`. |
| `fields-only` | Refs resolve and the doc is attributed; only `purpose`/`symptoms` are missing. |
| `check` | Lane `check`: unattributed, or a reference is missing. |
| `stale` | Lane `check` whose only reason is code changed since the doc's last body change. |
| `archive-candidate` | Most checkable refs are missing. |
| `secret` | Holds a credential; blocked until sanitized. |
| `unreviewed` | Reserved. Every in-tree doc is triaged, so hewtd never emits it today. |

Every doc gets exactly one verdict. Consumers should still accept `unreviewed`.

## Troubleshooting

- **No `graph.json` after `hewtd index`**: `graph_export` is `false`, the directory is not a git repo (a notice is printed), or the export warned; read the warning.
- **`index` got slower**: expected, see Cost above.
- **Every `body_changed` is `null`**: not a git repo, or a shallow clone without history. Fetch full history.
- **Consumer sees a corrupt or missing file**: delete it and run `hewtd index`. No hewtd command reads it, so nothing else is affected.

## Versioning rule

Additive fields keep `version: 1`; consumers ignore fields they do not know. Any removal, rename or change of meaning bumps `version`. Consumers must ignore a version they do not know, with one warning.

## Privacy

Paths, symbol names and dates only. No doc text and no values. Writes go through the secret guard.
