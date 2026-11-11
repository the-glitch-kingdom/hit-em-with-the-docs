# Cold rotation (3.2.0, #97)

Reconcile a **copy** of the docs tree, then swap it in and keep the old tree as a committed,
write-protected, dated **cold generation**. If the new docs are worse, `--undo` puts the old tree
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
   it prints the plan. With it, two renames swap the trees, the old tree's files are made read-only
   (their original modes are recorded), the ledgers move, the manifest is written, INDEX/REGISTRY are regenerated and one commit
   `docs(rotate): promote <stage> and keep <gen> cold` records it.
4. `--undo <gen> --confirm` restores the generation as the live docs and moves the rejected tree
   to a new stage `.hewtd/stage/rejected-<timestamp>` (with its own `stage.json`), restores the
   ledger, restores every file mode exactly, drops the manifest entry, removes the cold root when
   that leaves it empty, and commits `docs(rotate): undo <gen>`. Without `--confirm` it
   runs every check, prints what it would do and exits 1. Undo does not regenerate INDEX/REGISTRY:
   the generation's own index files come back as they were. Other generations stay on disk. Undoing
   an older generation while a newer one exists is not specified yet; undo the newest first.

## Layout

| Path | What | In git |
|---|---|---|
| `<stage>/docs/`, `stage.json`, `ledger.json`, `reconcile/` | the staged copy, its ledger and review files | no (`.hewtd/` is ignored) |
| `<cold_root>/<YYYY-MM-DD>/` (`-2`, `-3` on a clash) | an old docs tree, files read-only (0444-style) | yes |
| `<cold_root>/.generations/<gen>/ledger.json` | the outgoing ledger | yes |
| `<cold_root>/.generations/<gen>/modes.json` | every file's original mode (`path -> octal`), put back on undo | yes |
| `<cold_root>/.generations/<gen>/scanners.json` | the scanner configs promote edited: original text and a hash of the edited text (only when it edited any) | yes |
| `<cold_root>/.gitignore` | lists each generation's gitignored files | yes |
| `.gitleaks.toml`, `.secrets.baseline` | cold root allowlisted for secret scanners (see below) | yes |

`reconcile.cold_root` defaults to `.documentation-cold`. It must not be inside the docs tree, be
ignored by git or sit on another filesystem. The live ledger is committed only when git does not
ignore it (the default `.hewtd/reconcile.json` is ignored, so it stays on disk).

## Secret scanners (#101)

The promote commit re-adds the whole old tree under `<cold_root>/<gen>/`, so a PR scan over it (gitleaks
fingerprints are `commit:file:rule:line`) would report every already-baselined finding as new. Promote
therefore allowlists the cold root in the scanner configs at the repo root, in the same commit, and records
the files in the manifest entry (`scanner_allowlists`):

