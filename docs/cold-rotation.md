# Cold rotation (3.2.0, #97)

Reconcile a **copy** of the docs tree, then swap it in and keep the old tree as a committed,
read-only, dated **cold generation**. If the new docs are worse, `--undo` puts the old tree
back byte for byte. Everything is under `hewtd reconcile`; no step deletes a tree.

## Workflow

```bash
hewtd reconcile --stage .hewtd/stage-1                 # 1. snapshot the live docs
hewtd reconcile --staged .hewtd/stage-1 <scope>        # 2. any reconcile mode, on the copy
hewtd reconcile --staged .hewtd/stage-1 --apply <review-files>
# 3. optional: evaluate the copy (retrieval eval, review it, diff it) before swapping
hewtd reconcile --promote --staged .hewtd/stage-1             # 4. prints the plan, changes nothing
hewtd reconcile --promote --staged .hewtd/stage-1 --confirm   #    swaps and commits
hewtd reconcile --generations [--json]                        # 5. list cold generations
hewtd reconcile --undo <generation> --confirm                 # 6. roll back
```

1. `--stage <dir>` copies the working tree (`archive/`, gitignored and untracked files included;
   only `.git` is skipped) to `<dir>/docs/` and writes `<dir>/stage.json`. The dir must be empty or
   new, inside the repo, outside the docs tree and on the docs tree's filesystem (the swap is an
   atomic rename). Use `.hewtd/<name>` (git-ignored). Never commit a stage.
2. `--staged <dir>` runs any mode on the copy only. The live tree, ledger, `.hewtd/graph.json` and
   git stay untouched; `--apply` makes no commit. It cannot be combined with `-p`. The `secret`
   verdict and outside-lane entries write into the live repo, so staged apply reports them as
   `error` and writes nothing; `--secrets` still scans the copy. Staged apply has no rollback: if
   it fails midway, discard the stage and stage again. The live tree is never at risk.
3. `--promote` checks first and refuses with nothing changed (see Refusals). Without `--confirm`
   it prints the plan. With it, two renames swap the trees, the old one is made read-only, the
   ledgers move, the manifest is written, INDEX/REGISTRY are regenerated and one commit
   `docs(rotate): promote <stage> and keep <gen> cold` records it.
4. `--undo <gen> --confirm` restores the generation as the live docs and moves the rejected tree
   to a new stage `.hewtd/stage/rejected-<timestamp>` (with its own `stage.json`), restores the
   ledger, drops the manifest entry and commits `docs(rotate): undo <gen>`. Without `--confirm` it
   runs every check, prints what it would do and exits 1. Undo does not regenerate INDEX/REGISTRY:
   the generation's own index files come back as they were. Other generations stay on disk. Undoing
   an older generation while a newer one exists is not specified yet; undo the newest first.

## Layout

| Path | What | In git |
|---|---|---|
| `<stage>/docs/`, `stage.json`, `ledger.json`, `reconcile/` | the staged copy, its ledger and review files | no (`.hewtd/` is ignored) |
| `<cold_root>/<YYYY-MM-DD>/` (`-2`, `-3` on a clash) | an old docs tree, read-only | yes |
| `<cold_root>/.generations/<gen>/ledger.json` | the outgoing ledger | yes |
| `<cold_root>/.gitignore` | lists each generation's gitignored files | yes |

`reconcile.cold_root` defaults to `.documentation-cold`. It must not be inside the docs tree, be
ignored by git or sit on another filesystem. The live ledger is committed only when git does not
ignore it (the default `.hewtd/reconcile.json` is ignored, so it stays on disk).

## Committed versus disk-only

Everything tracked in the old tree is committed in the cold generation. Files the old tree had that
git ignores move with it on disk but are not committed; they are listed in `untracked_files` and
ignored through `<cold_root>/.gitignore`. **A fresh clone has the generation without them.**
Undo removes those ignore lines.

## Read-only locking and audit

The cold generation is `chmod`'d read-only and its `checksum` (sha256 over the tree) is stored in the
manifest. `hewtd audit` recomputes it and warns (never errors) when a generation is `CHANGED` or
`MISSING`; `--generations` shows the same status (`ok`, `CHANGED`, `MISSING`). Undo refuses a
generation whose checksum no longer matches.

A cold generation is history, not current docs. Reconcile's reference index, mention search, symbol
search and outside lane, the peripheral secrets scan, the integrator's file search, the staged-secrets
hook scan and graph commit-range invalidation all leave the cold root out.

## Secrets

The outgoing tree is scanned before it is committed. Findings are recorded as `path:line` in
`secrets_findings` (never a value) and shown in the plan and by `--generations`. A cold generation
is committed, so **those values stay in git history: rotate those credentials.** The incoming
staged tree is not scanned at promote (staged apply validates its writes; the opt-in pre-commit
hook covers the commit). If the pre-commit hook (`npx --no-install hewtd`) cannot be resolved the
promote commit fails and the whole promote rolls back with nothing changed.

## Manifest (`cold_storage`)

Written by hewtd to the plugin config `.claude/hit-em-with-the-docs.json`, as an array. Keys hewtd does
not model are preserved. Indexers (semantic-memory) can read it to treat these paths as history:

```json
"cold_storage": [{
  "generation": "2026-11-10",
  "path": ".documentation-cold/2026-11-10",
  "source_commit": "<sha the stage was cut from>",
  "rotated_at": "2026-11-10T18:00:00.000Z",
  "checksum": "<sha256 of the tree>",
  "secrets_findings": ["guide/setup.md:12"],
  "untracked_files": [".documentation/notes.local.md"]
}]
```

`path` is repo-relative; `untracked_files` are the old tree's gitignored files (repo-relative, from
where they were).

## Refusals

Each refuses with nothing changed and says why:

- stage: dir not empty, inside or containing the docs tree, outside the repo or on another filesystem.
- promote: stage invalid; live docs changed since the stage (the drifted paths are listed from git,
  which cannot see changes confined to gitignored files); docs, cold root, config or ledger with
  uncommitted changes; unusable cold root.
- undo: unknown generation; checksum mismatch; dirty tree; without `--confirm`.
- `--staged` with `-p`.

## Recovery

Every step after the first rename has an inverse that runs on any failure, so a failed promote or
undo leaves the trees as they were. If the process is killed mid-way (no rollback ran), look for
the three places the data can be and move by hand, never delete: the live docs path, the stage
dir (`<stage>/docs`), and `<cold_root>/<gen>` (chmod `u+w` it first). Compare with
`git status` and `git log -1`; `hewtd reconcile --generations` shows whether the checksum still matches
`live_checksum`/`checksum`. A failed rollback prints which step failed.
