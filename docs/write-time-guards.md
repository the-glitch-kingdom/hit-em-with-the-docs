# Write-time guards (2.19.0)

Secrets and unverified claims are stopped when a doc is written, not found
later. Every example value below is masked or fake.

## integrate refuses secrets

`hewtd integrate <file>` scans the whole input before it writes anything. Any
secret refuses the run (exit 1), with masked findings first, then pointers:

```
vault-token notes.md:12 hvs....28
  see: hewtd reconcile --secrets
  accepted on purpose? hewtd secrets --baseline-add <file:line> --reason "<why>"
```

- `--force` does not bypass it, and `--dry-run` also fails.
- Emails are `personal` kind and never block.
- The detector, allowlist and `disabled_rules` are the ones in
  [`reconcile.md`](./reconcile.md#secrets-first-2170).

## Baseline for accepted findings

`.hewtd/secrets-baseline.json` is committed. It holds fingerprint, rule, file,
masked form and reason, never a value. It is merged into
`reconcile.secrets.allow` by fingerprint, so integrate, reconcile and the
staged scan all honour it.

```bash
hewtd secrets --baseline-add docs/ops.md:12 --reason "public test token"
hewtd secrets --baseline-prune     # drop entries that no longer match anything
```

## Staged scan and opt-in commit hook

```bash
hewtd secrets --staged      # scans only lines the staged diff adds under .documentation
hewtd hooks install         # opt-in: adds a marked block to pre-commit
hewtd hooks uninstall       # removes exactly that block (byte-exact)
```

- Exit 1 with masked `file:line` findings and the reconcile pointer. Only
  secret-kind findings block; emails do not.
- The hook block is `# >>> hewtd secrets >>>` ... `# <<< hewtd secrets <<<` and
  runs `npx --no-install hewtd secrets --staged || exit 1`. It resolves
  `core.hooksPath` or `.git/hooks` and is idempotent. In an existing hook the block
  goes right after the shebang (never overwriting anything), so a later `exit 0` or
  `exec` cannot skip it. A hook that is a symlink or not a POSIX shell script is
  refused with a one-line snippet to add yourself. Uninstall removes exactly the
  block and deletes a hook file it created.
- The hook fails closed: if `hewtd` cannot run (not installed), the commit is
  refused; uninstall the hook to bypass it deliberately.
- Baseline entries need a fingerprint and a reason; others are ignored with a warning.
- The hook scans the default docs path (`.documentation`). Nothing installs it
  for you.
- Speed: 12000 added lines across 300 files scan in about 0.3 s.

## integrate records `sources`

For a new doc, integrate records file-level `sources` for the code the doc
cites, so a later `reconcile` has something to check.

- Capped by `integrate.sources_max` in `.claude/hit-em-with-the-docs.json`
  (default 10; `0` turns recording off).
- File-level, de-duplicated, most-cited first. `path#symbol` and `path:line`
  fold into the path. A `symbol` or `env` name is recorded only when exactly one
  tracked non-markdown file holds it.
- Only references that resolve to git-tracked files are recorded. Outside a git
  checkout, sources are skipped.
- Hand-written `sources` are kept and never removed.
- integrate never writes `last_verified`: a fresh doc triages to `check`
  until someone verifies it.
- `sources` is for verification only. Search does not index it.

## No backfill

Upgrading hewtd changes no existing doc. Only integrate on a new doc writes
`sources`. See [`indexing.md`](./indexing.md#no-backfill-61).

## Troubleshooting

### "integrate refused my doc and printed a masked key"
Remove or replace the value. If it is a deliberate public value, run the
`hewtd secrets --baseline-add <file:line> --reason "..."` command it printed.
If the value was real, rotate it.

### "my commit was blocked by hewtd secrets --staged"
Same fix as above, then re-stage. To stop the hook, run `hewtd hooks uninstall`.

### "integrate recorded no sources"
The doc cited nothing that resolves to a tracked file, `integrate.sources_max`
is 0, or the project is not a git checkout.