- `.gitleaks.toml`: the path is added to `[allowlist] paths` (or a `[[allowlists]]` block if the file uses that
  form). A repo without one gets a new file with `[extend] useDefault = true` (so gitleaks' default rules stay on)
  plus the allowlist.
- `.secrets.baseline` (detect-secrets, only if present): the path is added to the `should_exclude_file` filter
  (`exclude.files` in the older format).

Only the cold root is allowlisted. Undo puts each file back byte for byte (deleting one promote created); a file
edited since the promote is left alone and undo says so. Set `reconcile.cold_scanner_allowlist: false` to touch
no scanner file; the plan then warns that the promote commit will re-add the flagged strings. The plan and the
promote result also say how many files hold strings scanners commonly flag, and how many staged docs will show as
unreviewed (`DOCS_UNREVIEWED`) because `<stage>/ledger.json` has no review for them: put the reviewing ledger
there before promoting (without it a promote reports every doc as unreviewed; `reconcile --changed --write-review` on the live tree afterwards clears them). Other scanners (trufflehog, say) are not edited: add a path exclude by hand, for trufflehog a line `^\.documentation-cold/` in the file passed to `--exclude-paths` (use your `reconcile.cold_root`). Undo needs the generation name: `--undo <gen> --confirm`. Promote and undo batch the git history reads, so about 1,000 docs take seconds.

## Committed versus disk-only

Everything tracked in the old tree is committed in the cold generation, force-added, so a `.gitignore`
pattern that happens to match a file's cold path (an unanchored `build/`, say) never drops it; undo
force-adds the generation's files back the same way. Files the old tree had that
git ignores move with it on disk but are not committed; they are listed in `untracked_files` and
ignored through `<cold_root>/.gitignore` (git is read with `-z`, so names with quotes, backslashes or tabs
are listed and ignored exactly; a name with a newline refuses the promote). **A fresh clone has the
generation without them.** Undo removes those ignore lines.

## Read-only locking and audit

Only the **files** of the cold generation lose their write bits; directories keep their mode, because a
locked directory makes `git checkout <older commit>`, `git clean`, `git stash -u` and CI cleanup fail.
The original mode of every file is saved in `modes.json` and restored exactly on undo and on a
rolled-back promote.

Two checksums are stored in the manifest. `checksum` is sha256 over the **committed** files of the
generation (what a fresh clone has); `disk_checksum` is over every file, gitignored disk-only ones
included. `hewtd audit` and `--generations` report `CHANGED` only when the committed files differ (or,
with no disk-only file absent, when the whole tree differs), `MISSING` when the folder is gone, and
`ok (disk-only files absent: N)` in a clone that lacks the gitignored files. Audit warns (never errors)
on `CHANGED` or `MISSING` and finds the generations from any subfolder or with `-p`. Undo refuses a
`CHANGED` generation, restores what exists and warns that the disk-only files are absent.

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
  "checksum": "<sha256 of the committed files>",
  "disk_checksum": "<sha256 of every file, gitignored ones included>",
  "secrets_findings": ["guide/setup.md:12"],
  "untracked_files": [".documentation/notes.local.md"]
}]
```

hewtd rewrites the file in its existing style (indent, trailing newline) and restores its exact bytes if a promote or undo fails. `path` is repo-relative; `untracked_files` are the old tree's gitignored files (repo-relative, from
where they were).

## Refusals

Each refuses with nothing changed and says why:

- stage: dir not empty, inside or containing the docs tree, outside the repo or on another filesystem.
- promote: stage invalid; live docs changed since the stage (the drifted paths are listed from git,
  which cannot see changes confined to gitignored files); docs, cold root, config or ledger with
  uncommitted changes; unusable cold root.
- promote and undo: `.claude/hit-em-with-the-docs.json` exists but is not a valid JSON object (it would be rewritten and lose settings); the message names the file and the parse error.
- undo: unknown generation; checksum mismatch; dirty tree; without `--confirm`.
- `--staged` with `-p`.

## Recovery

Every step after the first rename has an inverse that runs on any failure, so a failed promote or
undo leaves the trees as they were. If the process is killed mid-way (no rollback ran), look for
the three places the data can be and move by hand, never delete: the live docs path, the stage
dir (`<stage>/docs`), and `<cold_root>/<gen>` (chmod `u+w` it first). Compare with
`git status` and `git log -1`. A killed run never wrote a manifest entry, so `--generations` does not list it:
look on disk instead. Signs of a kill: `<cold_root>/<YYYY-MM-DD>` exists but `cold_storage` has no such
entry and `git log -1` is not a `docs(rotate)` commit; the live docs path is missing or holds the
staged copy while `<stage>/docs` is gone. To put the trees back by hand: `chmod -R u+w <cold_root>/<gen>`,
move the live docs folder back to `<stage>/docs` if it holds the staged copy, move `<cold_root>/<gen>`
back to the docs path, put the config back with `git checkout -- .claude/hit-em-with-the-docs.json`,
and remove the leftover `<cold_root>/.generations/<gen>` and its lines in `<cold_root>/.gitignore`.
File modes: `<cold_root>/.generations/<gen>/modes.json` has the originals if you need them. A failed
rollback prints which step failed.
