
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
- Incremental (3.1.0): when nothing changed since the last export, `hewtd index` skips the rebuild and prints nothing about the graph. When it writes, it prints `Graph export written`. When something changed, per-doc staleness results are reused from the cache. Measured on 900 docs and 400 code files, seconds: 3.0.0 cold 21.3, warm 15.7, one doc edit 13.8, one code edit 8.4; 3.1.0 cold 12.2, warm 0.2, one doc edit 1.5, one code edit 1.5.
- Per-doc reuse (3.1.1): when only docs changed and the code state is unchanged, the graph reuses per-doc triage entries from `doc_cache` in `.hewtd/graph-cache.json` (`state`, `entries`, `mentions`; each entry holds `hash`, `ledger`, `duplicates`, `unfound` and `triage`). The code state is a hash of the hewtd version, HEAD, the non-doc files git reports as changed (path and content), the config and the docs root; markdown under the docs root counts only when its index state differs from HEAD. A code edit, config change or `related_repos` falls back to the full path. **Commits (3.1.2)**: the state keys on the last commit that touched anything except a markdown file under the docs root (and `graph.json`, `graph-cache.json`, the ledger), not on HEAD, so a docs-only commit keeps the cache. `doc_cache` also stores `head`; `list_committed_changes(git_top, from, to)` returns the paths changed since it, and docs touched by those commits are re-resolved (every md path in the diff counts as changed). Body-change dates and staleness entries of untouched docs are reused across HEAD. When `head` is not an ancestor of HEAD (amend, rebase, non-descending branch switch, shallow clone missing the commit) or the cache has no `head` (a 3.1.1 cache), the full path runs, so the first run after upgrading to 3.1.2 is a full rebuild. The cache is best effort and a cold build stays the oracle. A committed non-markdown file under the docs root counts as a code change. Docs-only commit on the large profile: 31.8 s on 3.1.1, 1.3 s on 3.1.2. Docs re-resolved: edited, added or renamed ones; docs whose ledger entry or duplicates result changed; docs that link to, cite (path or `sources`) or point at (ledger pointer or members) a changed, added, removed or renamed doc; and docs whose code-less symbol names changed in which markdown files mention them. Removed docs drop out. A state mismatch or malformed cache is ignored and rebuilt; `--dry-run` reads the cache and never writes it. Output equals a cold build byte for byte. A reused entry is also re-resolved when one of its doc-link targets outside the kept docs (`archive/`, `INDEX.md`, a dot-dir, an ignored file) appears, disappears or changes kind, and the code state includes the names in `node_modules/.bin`, so installing or removing a package refreshes `npx` refs. Large benchmark profile (`node scripts/bench-graph.mjs dist/cli/index.js --profile large`, 920 docs, 3000 code files, 150 commits; `BENCH_KEEP=1` keeps the temp tree): one doc edit 8.2 s on 3.1.0 and 1.7 s on 3.1.1, warm unchanged 0.4 s, cold unchanged (about 40 to 47 s), code-file edit 8.3 s (full path).
- Cost (cold build): the export runs a full triage (including the secret scan and duplicate detection). On a large tree `hewtd index` takes seconds instead of a fraction of a second (about 3 to 5 s on 87 docs with git history); `graph_export: false` or `hewtd index --no-graph` restores the old speed. Since 2.22.0 triage also looks up where each symbol is defined, which makes it roughly 10 to 15% slower on a docs tree (about 145 ms more per 150 symbol names).
- `.hewtd/graph-cache.json` (`cache_version: 1`) holds the body-change dates, the export fingerprint with the hash of the `graph.json` it matches, and the per-doc staleness signals (keyed by content hash, cited files and HEAD). It is safe to delete; a corrupt file or another `cache_version` is ignored and rebuilt. Add it to `.gitignore` next to `graph.json`.
- What invalidates the fast path: any new commit or change to the working tree (HEAD, `git status` and the content of each dirty path), any markdown doc under the docs root (git-ignored ones too), the reconcile ledger, the config, the docs root, the hewtd version, and a hand-edited `graph.json`. Staleness signals are exact only at an unchanged HEAD, so a new commit drops them (the first export after a commit is cold-speed, then fast); uncommitted edits to docs and code reuse them. The incremental graph is byte-identical to a cold build.
- The fast path and staleness cache are off when `reconcile.related_repos` is non-empty, because a sibling checkout changing cannot be seen.
- Runtime expressions are not references (3.1.0): a backticked `process.env.X`, `import.meta.env.X`, `os.environ["X"]`, `os.environ.get("X")`, `os.getenv("X")` or `Deno.env`/`Bun.env.X` becomes an env ref for `X`; bare `process.env`, `import.meta.env`, `os.environ` add nothing. Dotted tokens on runtime objects without a slash (`window.*`, `document.*`, `req.*`, `res.*`, `ctx.*`, `this.*`, `console.*` and similar) are not file, column or symbol refs, unless they end in a file extension (`request.ts`, `document.md` and `config.env` stay files). Expect dead-ref counts from these to drop; consumers may see fewer `file` refs than before.
- Benchmark: `node scripts/bench-graph.mjs [path/to/dist/cli/index.js] [docs=900] [code=400]` builds a temp git repo and times cold, warm, one doc edit and one code edit with stage timings. Not part of CI.

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
- **`index` is slow**: the first export after a new commit is a cold build (see Incremental above), then it is fast again. Run `HEWTD_TIMING=1 hewtd index` to print a per-stage breakdown on stderr; delete `.hewtd/graph-cache.json` to force a clean rebuild; a non-empty `reconcile.related_repos` disables the fast path. Run `hewtd index --no-graph` when you only want the indexes.
- **`index` takes tens of seconds after a one-doc edit**: before 3.1.1 a doc edit re-resolved every doc's symbols (8 s on the large profile). From 3.1.1 it takes about 2 s as long as HEAD and the code are unchanged. If it is still slow, you committed code, edited code or changed the config since the last export (cold path); run `HEWTD_TIMING=1 hewtd index` to see the stages.
- **`index` is slow right after a commit**: from 3.1.2 a docs-only commit stays fast (about 1 s on the large profile). A cold build still follows a code commit, an amend or rebase, a branch switch, a shallow clone missing the cached commit, and the first run after upgrading from 3.1.1.
- **A symbol's `file` is a mention, not its definition**: `file_kind` is `reference`, so no source file matched a definition pattern (dynamic definitions, unusual syntax, or a file over 512KB). Consumers should treat `reference` as "somewhere it is mentioned".
- **Every `body_changed` is `null`**: not a git repo, or a shallow clone without history. Fetch full history.
- **Consumer sees a corrupt or missing file**: delete it and run `hewtd index`. No hewtd command reads it, so nothing else is affected.

## Versioning rule

Additive fields keep `version: 1`; consumers ignore fields they do not know. Any removal, rename or change of meaning bumps `version`. Consumers must ignore a version they do not know, with one warning.

## Privacy

Paths, symbol names and dates only. No doc text and no values. Writes go through the secret guard.
