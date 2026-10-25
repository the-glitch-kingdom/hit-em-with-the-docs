# Changelog

All notable changes to this project will be documented in this file.

## [2.11.0] — 2026-10-25

Three fixes from using hewtd alongside semantic-memory: `archive` no longer
overwrites files (#44), generated indexes no longer link to domain folders that
don't exist (#45), and fact docs can carry plain-string `symptoms:`, the shape
semantic-memory indexes (#46).

### `archive` refuses to overwrite an existing file (#44)

Archiving `README.md` when `archive/README.md` already existed replaced that file
without warning: `git mv -f` overwrote it, and so did the `fs.rename` fallback
used for untracked docs. `archive` and `unarchive` now refuse any existing
destination, naming both paths, in dry runs too. If you were hit by this,
recover with `hewtd unarchive`, `git checkout HEAD -- <archive path>`, then
rename the doc and archive it again.

### Generated indexes link only to domains that exist (#45)

Generated `INDEX.md` / `REGISTRY.md` files linked every registered domain, so a
project using a few of the 15 built-ins got dozens of broken links it couldn't
fix (the files are generated and guarded). Related domains, the root REGISTRY's
quick reference, by-category and common-tasks tables now list only domains with
a folder on disk, and the hardcoded Standards link is gone. A partial scaffold
(`init --domains`) links only the domains it created. On semantic-memory's docs,
the 47 generated broken links drop to 0, and the health score rises with them.
Run `hewtd index` to refresh existing files.

### Plain-string `symptoms:` on facts (#46)

On `tier: fact`, a `symptoms:` entry may now be a plain string: literal error
text for that fact, with no `target` or `cites`. That's the shape semantic-memory
indexes as a search chunk, so the same field now passes both tools. Other tiers
still reject strings, with an error saying only facts may use that form, and
object entries keep their rules everywhere. `cite` no longer crashes on a string
entry; it cites onto the first object entry or appends one.

## [2.10.0] — 2026-10-03

Gotchas found during a working session now have a home: the knowledge base
(#40, first step), with no schema change and nothing to install. Plus seven
fixes from the first real use of the knowledge base in another project (#39).

### Gotchas are recorded as knowledge-base facts before merge

The session brief now states that a command or approach that fails in a
non-obvious way, once a working fix is found, is recorded as a fact under the
vault's `facts/` folder, tagged `gotcha`, with an `## Instead` section and a
`verify_command` where one is possible, and committed before the PR merges.
Typos and simple wrong paths are excluded. Because gotchas use the existing fact
tier plus a tag, `facts/INDEX.md` already groups them.

A line read at session start is weakest at the end of a long session, so the
PreToolUse guard repeats it when it applies: `gh pr create` and `gh pr merge`
get a warning (never a denial). It is matched at command position outside
heredoc bodies, like the deletion check, so a PR body or commit message that
mentions those commands does not trigger it. Merges done outside Claude (GitHub
UI, a terminal) are not covered.

### Knowledge-base fixes from a first real use (#39)

- **The skill and session brief now describe the knowledge base.** Neither
  mentioned it, so an agent asked to "log this in the KB" wrote prose into a
  domain doc. The `documentation-lifecycle` skill has a "Knowledge base" section
  (vault location, the three tiers, the incident → facts → symptoms → audit
  flow), and the brief has one line pointing at it.
- **`docs/` ships in the package.** `README.md` links `docs/LLM-GUIDE.md` and
  `docs/knowledge-base-primitives.md`, but `files` in `package.json` never
  listed `docs`, so the published tarball had none of them.
- **`migrate-incident` writes a real date.** For `incident-2026-09-28-x.md` it
  wrote `date: incident-2` (the first ten characters of the name) and a folder
  named `incident-2026-09-28-x`. The date is now found anywhere in the name and
  the folder is `2026-09-28-x`, matching the `YYYY-MM-DD-<slug>` id convention.
  An undated name takes its date from frontmatter `date:`, then `last_updated`,
  then today; it is never a slice of the name.
- **`integrate` respects a declared domain.** The target folder came only from
  keyword detection, so a doc declaring `domains: [troubleshooting]` could land
  in another folder. The order is now: the new `--domain <id>` flag, then the
  doc's first declared domain, then detection.
- **`archive` no longer counts generated indexes as inbound links.** Rows in the
  root and domain `INDEX.md` / `REGISTRY.md` are rebuilt by the archive's own
  reindex, but they blocked the move, and the only way past was `--force`, which
  also switched the check off for real links. A hand-written sub-feature
  `INDEX.md` still counts.
- **`archive` and `unarchive` accept a project-relative path.**
  `.documentation/api/x.md` was read as relative to the docs folder and reported
  as not found. Project-relative, docs-relative and absolute paths now all work.
- **`audit-facts --run-verify-all`** re-checks every fact that has a
  `verify_command` and exits 1 if any fail (`/hit-em-with-the-docs:audit-facts
  all` in the slash command).

## [2.9.0] — 2026-08-31

Seven issues from the backlog. One new capability — two things that were
hardcoded are now declared in `.claude/hit-em-with-the-docs.json`: the `status`
vocabulary and `docs_root`. The rest are fixes, and four of them share a root
cause worth naming: hewtd was matching **text** where it should have been
matching **structure** — a substring for a shell deletion, a filename shape for
a generated report, a leading-space count for a code block, a YAML schema on one
end of a round-trip and a different one on the other.

### hewtd no longer audits its own generated reports

`audit`, `report`, and `maintain` write their output into `<docs>/reports/`, and
every scan then read it back as documentation. Each generated report carries
`domains: [root]` and an ISO timestamp in its filename, so each one raised a
`metadata-domain` and a `naming-convention` warning. The headline health score
fell as reports accumulated rather than as documentation quality changed — a
team running `maintain` weekly watched its score drop for doing maintenance,
which makes the number useless as a trend line.

Measured on a fresh project before the fix: warnings went 3 → 5 as the reports
directory went 1 → 2 files, and kept climbing. After: flat, regardless of how
many reports have accumulated.

`reports/` now joins `archive/` in the always-applied scan ignores, so `audit`,
`link-check`, `metadata-sync` and the archive scanners all skip it. Zero errors
were ever involved — this was warning noise and a misleading average — so no
previously-reported problem stops being reported.

**Excluded at the docs root only**, unlike `archive/` which is excluded at any
depth. `<docs>/reports/` is the sole place hewtd writes reports
(`join(docsPath, 'reports')`); a `features/reports/` folder is somebody's
documentation *about* reports and stays audited. Assuming a name implied a
generated artifact is precisely the defect
[#19](https://github.com/TheGlitchKing/hit-em-with-the-docs/issues/19) was about.

No `exclude` config key: the report location is not configurable, so a
hardcoded exclusion is exactly symmetric with it.

Closes [#27](https://github.com/TheGlitchKing/hit-em-with-the-docs/issues/27).


### Frontmatter round-trips; date fields survive `--fix`

The read and write paths used two different YAML implementations with different
schemas. `parseFrontmatter()` read via gray-matter's js-yaml **default** schema,
which includes the YAML 1.1 timestamp type; `stringifyFrontmatter()` wrote via
the `yaml` package's **core** schema, which does not. So a quoted
`last_updated: '2026-08-22'` was read as a string, written back **unquoted**,
and re-read as a `Date`. Frontmatter did not round-trip.

Both ends now use the same implementation, so a `Date` can no longer
materialize out of frontmatter at all, and an already-damaged file carrying a
bare date reads back as the string it was meant to be.

Date-shaped values are additionally written **quoted**. Reading is now
internally consistent, so hewtd alone would cope — but frontmatter is a shared
contract, and most YAML readers still default to 1.1, where a bare `2026-08-22`
is a timestamp. Emitting it unquoted hands every other consumer the same bug.

**Full ISO timestamps are now accepted and normalized.**
`last_updated: '2026-04-18T00:00:00.000Z'` was neither accepted nor truncated,
and no `--fix` could resolve it. The schema now truncates a date-time string to
`YYYY-MM-DD`, and `--fix` settles it on disk. Until the engine fix above, these
validated only by accident — written unquoted, re-read as a `Date`, and rescued
by the existing `Date` branch.

`maintain --fix` is now idempotent on date fields: a second run rewrites
nothing.

Scope note for anyone reading the original report: on 2.8.2 the audit failure it
describes no longer occurred, because `dateStringSchema` has coerced `Date` back
to `YYYY-MM-DD` since 2.3.0 (the report quotes a pre-2.3.0 schema and a 2.0.0
CLI). The quote-stripping itself was still real and is what is fixed here.

Closes [#28](https://github.com/TheGlitchKing/hit-em-with-the-docs/issues/28).


### `extractLinks()` understands indented code blocks and CommonMark fences

2.8.2 taught the link scanner about fenced blocks and inline code spans. Two
gaps remained, both surfaced by [#22](https://github.com/TheGlitchKing/hit-em-with-the-docs/pull/22)
from @andrewcb22:

- **Indented code blocks were still scanned**, so a link shown as an example in
  a four-space block was reported as broken — the same defect as
  [#20](https://github.com/TheGlitchKing/hit-em-with-the-docs/issues/20), one
  code shape over.
- **Fence closing was too loose.** Any run of the same marker character closed a
  block regardless of length, and a fence indented four columns was read as a
  fence rather than as code. Per CommonMark a closing fence must be at least as
  long as its opener, and an opener may be indented at most three columns.

Both fixed. Indentation is treated as code only when it is at least four
columns, follows a blank line (indented code cannot interrupt a paragraph), and
is **not inside a list** — inside a list, four columns is ordinary continuation
content, a nested item or a second paragraph. Treating that as code would hide
links that are genuinely broken, which is a worse failure than the one being
fixed: #20 reported links that were not broken; this would hide links that are.

Offsets are still preserved: inline spans are blanked with spaces, so
`startIndex`, `endIndex`, and `lineNumber` stay correct for a real link sharing
a line with a span.


### `metadata-sync --fix` is scoped to the declared documentation root

`--fix` writes the full frontmatter block into every markdown file it finds, and
`--path` accepts any directory. Aimed at a source tree it rewrote unrelated
markdown across a whole repository — infrastructure notes, test fixtures, loose
READMEs — stamping 16 lines of hewtd metadata onto files that are not
documentation. Nothing in the command's name suggests that reach.

The root cause was that **nothing declared where a project's documentation
lives**. The docs root existed only as a per-invocation `--path`, so a safety
check had nothing to consult and could only guess from directory contents.

New `docs_root` in `.claude/hit-em-with-the-docs.json` (default
`.documentation`) is that declaration. `--fix` now refuses to write anywhere
outside it. A tree scaffolded elsewhere still works: a root `INDEX.md` is
accepted as a positive marker, because hewtd is what writes it.

Deciding by declaration rather than by content sniff is the point. An earlier
cut of this fix tested for domain-named folders — which any repository with a
top-level `api/` or `testing/` satisfies by accident. Nothing satisfies a
declaration by accident.

Reads are unrestricted, and so is `--dry-run` — the preview of what `--fix`
would do still works anywhere.

`syncMetadata` gains an optional `projectRoot` (defaults to `process.cwd()`) so
the declaration resolves correctly for callers whose docs tree is not under the
current directory.

Closes [#25](https://github.com/TheGlitchKing/hit-em-with-the-docs/issues/25).

### Lifecycle guard: deletion is matched structurally, not textually

The deletion rule asked two independent questions of the whole Bash command
string — "is `rm` present anywhere" and "is a docs path present anywhere" — and
denied when both were true. Neither asked whether the path was an *operand* of
the deletion, or whether the text sat inside a heredoc body the shell never
executes.

The result was a run of false denials. A commit message that named `git rm
--cached` in prose. An issue body that quoted a deletion next to a docs path —
including, twice, the filing of the bug report about this very behavior. A
scratch-directory cleanup that happened to share a line with an unrelated `[ -f
<doc> ]` existence check. In the session behind #26 the guard fired five times;
every underlying operation was legitimate and every one proceeded by another
route. The protection was pure friction.

This is the same shape as [#19](https://github.com/TheGlitchKing/hit-em-with-the-docs/issues/19):
matching a substring where the structure was the thing that mattered. There the
name `INDEX.md` was taken to imply "generated"; here the presence of `rm`
anywhere in a string was taken to imply "a file is being deleted".

Now denied only when a docs path is an operand of a deletion at command
position. Consequently allowed:

- **Prose that quotes a deletion.** Heredoc bodies are stripped before matching.
- **`git rm --cached`.** It unstages and leaves every file on disk — an index
  operation, not a deletion, and nothing `hewtd archive` substitutes for.
- **An unrelated deletion sharing a line with a docs path.** `rm /tmp/x.md &&
  echo <doc>` is not a docs deletion.
- **`drafts/` and `reports/`.** Scratch space and hewtd's own generated output.
  Not new policy: `core/audit/rules.ts` already exempts exactly these two from
  domain-folder validation.

Genuine deletions still deny, including quoted paths, flag-carrying forms
(`rm -rf`), `unlink`/`shred`, `sudo` and env-assignment prefixes, deletions in
any segment of a compound command, and a deletion following a closed heredoc.

Known ceiling, deliberately accepted: a deletion smuggled through another
command's arguments (`find <docs> -exec rm {} +`, `xargs rm`) is not matched.
The module's header already sets out the calculus — the cost of a false positive
is far higher than the cost of a miss, because a guard people learn to route
around protects nothing.

17 new guard tests. Closes [#21](https://github.com/TheGlitchKing/hit-em-with-the-docs/issues/21)
and [#26](https://github.com/TheGlitchKing/hit-em-with-the-docs/issues/26).


### Project-configurable `status` vocabulary

`status` was validated against a hardcoded four-value enum (`draft|active|
deprecated|archived`). A project with its own long-standing lifecycle words had
no way to declare them, so every one of its docs failed validation — and new
docs scaffolded toward `active` while the corpus stayed on its own vocabulary.
Steady drift, with no single place declaring what this project's statuses are.

Extra values now go in `.claude/hit-em-with-the-docs.json`:

```json
{ "status": ["complete", "current", "in_progress"] }
```

They are honored by `integrate`, `audit`, `metadata-sync`, and the metadata
guide `init` scaffolds.

The list is **additive — it extends the built-ins, it cannot replace them.** The
built-ins are load-bearing rather than stylistic: `archive` writes
`status: archived`, `unarchive` writes `status: active`, the `audit` deprecation
nudge keys on `status: deprecated`, and every generated `INDEX.md`/`REGISTRY.md`
is emitted `status: active`. A replace-mode config would let a project
invalidate hewtd's own output with its own settings, so replace mode does not
exist.

New `core/metadata/status-registry.ts` mirrors the custom-domain registry: a
cached singleton resolving built-ins + config at first use, with
`resetStatusRegistry()` for tests. `DOC_STATUS_VALUES` moves there and is still
re-exported from `core/metadata/schema.ts` — no public API change.

A status outside the active vocabulary is still rejected, and the message now
names both the active set and the file to declare more in. Lifecycle-tracked
tiers (`plan`, `fact`, `incident-narrative`, `incident-facts`) carry their own
per-tier status enums and are untouched.

Closes [#18](https://github.com/TheGlitchKing/hit-em-with-the-docs/issues/18).

### Added

- ESLint config (`.eslintrc.json`) and the CI lint gate restored — `npm run lint`
  had never been able to run. Four findings across 13.6k lines, all benign.
  Closes [#16](https://github.com/TheGlitchKing/hit-em-with-the-docs/issues/16).

## [2.8.2] — 2026-08-08

Bugfix. Three defects that all inflated the broken-link count on documentation
that was **correct** — which is the real cost, because a number that is wrong in
the safe direction trains people to stop reading it.

**`symptoms/INDEX.md` links were project-root-relative.** The generator emitted
`[relPath](relPath + anchor)` where `relPath` is `relative(projectRoot, ...)`,
while writing the file into `<vaultRoot>/symptoms/`. Every href therefore
resolved against *that* directory:

```
emitted : .documentation/devops/grafana-alerts-runbook.md
resolves: .documentation/knowledge-base/symptoms/.documentation/devops/...   broken
correct : ../../devops/grafana-alerts-runbook.md
```

Broken by construction, on a file `maintain` had just written. The label stays
project-relative — it is a stable identifier in the table — and only the href is
computed against the index's own directory. `renderSymptomsIndex(index,
symptomsDir?)` keeps the new argument **optional**, so existing callers are
unaffected.

**`extractLinks()` reported links inside code as broken.** A bare regex ran
line-by-line with no fence or code-span awareness, so `[text](./path.md)` shown
as an *example* was counted. Documentation was penalised for being
documentation. Fenced blocks (``` and `~~~`, any run length) are skipped, and
inline code spans are blanked **with spaces rather than removed**, so
`startIndex` / `endIndex` / `lineNumber` stay correct for a real link sharing a
line with a span.

**`maintain` validated generated output before generating it.** Knowledge-base
index generation ran after the link check, so the checker read the *previous*
run's `symptoms/INDEX.md`. Two consecutive runs on identical inputs reported
different counts, and a generator fix appeared not to work until you ran
`maintain` twice. Moved to Step 1.6, beside the domain-index regeneration it
belongs with.

Measured on a 644-file consumer tree: **34 broken links → 0**, and from a
deliberately stale index, one run now reports 0 where it previously reported 19.

Closes #20, #23.

## [2.8.1] — 2026-07-22

Bugfix. The PreToolUse guard denied every `INDEX.md` / `REGISTRY.md` under the
docs tree, matched on **basename alone** — nothing checked whether hewtd writes
that particular file. It does not write most of them.

hewtd generates exactly two shapes (`core/maintain/orchestrator.ts` joins the
docs path with a single domain segment):

```
<docs>/INDEX.md            <docs>/REGISTRY.md
<docs>/<domain>/INDEX.md   <docs>/<domain>/REGISTRY.md
```

Anything deeper is hand-written prose that merely shares the name — and it was
**uneditable**. The deny is final, and the advice it offered ("change the
documents, then run `hewtd index`") does nothing to a file the indexer has never
touched. Those pages froze with whatever staleness they carried.

Measured in one repo: **11 of 35** `INDEX.md` files sat one level below a domain.
`hewtd index` reported "48 index files written" and left all 11 byte-identical.
One of them was a pricing table naming a price the product does not charge, on
the first page a reader opens in that domain.

The only escape was `enforcement.block_index_edits: false` — global, so it would
have unprotected the 24 genuinely generated files to unblock the 11.

`isGeneratedIndex()` now checks the path, not just the name. The active domain
ids are passed into `evaluate()` via `GuardInput` rather than imported, keeping
`guard.ts` pure; the hook supplies them and seeds the registry with the payload's
`cwd` (`getRegistry()` defaults to `process.cwd()`, which is not necessarily the
project being edited). Absent a list, the rule falls back to "one segment below
the docs root" — correct for every single-segment domain id.

## [2.8.0] — 2026-07-14

Lifecycle enforcement. hewtd's create/update/deprecate/archive policy has
always been enforced at the **CLI boundary** — the archive link guard, `auto:
false`, the frontmatter schema. None of that bound an **agent**. Claude working
in a hewtd-managed repo, with no particular knowledge of hewtd, would happily
`rm` a stale doc, hand-edit a generated `INDEX.md`, or start its own `docs/`
folder. The policy lived in the README, and nothing made anyone read it.

Worse, the agent-facing contract *had* been written — `templates/claude/CLAUDE.md`
stated the whole thing — and was **never installed**. Nothing in the codebase
referenced it. It shipped in the tarball and sat there.

Three layers now, in descending order of strength. Full reference:
[`docs/enforcement.md`](docs/enforcement.md).

### Added

- **A `PreToolUse` guard — the part that is actually binding.** Run by the
  harness rather than the model, so it cannot be reasoned past. It **denies**
  exactly two things, both destructive: hand-editing a generated
  `INDEX.md`/`REGISTRY.md` under the docs tree (it is rebuilt from disk; edits
  are silently discarded — and hand-curated rows are precisely how #12 festered),
  and `rm`/`git rm`/`shred` of a doc under the docs tree (irreversible, and
  `hewtd archive` is the reversible alternative — hewtd's own source contains no
  delete calls anywhere). It **warns**, without blocking, on `status: deprecated`
  without archiving, on starting a rival `docs/` tree, and on a hand-rolled `mv`
  into `archive/` that skips the `archived_from` stamp `unarchive` depends on.
- **Two invariants the guard will not violate.** It runs in *every* session the
  plugin is installed in, including repos with nothing to do with hewtd — so
  (1) **no `.documentation/` tree → it allows everything, instantly and
  silently**, and (2) **any internal error → it allows the call**. It fails open,
  unconditionally. A guard that blocks unrelated work because it threw is worse
  than no guard. The warnings are narrow for the same reason: markdown under
  `src/`, a subpackage `README.md`, a test fixture, a website's own docs — none
  of them trigger anything. A noisy guard is a guard people switch off.
- **An `enforcement` config block**, because a guard nobody can disable is a
  guard people uninstall the plugin to escape:
  ```json
  { "enforcement": { "block_index_edits": true, "block_doc_deletion": true } }
  ```
  Both default `true`; disabling one leaves the other active.
- **A `SessionStart` lifecycle brief.** A compact description of how the tree
  works, injected **only when the project has a `.documentation/` tree**. It
  writes no files — and deliberately does **not** create or modify `CLAUDE.md`,
  which is yours and which you almost certainly already have. Phrased as a
  statement of fact rather than instructions, since imperative injected text can
  trip Claude's prompt-injection defenses.
- **A model-invocable skill** (`skills/documentation-lifecycle/`). Claude now
  reaches for hewtd's commands on its own when asked to write or retire a doc,
  instead of needing `/hit-em-with-the-docs:help` invoked first. `link-skills.js`
  previously linked *no* skills (`skillsDir: null` — its own comment said "ships
  no bundled skills"); it now links this one for npm installs, and plugin
  installs pick it up from `skills/`.

### Fixed

- **The archive policy is now explicit and uniform: archived content is
  *referenceable, never concrete*.** Anything under an `archive/` folder — **at
  any depth** — is excluded from every scan: not indexed, not audited, not
  link-checked, not metadata-validated, never counted. It is what the docs *used*
  to say. It stays **referenceable** (link-check validates targets by file
  existence, so a link from an active doc into the archive still resolves and
  history stays reachable), but it is never **concrete** — never evidence of how
  the system behaves today.

  Previously this only half-held. The ignore glob was anchored at the docs root
  (`archive/**`), so `<docs>/archive/` was skipped while `<docs>/features/archive/`
  was **still scanned and validated** — even though 2.7.1's indexer correctly
  ignored it. A nested archived doc could raise audit errors and stale-metadata
  warnings for content nobody was supposed to be reading. The guard also warns when
  an agent edits a file under `archive/`: not destructive, merely pointless, since
  the change lands in a subtree no scan reads and no index lists. Restoring is
  `hewtd unarchive`, not editing in place.

### Removed

- **`templates/claude/CLAUDE.md`** — the orphaned agent contract, never installed
  by any command. Its content now lives where it can actually reach an agent: the
  session brief and the skill.

## [2.7.1] — 2026-07-13

The indexer walks subfolders. Until now `listDomainDocFiles()` did a flat
`readdir` of each domain, so **every document in a subfolder was invisible
to the entire system** — never indexed, never counted, never drift-checked.
In the repository that surfaced this, 215 documents were structurally
absent from every index: `standards/INDEX.md` claimed that domain held two
documents when it held fifty.

> ### ⚠️ Read before upgrading: your first index run will be large
>
> The first `hewtd index` or `hewtd maintain` after this release **adds a row
> for every document that was previously invisible** — several hundred in any
> repo that uses subfolders (215 in the tree that surfaced this, taking its
> root index from 160 rows to 369). This is correct: those documents were always
> supposed to be indexed. But it is a big, surprising diff, so preview it first:
>
> ```bash
> hewtd index --dry-run
> ```
>
> Nothing under `archive/`, `drafts/`, `reports/`, or the vault's generated
> subtrees is in that diff. And if you worked around this bug by hand-curating
> root-index rows that point into subfolders, **delete them** — those documents
> are generated for you now. See [docs/indexing.md](docs/indexing.md).

This was not merely a missing-rows bug. `hewtd index`/`maintain` regenerate the
root INDEX **from disk**, so regeneration actively **deleted** hand-curated
root-index entries pointing into subfolders — a user running `maintain` in good
faith would commit that deletion. The practical rule in any repo with subfolders
became "curate the index by hand and never run the indexer," which is backwards.
Fixing that is why this is a bug fix and not a feature.

### Fixed

- **The domain walk is recursive** (`listDomainDocFiles`). Documents at any
  depth are now indexed, as domain-relative POSIX subpaths: `standards/backend/foo.md`
  appears in `standards/INDEX.md` as `backend/foo.md` and in the root `INDEX.md`
  as `standards/backend/foo.md`.
- **Two more consumers silently shared the same blind spot**, and both are fixed
  by the same change. The **`index-drift` audit rule** compared `INDEX.md` against
  a document list produced by the *same* flat function — so drift on a nested doc
  was undetectable **by construction**, which is how this rotted unnoticed. It now
  reports them (`standards/INDEX.md lists 2 of 50 document(s)`). The **`domain remove`
  orphan count** likewise undercounted by the same set.
- **Title fallback takes the basename.** A nested document with no frontmatter
  `title` now renders as "Entity Schema Contract", not "Backend/entity Schema Contract".
- **A malformed frontmatter block no longer aborts the run.** `gray-matter` throws
  on bad YAML, and a broken *nested* doc could previously sit unnoticed for months
  because nothing ever read it. Now that the walk reaches it, one bad file would have
  killed `index`/`maintain` for the whole project with a stack trace. Such a document
  is now indexed anyway — with a filename-derived title and a warning naming the file
  and the YAML error. It stays findable; skipping it silently would have recreated
  the very bug being fixed.

### Added

- **`hewtd index --dry-run`** — preview without writing. Prints the per-domain
  count with the delta against what each `INDEX.md` lists today
  (`features  164 documents  (+157 not currently listed)`) and a total. Added
  specifically so the one-time upgrade diff above is something you *look at*
  before it lands, rather than something you discover in `git diff`.
- **[`docs/indexing.md`](docs/indexing.md)** — the indexing contract, which did not
  exist before and whose absence is part of why this bug survived: what is indexed,
  what never is *and why*, where the behavior lives in the code, and a
  symptom-indexed troubleshooting ladder ("a doc I wrote is missing from the index",
  "`hewtd index` deleted rows from my root INDEX", "my index grew by hundreds of rows").

### Exclusions — now explicit, because the deeper walk can reach them

A flat scan physically could not descend into `archive/` or a vendored doc tree, so
those exclusions held **by accident**. The moment the walk goes deep, that accident
stops holding. Excluded by path segment, at any depth: `archive/`, `drafts/`,
`reports/`, `_templates/`, `node_modules/`, and a nested `.documentation/`. A nested
`INDEX.md`/`REGISTRY.md` is matched by basename and never treated as a document.

**And the vault.** `facts/`, `incidents/`, and `symptoms/` under `vault.root` are
withheld from the generic domain index. Projects commonly register `knowledge-base`
as a domain *and* as the vault root; without this, a recursive walk would sweep every
fact and incident narrative into a generic INDEX — indexed a second time, and rendered
as if they were ordinary guides. The exclusion is scoped to those three
generator-owned subtrees, not the whole vault, so a `knowledge-base/README.md` stays
indexed exactly as it always was and this release **only ever adds rows**.

Fixes [#12](https://github.com/TheGlitchKing/hit-em-with-the-docs/issues/12).

## [2.7.0] — 2026-06-08

The archival process. 2.6.0 shipped `archive/` as a passive folder
convention — you moved files into it by hand and hewtd politely ignored
the subtree. 2.7.0 turns that folder into an actual workflow: a command
to retire a doc (and one to bring it back), an advisory detector that
surfaces archive candidates, a config block to tune it, and an audit
nudge that finally makes `status: deprecated` mean something. Minor,
additive release: no existing behavior changes, the `archive/` exclusion
is unchanged, and the new frontmatter fields are optional.

Two principles shape the whole feature. **Propose, don't impose** —
detection is advisory, a human always executes the move, and nothing is
ever auto-archived (`auto: false` by default). **Reversible and
link-safe** — archiving records where a doc came from so restore is
lossless, and a link guard prevents silently breaking the active corpus.
And a deliberate non-feature: hewtd does **not** archive on
access-recency (it has no read telemetry) or on age alone. Docs aren't
code — an unchanged foundational doc is usually the most important one,
not the most disposable — so the only recency signal is git-last-touched,
and even that is advisory and gated behind "also orphaned."

### Added

- **`hewtd archive <file>` — retire a doc, non-destructively and
  reversibly.** Moves the doc into `archive/<same-domain-subpath>/` (so
  `api/old.md` → `archive/api/old.md`), stamps lifecycle frontmatter
  (`status: archived`, `archived_on`, `archived_from`, and
  `archived_reason` when `-r/--reason` is given), and regenerates the
  indexes so the doc cleanly drops out of its domain INDEX. Prefers
  `git mv` to preserve history; falls back to a plain move outside a git
  repo. **Link guard:** refuses by default if active docs still link to
  the target — it reports each offending link so you can fix them first —
  and `--force` overrides (the inbound links then become dangling).
  `--dry-run` previews without moving anything.
- **`hewtd unarchive <file>` — the lossless reverse.** Restores the doc to
  the path recorded in `archived_from`, sets `status: active`, and strips
  the `archived_*` fields. Refuses if the restore target already exists, so
  it never clobbers a doc you've since recreated. `--dry-run` previews.
- **`hewtd archive-candidates` — advisory, read-only detection.** Lists
  docs that may warrant archiving, each with a score and the reasons
  behind it; it never moves anything. Signals, ranked: `status:
  deprecated` and `superseded_by:` are strong explicit signals and each
  qualify a doc on their own; orphaned (zero inbound links) and stale
  (git-last-touched, or `last_updated` as a fallback when git is
  unavailable, older than the threshold) are weaker — and **age only
  counts when the doc is also orphaned**, never on its own. `--json` for
  machine-readable output.
- **`archive` config block** in `.claude/hit-em-with-the-docs.json`, with
  four optional keys and conservative defaults: `honor_status_deprecated`
  (default `true` — treat `status: deprecated` as a candidate signal),
  `candidate_after_days` (default `365` — the staleness threshold),
  `require_orphaned` (default `true` — gate the age signal behind "also
  orphaned"), and `auto` (default `false` — nothing is ever
  auto-archived).
- **New lifecycle frontmatter fields** recognized by the schema:
  `superseded_by` (set by hand to point at the replacing doc), and the
  archive-stamped `archived_on`, `archived_from`, and `archived_reason`.
  These validate on active docs (`superseded_by`, `status: deprecated`)
  and on archived docs alike.
- **`deprecated-not-archived` audit nudge.** A doc left at `status:
  deprecated` while still sitting in an active domain folder now raises an
  INFO audit issue suggesting `hewtd archive <file>`. `status: deprecated`
  and archiving are different steps — `deprecated` flags intent while
  keeping a doc live and indexed; `archive` physically retires it — and
  this nudge is what finally makes `status: deprecated` actionable instead
  of a dead-end label.

## [2.6.0] — 2026-06-08

Runtime custom domains. The 15 built-in domains are no longer the whole
story — projects can now register their own documentation domains at
runtime, without recompiling, via a new `hewtd domain` command and a
`domains: []` block in `.claude/hit-em-with-the-docs.json`. Minor,
additive release: the built-in domains are unchanged and remain part of
the compiled contract, and the `src/index.ts` exports are additive.

### Added

- **Custom domains via `hewtd domain add | remove | list`.** Beyond the
  15 built-ins, a project can declare its own domains. Each entry lives in
  `.claude/hit-em-with-the-docs.json` under a new `domains: []` array with
  fields `id` (kebab-case), `name`, `description`, `keywords` (≥1),
  `loadPriority` (1-10), and `category` (`core | development | features |
  advanced`). Once registered, a custom domain is valid in any doc's
  `domains:` frontmatter and its `keywords` feed `integrate`'s
  auto-classification, exactly like a built-in.
  - `hewtd domain list [--json]` — lists built-in + custom domains,
    partitioned and marked by kind.
  - `hewtd domain add <id> -k <comma,keywords> [-n name] [-d desc] [-c
    category] [--load-priority N] [--dry-run]` — validates strictly,
    writes the config entry, scaffolds `.documentation/<id>/` with
    INDEX.md/REGISTRY.md, and refreshes the root indexes. Keywords are
    REQUIRED (they're what makes the new domain discoverable to
    `integrate`). `--dry-run` prints the proposed entry + folder without
    writing. Guardrails: a built-in id, a duplicate custom id, a
    non-kebab-case id, empty keywords, or a bad category are all rejected
    with a hard error.
  - `hewtd domain remove <id>` (alias `rm`) `[--dry-run]` — removes the
    custom entry from config. **Non-destructive**: it never deletes the
    folder or the docs inside it. Any docs in `.documentation/<id>/` are
    reported as *orphaned* (left on disk, no longer a recognized domain).
    Refuses to remove a built-in domain — those are part of the compiled
    contract and always present.
- **`/hit-em-with-the-docs:domain` slash command.** A thin wrapper over
  the CLI that adds the confirm dance these mutating operations need: `add`
  previews via `--dry-run` and asks before applying (and prompts for the
  required keywords if missing); `remove` reports the orphaned-doc count
  and only applies on explicit confirmation.
- **Reserved `archive/` folder for deprecated docs.** `<docs>/archive/` is
  the parking lot for retired documentation — move a doc here instead of
  deleting it. hewtd **actively excludes** the entire `archive/` subtree
  from every scan: `audit`, `link-check`, `metadata-sync`, `integrate`
  duplicate-detection, the link graph, and `search`. Archived docs are not
  validated, never appear in any INDEX.md/REGISTRY.md, and can't break
  audit/link-check with stale frontmatter. `init` now scaffolds `archive/`
  with a README documenting the convention, and `archive` is a reserved
  name (`hewtd domain add archive` is rejected).

### Fixed

- **`loadPluginConfigSync` no longer silently falls back to defaults in
  the published package.** The sync config reader used a lazy
  `require('fs')` inside the function, which throws `require is not
  defined` in the ESM runtime the package ships as. The throw was caught
  by the fail-open `try/catch`, so every synchronous config read returned
  defaults — `vault.*` overrides and any `domains: []` entries read on the
  sync path were silently ignored regardless of what was in
  `.claude/hit-em-with-the-docs.json`. It now uses a static
  `import { readFileSync } from 'fs'`, so the sync reader actually reads
  the file. (The async `loadPluginConfig` was unaffected — it already used
  a static `fs/promises` import.)

## [2.5.0] — 2026-05-16

INDEX.md / REGISTRY.md regeneration fix. `integrate` and `maintain` now
rebuild the documentation indexes from the documents on disk via the real
generators, instead of a regex-append path that silently failed to register
the first document into any domain. Closes #7. No breaking changes — the
`src/index.ts` exports are additive.

### Fixed

- **`integrate` now registers the first document into a domain.**
  `updateDomainIndex()` could only append a row to an INDEX.md that already
  contained a markdown table. A freshly scaffolded domain INDEX.md has no
  table, so the regex never matched and nothing was written — and the failure
  was swallowed by a bare `catch`, so `integrate` still reported success. The
  first document into every domain was therefore never indexed, and projects
  without CI never got populated INDEX.md/REGISTRY.md files at all. `integrate`
  now regenerates the target domain's INDEX.md/REGISTRY.md (and the root
  indexes) from disk via the real generators, and a regeneration failure
  propagates to the caller instead of being silently swallowed. (#7)

### Added

- **`hewtd index` (alias `reindex`)** — regenerates every domain + root
  INDEX.md/REGISTRY.md from the documents on disk. `--domain <name>` restricts
  domain-file writes to one domain (root indexes are still refreshed). This is
  the recovery command `index-generator.ts` already pointed users to — it now
  exists.
- **`maintain` self-heals indexes.** A new "Step 1.5: Index Regeneration" step
  rebuilds all domain + root INDEX.md/REGISTRY.md on every `maintain` run, so
  the indexes never drift from the documents present. It also recreates any
  INDEX.md/REGISTRY.md that the domain-health check reported as missing. Runs
  in quick mode too.
- **`audit` INDEX.md drift detection.** A new `index-drift` rule flags any
  document on disk that its domain's INDEX.md fails to list (and a missing
  INDEX.md when documents are present). It is error-severity, so `audit
  --strict` gates CI on it; `failedFiles` is unchanged, so a plain `audit`
  exit code keeps its pre-2.5.0 behavior.
- **`regenerateIndexes()` / `listDomainDocFiles()`** exported from
  `src/index.ts` — the shared, single-source-of-truth index builder used by
  `integrate`, `maintain`, the `index` command, and the drift audit.

## [2.4.0] — 2026-05-15

Bug fix + recovery command for the 2.3.0 `migrate-incident` target-path
issue. No breaking changes to the public API (`src/index.ts` exports
unchanged). New CLI command `hewtd fix-legacy-layout` unblocks any
consumer who already ran the buggy 2.3.0 migrator.

### Fixed

- **`migrate-incident` now writes to `<vault-root>/incidents/<slug>/`**
  (the canonical location the `incidents/INDEX.md` generator scans).
  Previously, the target was derived from the flat file's parent
  directory, which produced folders OUTSIDE `<vault-root>/incidents/`
  when the source lived at the vault root. The `incidents/INDEX.md`
  generator missed those folders silently — `hewtd maintain` would
  report `Generated 0 incidents` despite multiple migrations having
  run. Discovered in real-world use (4 migrations in the investorhub
  repo on 2026-05-14, all required a manual `mv` to populate the
  index).

### Added

- **`hewtd fix-legacy-layout`** — relocates 2.3.0-buggy incident folders
  into `<vault-root>/incidents/`. Detects legacy folders by walking one
  level under the vault root and matching folders that:
    1. Contain a valid `narrative.md`
    2. Have `tier: incident-narrative` in frontmatter
    3. Are NOT already under `incidents/`, `facts/`, or `symptoms/`

  Moves each into `<vault-root>/incidents/<slug>/`. Refuses to clobber
  an existing canonical folder (reports `skipped` with reason). Also
  rewrites `provenance:` references in `<vault-root>/facts/*.md` that
  pointed at the moved folders (handles both fully-qualified paths
  like `.documentation/knowledge-base/<slug>/` and bare-slug refs).
  Idempotent — re-running on a clean vault is a no-op. Supports
  `--dry-run` for safe preview.

- **`migrate-incident --force`** flag. When a folder already exists at
  the canonical or legacy location, the default behavior is to no-op
  with a warning. `--force` overrides and proceeds (overwrites).

- **`migrate-incident` legacy-detection feedback.** When an
  already-migrated folder is detected at the 2.3.0-buggy location, the
  CLI surfaces it explicitly and suggests running `fix-legacy-layout`:

  ```
  Already migrated.
    Existing folder is at the 2.3.0 legacy location: .../foo/narrative.md
    Run `hewtd fix-legacy-layout` to relocate it under incidents/.
    Use --force to re-migrate (overwrites).
  ```

### Internal API

- `migrateIncident()` now **requires** an explicit `vaultRoot`
  parameter. The 2.3.0 signature inferred the target from
  `dirname(flatFilePath)`, which was the source of the bug. This is a
  breaking change to the unexported `core/knowledge-base/migrate.ts`
  surface, but `migrate.ts` was never re-exported via `src/index.ts`,
  so no public-API consumers are affected.

- New `fixLegacyLayout()` function in
  `core/knowledge-base/fix-legacy-layout.ts`. Not exported from the
  public API surface; called via the CLI command.

### Tests

- **241 passing** (was 230 at 2.3.0; +11 new).
- New: `tests/unit/knowledge-base/fix-legacy-layout.test.ts` — 8 tests
  covering move, no-op, reserved-dir safety, provenance rewrite (both
  fully-qualified and bare-slug refs), dry-run, decoy-tier skip,
  destination-collision refusal.
- Extended: `tests/unit/knowledge-base/migrate.test.ts` — 7 tests
  (was 4), new coverage for canonical target path, automatic
  `incidents/` parent creation, legacy-location idempotency detection,
  and `--force` behavior.

### Migration for consumers stuck on 2.3.0 layout

```bash
# Preview what would move
npx --no @theglitchking/hit-em-with-the-docs fix-legacy-layout --dry-run

# Apply the relocation
npx --no @theglitchking/hit-em-with-the-docs fix-legacy-layout

# Regenerate indexes
npx --no @theglitchking/hit-em-with-the-docs maintain
```

Idempotent — re-running on a clean vault is a no-op with a status
report. Safe to run multiple times.

## [2.3.0] — 2026-05-14

Additive minor release. **No breaking changes.** Existing tiers (guide,
standard, example, reference, admin, plan) validate exactly as they did in
2.2.0. A consumer with no knowledge-base subtree and no `symptoms:` frontmatter
blocks observes zero behavior change.

Full reference: [`docs/knowledge-base-primitives.md`](./docs/knowledge-base-primitives.md).
LLM-targeted onboarding: [`docs/LLM-GUIDE.md`](./docs/LLM-GUIDE.md).

Test coverage: **230 passing** (was 134 at 2.2.0; +96 new tests).

### Added

- **Three new tiers** for knowledge-base authoring:
  - `fact` — atomic, single-claim, citable unit with `confidence`,
    `last_verified`, optional `verify_command`, and `provenance`.
  - `incident-narrative` — immutable postmortem story; required fields
    include `date`, `severity` enum, `resolution_status` enum, and
    `components`.
  - `incident-facts` — bridge document linking an incident to the facts it
    produced/strengthened/weakened.
- **Optional `symptoms:` frontmatter field** on any tier. Maps alert names
  (exact), user phrases (fuzzy substring), and error patterns (regex) to
  playbook anchors with `cites:` to facts.
- **`LIFECYCLE_TRACKED_TIERS` constant** + `isLifecycleTrackedTier()` helper.
  Lists tiers that use status/last_verified instead of semver. Currently:
  `plan` (from 2.2.0) + `fact` + `incident-narrative` + `incident-facts`.
- **Coded error system** for KB validation. Errors carry a stable
  `KbErrorCode` (e.g. `FACT_MISSING_ID`, `PLAYBOOK_SYMPTOM_DANGLING_CITE`)
  on `AuditIssue.code`, letting tooling switch on specific violation kinds
  without substring-matching prose. See `src/core/metadata/errors.ts`.
- **`hewtd audit --strict` flag.** Exits non-zero on any error or warning
  (including KB warnings like `FACT_VERIFY_COMMAND_MULTILINE_SHEBANG`).
  Suitable for CI gating.
- **`validateKnowledgeBaseFields(data)` public API** for callers that want
  KB-only validation without running the full schema (useful for incremental
  validation in editors, generators, and the audit layer itself).
- **Four LLM-referenceable templates** at `templates/knowledge-base/` —
  `fact.template.md`, `incident-narrative.template.md`,
  `incident-facts.template.md`, and `playbook-symptoms.template.md`
  (frontmatter snippet). Bundled in the npm package.
- **Full reference doc** at `docs/knowledge-base-primitives.md`.

### Changed

- **Date-shaped frontmatter fields** (`last_updated`, `last_validated`,
  `last_verified`, `date`) now accept both quoted YYYY-MM-DD strings and
  YAML-auto-parsed `Date` objects (unquoted `2026-05-14` in YAML). The
  validator normalizes to string. This relaxation is universal — existing
  tiers benefit too. No previously-passing doc fails under the new rules.
- **`audit`'s "invalid tier" suggestion** now lists all current tiers
  dynamically from `TIERS` (was hardcoded to the original 5, missing the
  2.2.0 `plan` tier).

### Backward compatibility

- Consumers with no `knowledge-base/` and no `symptoms:` blocks: zero
  behavior change.
- `REQUIRED_FIELDS` length unchanged (6). The KB-tier-specific required
  fields are tracked separately in `TIER_REQUIRED_EXTENSIONS` and surfaced
  via the tier-aware `getMissingRequiredFields(data)`.
- `ALL_METADATA_FIELDS` length unchanged (21). KB extension fields (`id`,
  `confidence`, `provenance`, etc.) are tier-specific and intentionally
  not in the universal list — adding them would skew completeness calc on
  non-KB docs.

### PR2: Generators + config

- **`vault:` config block** in `.claude/hit-em-with-the-docs.json`:
  `root` (default `.documentation/knowledge-base/`),
  `playbook_paths` (default `[".documentation/**/*.md"]`),
  `audit_window_days` (default 90). Optional with defaults — existing
  configs without a `vault` block continue to work.
- **Three deterministic index generators** wire into `hewtd maintain`
  when a vault root exists:
  - `facts/INDEX.md` — grouped by tag → confidence, sorted by id
  - `incidents/INDEX.md` — chronological desc by date
  - `symptoms/INDEX.md` — grouped by symptom kind (alert_name |
    user_phrase | error_pattern)
- **Citation graph walker** (`src/core/knowledge-base/citers.ts`) exposes
  `buildCiterIndex()`, `findCitersInIndex()`, `citerCount()`. Used by
  the facts-index generator and the new `find-citers` CLI command.
- **Determinism guarantees:** byte-identical output across runs (snapshot
  tests verify), stable sort, no timestamps in generator output, `\n`
  line endings, padded table columns.

### PR3: CLI commands + slash command surface

Five new CLI subcommands. Each is paired with a Claude Code slash command.

- **`hewtd find-citers <fact-id>`** — walks `cites:` and `provenance:`
  edges; prints `{ fact_exists, citers, incidents_produced_in,
  incidents_strengthened_by, incidents_weakened_by }`. `--json` flag.
- **`hewtd audit-facts [--run-verify <fact-id>]`** — lists facts past
  `last_verified + audit_window_days`. `--run-verify` executes the fact's
  `verify_command` and updates `last_verified` on success; on failure,
  preserves the original. CWD: `<vault>/facts/` by default; override via
  `working_dir:` frontmatter field.
- **`hewtd extract-facts <incident-folder> --accept <json>`** — writer
  side of the extraction workflow. The LLM proposes fact specs via the
  `/hit-em-with-the-docs:extract-facts` slash command; the CLI commits
  them deterministically. Auto-populates `provenance:` to the source
  incident folder; updates the incident's `facts.md` `produced:` list
  (idempotent).
- **`hewtd cite <fact-id> --file <playbook>`** — inserts a `cites:` entry
  into the nearest `symptoms:` block, or creates a new block if none
  exists. Idempotent — re-citing the same fact in the same entry is a
  no-op. `--dry-run` to preview.
- **`hewtd migrate-incident <flat-file>`** — converts a legacy flat-file
  incident into the folder form (`narrative.md` + `facts.md` skeleton +
  empty `evidence/`). Original renamed to `.migrated` for rollback.
  Idempotent.

### LLM onboarding

- **`/hit-em-with-the-docs:help`** slash command with optional topic
  argument (`frontmatter | knowledge-base | commands | audit | integrate
  | templates`). Briefs the LLM directly on hewtd's surface.
- **`docs/LLM-GUIDE.md`** — concise (~150 lines) agent-facing reference
  with a decision tree, tier-picking heuristics, KB authoring workflows,
  command tables, and an anti-pattern list.

### Tests

- **230 passing** (was 134 at 2.2.0 baseline; +96 new tests).
- New coverage for: the 3 new tiers, `LIFECYCLE_TRACKED_TIERS`,
  `validateKnowledgeBaseFields` (every error code), date-tolerance, audit
  strict-mode, citation graph, three generators (snapshot + determinism),
  audit-facts, cite, extract-facts, migrate-incident, full pipeline
  integration test.
- Fixture trees at `tests/fixtures/knowledge-base/{valid,invalid}/`.
- Backward-compat regression test at
  `tests/integration/no-vault-backcompat.test.ts` — load-bearing
  guarantee that pre-2.3.0 projects observe zero behavior change.

## [2.1.0] — 2026-04-18

Additive minor release. No breaking changes. Existing behavior is
preserved; the new surface is opt-in and off by default (update policy
defaults to `nudge` — one-line notification when a new version is
available, no automatic changes).

### Added
- Adopts
  [`@theglitchking/claude-plugin-runtime`](https://github.com/TheGlitchKing/claude-plugin-runtime)
  (`^0.1.0`) for standardized update management across all plugins in
  the marketplace.
- **Postinstall step** (`scripts/link-skills.js`) now runs on
  `npm install` — writes a default `.claude/hit-em-with-the-docs.json`
  with `{ "updatePolicy": "nudge" }`, and registers a SessionStart hook
  in `.claude/settings.json` if one exists (skipped when the plugin
  marketplace version is already enabled in `~/.claude/settings.json`,
  or when `HIT_EM_WITH_THE_DOCS_SKIP_HOOK_REGISTER=1` is set).
- **SessionStart hook** (`hooks/session-start.js`) checks npm for a
  newer version of `@theglitchking/hit-em-with-the-docs` at session
  start and acts per policy:
  - `off` — silent, no network call
  - `nudge` *(default)* — prints a one-liner via `additionalContext`
  - `auto` — runs `npm update` and prints an upgrade confirmation
  - 3s network budget, 6h cache, CI-skip, fail-open on any error
- **Four new subcommands** (slash + CLI parity):
  - `/hit-em-with-the-docs:update` / `hewtd update`
  - `/hit-em-with-the-docs:policy [auto|nudge|off]` / `hewtd policy`
  - `/hit-em-with-the-docs:status` / `hewtd status`
  - `/hit-em-with-the-docs:relink` / `hewtd relink`

### Fixed
- `--version` now reads dynamically from `package.json` via
  `createRequire`. Previously hardcoded at `'2.0.0'`, which drifted out
  of sync with `package.json` (caused `hewtd --version` to lie about
  the installed version for all of 2.0.1 / 2.0.2).

### Migration

No action required for existing users — the new behaviors are
conservative and on-by-default only in their minimal form (nudge-only
update check). To take advantage of the new surface:

```bash
# From anywhere in your project:

# View installed version, latest on npm, current policy, and hook state
npx --no @theglitchking/hit-em-with-the-docs status

# Opt into automatic updates on session start
npx --no @theglitchking/hit-em-with-the-docs policy auto

# Or silence the update check entirely
npx --no @theglitchking/hit-em-with-the-docs policy off
```

If you had the plugin installed via the Claude Code marketplace
(`/plugin install`), running `npm install` as a project-level dep will
detect that and skip registering the project-level hook — the
marketplace plugin handles SessionStart events on its own. No duplicate
hook firing.

**Opt-outs** (env vars):

| Variable | Effect |
|---|---|
| `HIT_EM_WITH_THE_DOCS_UPDATE_POLICY` | One-shot policy override for the current session |
| `HIT_EM_WITH_THE_DOCS_SKIP_LINK=1` | Skip skill symlinking (no-op for this plugin — ships no skills) |
| `HIT_EM_WITH_THE_DOCS_SKIP_HOOK_REGISTER=1` | Skip writing the SessionStart hook into `.claude/settings.json` |

---

## [2.0.2] and earlier

See git history:
https://github.com/TheGlitchKing/hit-em-with-the-docs/commits/main
