
# Graph export

## Purpose

A plain, versioned file that maps each doc to the code it cites, so another tool (first consumer: semantic-memory) can rank by freshness, flag dead references and fold duplicate sections. hewtd never reads the file back; a missing file means "no export".

## Location and when it is written

`<git root>/.hewtd/graph.json`, written by `hewtd index` and after every `hewtd reconcile --apply`. Set `graph_export: false` in the hewtd config to turn it off (nothing is written), or run `hewtd index --no-graph` to skip it for one run (2.22.0: no file is written and no export line is printed; `--dry-run` is unchanged; `reconcile --apply` still exports). hewtd never edits `.gitignore`; add `.hewtd/graph.json` yourself if you do not want it committed (a one-time hint appears when the file is not ignored).

- `reconcile --apply` rewrites it only when at least one entry was applied; a rolled-back batch leaves it alone.
- A byte-identical rebuild does not touch the file, so its mtime stays.
- `--dry-run` prints `Would update` and writes nothing.
- Outside a git repo the export is skipped with a notice.
- The graph goes through the secret guard before it is written. An export failure is a warning and never fails `index`.
- Cost: the export runs a full triage (including the secret scan and duplicate detection). On a large tree `hewtd index` takes seconds instead of a fraction of a second (about 3 to 5 s on 87 docs with git history); `graph_export: false` or `hewtd index --no-graph` restores the old speed. Since 2.22.0 triage also looks up where each symbol is defined, which makes it roughly 10 to 15% slower on a docs tree (about 145 ms more per 150 symbol names).
- `.hewtd/graph-cache.json` is a separate cache of body-change dates. It holds dates only and is safe to delete.

The file has no timestamp. `source_commit` (HEAD sha, or `null` outside git) makes it reproducible: regenerating an unchanged tree is byte-identical (sorted keys, stable ordering, 2-space JSON, trailing newline).

## Fields

JSON Schema: `schemas/graph.v1.schema.json` (shipped in the npm package). Types: `src/core/graph/schema.ts`.

| Field | Meaning |
|---|---|
| `version` | Always `1` for this format. |
| `source_commit` | HEAD sha or `null`. |
| `docs` | Map of docs-relative path to the entry below. |
| `symbols` | Map of symbol name to `{file, file_kind, cited_by: [doc]}`. |

The export covers exactly the docs triage judges (2.22.0): every markdown file under the docs path, including `drafts/`, `generated: true` and `tier: plan` docs. A plan doc whose refs are missing shows `resolved: false`. `archive/` is still not in the graph.

### Symbol definition sites (2.22.0)

- `file_kind` is `"definition"` or `"reference"`. It is an additive field on symbol refs in `docs[x].refs[]` and on `symbols[name]`, present only when the symbol resolved. `version` stays `1`.
- A symbol's `file` is the source file that defines it, found with regex patterns, not a parser: `def`, `class`, `function`, `const`, `let`, `var`, `interface`, `type`, `enum`, `struct`, `fn`, `func`, `name: function(`, `name = (`, SQL `CREATE [OR REPLACE] TABLE|VIEW|FUNCTION|POLICY|TYPE [IF NOT EXISTS] [schema.]name` (case-insensitive) and `__tablename__ = "name"`.
- When several files define it, a source file beats one under `test/`, `tests/`, `__tests__/`, `__mocks__/`, `mock(s)/`, `fixture(s)/`, `spec/` or named `*.test.*`/`*.spec.*`; then path order decides. The patterns are loose, so a tuple assignment (`Name = (a, b)`) also counts.
- If no source file defines it, `file` falls back to the first non-JSON, non-generated file that mentions it, then to any file that mentions it. Both fallbacks report `"reference"`.
- Never a definition site: `.json`, `*.lock`, `*-lock.*`, `*.generated.*`, `*.min.*`, `dist/`, `build/`, markdown, and files over 512KB.
- Symbols from `related_repos` get the same choice.

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
| `verified` | Triage lane `clean` (attributed and every ref resolves), or ledger verdict `verify` with a matching content hash and no pointer target or overview member changed since. |
| `fields-only` | Refs resolve and the doc is attributed; only `purpose`/`symptoms` are missing. |
| `check` | Lane `check`: unattributed, or a reference is missing. |
| `stale` | Lane `check` whose only reason is code changed since the doc's last body change. |
| `archive-candidate` | Most checkable refs are missing. |
| `secret` | Holds a credential; blocked until sanitized. |
| `unreviewed` | The doc has never been through `/reconcile` (no ledger entry) and is not `clean`, `secret` or `archive-candidate`. Its `refs` still show what is missing. |

Every doc gets exactly one verdict, checked in this order: `secret`, `archive-candidate`,
`verified` from lane `clean`, `unreviewed`, then the reconcile state. The export reads
the reconcile ledger but never writes it, and `--dry-run` writes neither the graph nor
the body-date cache.

## Troubleshooting

- **No `graph.json` after `hewtd index`**: you passed `--no-graph`, `graph_export` is `false`, the directory is not a git repo (a notice is printed), or the export warned; read the warning.
- **`index` got slower**: expected, see Cost above. Run `hewtd index --no-graph` when you only want the indexes.
- **A symbol's `file` is a mention, not its definition**: `file_kind` is `reference`, so no source file matched a definition pattern (dynamic definitions, unusual syntax, or a file over 512KB). Consumers should treat `reference` as "somewhere it is mentioned".
- **Every `body_changed` is `null`**: not a git repo, or a shallow clone without history. Fetch full history.
- **Consumer sees a corrupt or missing file**: delete it and run `hewtd index`. No hewtd command reads it, so nothing else is affected.

## Versioning rule

Additive fields keep `version: 1`; consumers ignore fields they do not know. Any removal, rename or change of meaning bumps `version`. Consumers must ignore a version they do not know, with one warning.

## Privacy

Paths, symbol names and dates only. No doc text and no values. Writes go through the secret guard.
