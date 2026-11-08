
# Graph export

## Purpose

A plain, versioned file that maps each doc to the code it cites, so another tool (first consumer: semantic-memory) can rank by freshness, flag dead references and fold duplicate sections. hewtd never reads the file back; a missing file means "no export".

## Location and when it is written

`<git root>/.hewtd/graph.json`, written by `hewtd index` and after every `hewtd reconcile --apply`. Set `graph_export: false` in the hewtd config to turn it off (nothing is written). hewtd never edits `.gitignore`; add `.hewtd/graph.json` yourself if you do not want it committed.

The file has no timestamp. `source_commit` (HEAD sha, or `null` outside git) makes it reproducible: regenerating an unchanged tree is byte-identical (sorted keys, stable ordering, 2-space JSON, trailing newline).

## Fields

JSON Schema: `schemas/graph.v1.schema.json` (shipped in the npm package). Types: `src/core/graph/schema.ts`.

| Field | Meaning |
|---|---|
| `version` | Always `1` for this format. |
| `source_commit` | HEAD sha or `null`. |
| `docs` | Map of docs-relative path to the entry below. |
| `symbols` | Map of symbol name to `{file, cited_by: [doc]}`. |

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
| `unreviewed` | Never triaged. |

Every doc gets exactly one verdict, so "never checked" (`unreviewed`) is distinct from "checked and failing".

## Versioning rule

Additive fields keep `version: 1`; consumers ignore fields they do not know. Any removal, rename or change of meaning bumps `version`. Consumers must ignore a version they do not know, with one warning.

## Privacy

Paths, symbol names and dates only. No doc text and no values. Writes go through the secret guard.
