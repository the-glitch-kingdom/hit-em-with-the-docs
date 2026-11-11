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
- 2.22.0: the detector ignores word-made code references, placeholders, pointer records and email values (random-character values are still secrets), and adds the `approle-id` and `vault-kv-value` rules and shorter `hvs.` tokens; details in
  [`reconcile.md`](./reconcile.md#secrets-first-2170).
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
- 3.1.1: `generic-secret` reports literals only. Code expressions, wrapped placeholders (`<..>`, `${..}`, `{{..}}`),
  regex-heavy values, `abc123`/`123456`/`qwerty` placeholders and well-formed emails (digit-bearing ones too) no longer
  block a write, as long as what they excuse is words or runs, never random characters. Rules in
  [reconcile.md](./reconcile.md#secrets-first-2170).
- 3.1.2: the word test behind those exemptions judges each camelCase or acronym hump on its own (`openAIApiKey`,
  `getAPIKey(`, `LLMProviderKey`, `minLengthRequirement12` are no longer flagged); random values in the same
  positions still block. See the Word test in [reconcile.md](./reconcile.md#secrets-first-2170).
- 3.1.4: structured code (`datetime.utcnow()`, `settings.qdrant_api_key`), CSS functions (`hsl(var(--x))`), markdown links and
  `$VAR` references no longer block a write when their tokens read as code (one non-English name allowed); random values
  in the same shapes still do. See [reconcile.md](./reconcile.md#secrets-first-2170).
- The hook block is `# >>> hewtd secrets >>>` ... `# <<< hewtd secrets <<<` and
  runs `npx --no-install hewtd secrets --staged || exit 1`. It resolves
  `core.hooksPath` or `.git/hooks` and is idempotent. In an existing hook the block
  goes right after the shebang (never overwriting anything), so a later `exit 0` or
  `exec` cannot skip it. A hook that is a symlink or not a POSIX shell script is
  refused with a one-line snippet to add yourself. Uninstall removes exactly the
  block and deletes a hook file it created.
- The same block also runs `hewtd reconcile --changed --check --cached` (3.2.0): it warns about
  staged docs not yet reviewed and blocks only when `reconcile.require_review` is `true`.
  hewtd's own commits (`reconcile --apply`) set `HEWTD_REVIEWED_COMMIT=1` and skip this check; the secrets scan still runs.
  Without the local ledger (fresh clone, CI) a doc counts as unreviewed when it has no `last_verified`, has
  uncommitted changes, or was committed after its `last_verified` day (a same-day edit is not caught).
  `hooks install` upgrades an older block of ours in place; `uninstall` removes either version.
  Since 3.3.0 it also adds marked `post-merge` and `post-checkout` blocks running `hewtd graph --quiet` (never fails git, skips single-file checkouts), same upgrade-in-place and uninstall rules.
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

## integrate hands the new doc to reconcile (#98)

integrate copies the source (the original stays, unless it already sits at the target and is rewritten in place; a different doc already at the target is never overwritten, even with `--force`), then prints the new doc's reconcile
lane, each missing or unverified reference and the next step
(`/hit-em-with-the-docs:reconcile <doc>`). `--review` also writes the review skeleton.
It does not fill `purpose` from the first paragraph (a missing purpose stays missing, so
`audit` warns), and `-d <domain>` gives the doc only that domain plus any its own
frontmatter lists. `templates/doc.template.md` is the starting point for a new doc.

## No backfill

Upgrading hewtd changes no existing doc. Only integrate on a new doc writes
`sources`. See [`indexing.md`](./indexing.md#no-backfill-61).

## Commands that edit a doc rewrite only their own keys (3.1.0)

`fix-retrieval-fields --apply`, `maintain --fix` / `metadata-sync`, `archive` / `unarchive`,
the outside-lane move and `reconcile --apply` change only the frontmatter keys they own.
Bare dates, quoting, comments, flow lists, key order, CRLF and the body stay byte for byte;
an unchanged doc is not rewritten. They no longer re-render the whole block. Internally
`with_frontmatter_keys` removes a key when its value is `undefined`, and `with_frontmatter_data`
diffs a target data object against the file. New-doc writers (integrate, overview draft) still
write a whole block. `parse_frontmatter` now normalizes CRLF in the block before parsing.

## Troubleshooting

### "integrate refused my doc and printed a masked key"
Remove or replace the value. If it is a deliberate public value, run the
`hewtd secrets --baseline-add <file:line> --reason "..."` command it printed.
If the value was real, rotate it.

### "my commit was blocked by hewtd secrets --staged"
Same fix as above, then re-stage. To stop the hook, run `hewtd hooks uninstall`.

### "maintain rewrote my dates or quotes"
Fixed in 3.1.0: only owned keys are rewritten. Upgrade, then `git diff` should show only the keys the command meant to change.

### "my new doc is in the check lane right away"
Expected: integrate never writes `last_verified`. Fix or list (`external_refs`) any
reference it printed, then run `hewtd reconcile --changed --write-review`, judge the entry
and `--apply` it. `hewtd audit` shows `DOCS_UNREVIEWED` until you do.

### "integrate recorded no sources"
The doc cited nothing that resolves to a tracked file, `integrate.sources_max`
is 0, or the project is not a git checkout.
