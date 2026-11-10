# Reconcile: check existing docs against the code (2.15.0, updated in 2.22.0)

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
ledger (a doc triage found `clean` counts as reviewed until its content changes). With no scope and no `--next` the command refuses. It also refuses if
any in-scope `.md` file has uncommitted changes (untracked files count).

```bash
hewtd reconcile security --json            # triage a domain
hewtd reconcile --next 20 --json           # resume from the ledger
hewtd reconcile security --write-review    # write review-file skeletons
hewtd reconcile --apply .hewtd/reconcile/review-1-1.md
hewtd reconcile --status [--next 10]       # ledger progress
hewtd reconcile --outside [--write-review] # docs outside the docs root
hewtd reconcile --secrets [scope] [--json] # masked secret scan (2.17.0)
hewtd reconcile --overview "<question>" [--limit N] [--json]  # seed an overview (2.18.0)
hewtd reconcile --write-review --overview <members-file>      # overview review skeleton
```

Flags: `-p/--docs-path`, `--json`, `--serial`, `--team`, `--batch <id>`.

## Lanes

Triage sorts each doc by deterministic checks of what the body cites (paths,
symbols, env vars, `npm`/`npx`/`make` commands, tables and columns, internal
doc links), resolved against `git ls-files`, one batched `git grep`,
`package.json`, the Makefile and parsed schema sources.

| Lane | Meaning |
|---|---|
| `clean` | Already carries `sources` and `last_verified`, nothing missing (a `sources` path that no longer exists counts as missing). |
| `fields-only` | Only frontmatter fields are missing. |
| `check` | Needs the judgment pass. |
| `secret` | The doc, or a file it cites, holds a secret. Blocked: never judged, in no shard (2.17.0). |
| `archive-candidate` | Cited things are missing. Only `missing` counts; `unknown` is neutral. |

Staleness (commits touching the cited paths since the doc's last body change)
raises priority only. The body-change point is the oldest of the consecutive
latest commits whose body (frontmatter stripped) equals the current body, so
frontmatter-only commits, such as a `last_verified` stamp, do not reset it
(walk capped at 50 commits). In a shallow clone it is `unknown` and triage warns. It is never
used to write `last_verified`.

## Secrets first (2.17.0)

Reconcile looks for secrets before it judges anything, so no model ever sees one.

```bash
hewtd reconcile --secrets [scope] [--json]
```

- **What is detected**: private-key blocks, Anthropic/OpenAI/AWS/Stripe/GitHub/
  Slack/Google/Vault keys and tokens, Azure connection strings, JWTs,
  `user:password@` URLs and generic `secret = "..."` assignments. Emails are
  `personal` kind: reported for review, never blocking. Since 2.22.0 it also
  finds short `hvs.`/`hvb.` Vault tokens (16+ chars after the prefix), AppRole
  ids (`approle-id`: a UUID after `--role-id`, `--secret-id`, `role_id`,
  `secret_id`, `Role ID` or `Secret ID`) and values in `vault kv put` /
  `vault write` lines (`vault-kv-value`: key=value with 16+ chars, high entropy,
  not a placeholder, path, URL, code expression or `@file`). A kv key named
  like a secret (`password=`) reports as `generic-secret`. Turn the new rules
  off with `disabled_rules` ids `approle-id` and `vault-kv-value`.
- **Not secrets (2.22.0)**: `generic-secret` ignores values built from words, not
  random characters: dotted identifier chains such as `self.vault_token` or
  `settings.VAULT_TOKEN`, calls such as `get_secret(`, `{name}` template slots
  around weak text, email values (`admin@company.io`, still reported as a
  `personal` finding that never blocks) and pointer records (`<NAME from Vault: ...>`
  with a closing `>` on the line). A value with random characters is still a
  secret, even with a `.`, `(`, `{x}`, `<` or `@` in it.
- **Scope**: with a scope, only those docs. With none, the docs root, `archive/`,
  tracked `*.md` outside the docs root and all of `.hewtd/`. Archive, outside and
  `.hewtd/` hits are reported, never judged.
- **Output is masked**: `rule file:line first4...length` plus a fingerprint
  prefix, e.g. `vault-token docs/ops.md:12 hvs....28`. `--json` prints masked
  findings only. A value is never printed, logged or passed through argv or temp files.
- **Placeholders** such as `XXXX`, `<token>`, `${VAR}`, `changeme` and
  `example` are ignored. Since 3.1.0 so are values made of ascending runs: when
  runs of 3 or more consecutive ascending letters or digits (`abc`, `123`, `ABCDEF`)
  cover at least half of a value's letters and digits (`abc123def456ghi789jkl`,
  a Stripe-style test key whose body is `ABCDEF…1234567890`), it is a placeholder. A random key holding one
  short run by chance is still found. A `url-password` under 8 characters, or one of `pass`,
  `password`, `changeme`, `secret`, `admin`, `root`, `postgres`, `user`, `test`,
  `dev`, `example` (any case), is not a finding. `generic-secret` skips values
  that look like a regex (a character class with a quantifier, `\d` `\w` `\s`,
  `.*`, `.+`, `^...$`) when what remains without that syntax is not itself a strong
  value, so `^[A-Za-z0-9]{32}$` is skipped but a random secret containing `.*` is
  not. Real values (`hvs.` tokens, long url passwords) are still found.
- **Literals only (3.1.1)**: `generic-secret` reports literal values. Each exemption
  below excuses only words or runs, never random characters: a part counts as random
  when it is not made of words (the word test below).
  - **Bare values (3.1.2)**: a value with no `.`, `(` or `[` is code only when shaped like
    an identifier: two or more word humps (camelCase, snake_case, UPPER_SNAKE) with digits
    only as one trailing group of up to three (`minLengthRequirement12`,
    `VAULT_TOKEN_FROM_ENVIRONMENT`). A single run of letters, or digits between humps, is a
    value, because generated pronounceable passwords look exactly like that.
  - **Identifier-shaped code and markup (3.1.4)**: `is_identifier_shaped` in
    `src/core/reconcile/secrets.ts` checks the shape of structured values (member access,
    call, index, CSS functions), and `is_code_words` checks that their tokens read as
    words, with one exception per value: a short lowercase name that is called or accessed
    (`utcnow()`, `hsl(`, `b64decode(`), or one short part of a name next to common config
    words (`qdrant` in `qdrant_api_key`, `kv` in `vault_kv`). So `datetime.utcnow()`,
    `settings.qdrant_api_key` and `hsl(var(--x))` are skipped. A markdown link
    `[text](url-or-path)` is skipped when its text and target both pass the same check (a
    random query, path or fragment is still reported), and a value with `$NAME` or
    `${NAME}` references is skipped when nothing random remains after removing the
    references and regex syntax. A long single-case run with high entropy counts as random
    even when it passes the word test. Bare values keep the 3.1.2 rule.
  - **Word test (3.1.2)**: `is_word_like(token)` in `src/core/reconcile/secrets.ts`
    splits a token on non-alphanumerics, cuts each piece into humps
    (`openAIApiKey` is `open`, `AI`, `Api`, `Key`; `LLMProviderKey` is `LLM`, `Provider`,
    `Key`) and judges every hump on its own, so acronyms and camelCase are words and
    consonants are never counted across a hump. A hump passes with a vowel (`y` counts),
    no run of five consonants, and no consonant pair English lacks; a short list of
    vowel-less abbreviations (`http`, `css`, `cidr`) also passes. Acronyms of 1-2 letters
    are fine; 3-5 letter all-caps humps need a vowel or a listed abbreviation; longer
    acronyms pass only as a whole piece (`VAULT_TOKEN_FROM_ENVIRONMENT`), not glued
    mid-token. Digits are up to four and mostly follow a word (`Http2Response`,
    `acme2go`, `v1.15` pass; `ypap7nhi` does not). The code, wrapped-contents, prefix-tail,
    regex-remainder, email-part and pointer-record exemptions all use this one test, and
    wrapped contents are judged piece by piece. So `settings.openAIApiKey`, `getAPIKey(provider)`,
    `LLMProviderKey`, `minLengthRequirement12` and `<token-from-init>` are not findings,
    while random values in the same positions still are. On a corpus of 3186 real
    identifiers the test passes 99.1% (the 3.1.1 test passed 78.2%).
  - Known limits: there is no word list, so a random letters-only run that reads like a
    word can pass. About 0.9% of real names are rejected (hump runs of 5+ consonants such
    as `Fullscreen`, digit-heavy names such as `ed25519`, a few acronym-glued names such as
    `JSDOMOptions`). Word-likeness only decides exemption from `generic-secret`, so such a
    name is reported, not hidden; allowlist it if it is a false positive.
  - **Code**: member access, optional chaining, calls or indexing
    (`req.headers.authorization?.split(" ")[1]`, `hash(password)`) where every token
    is a word, a word with version digits (`sha256`, `b64decode`) or a short number,
    and at least one is a word of 4+ letters.
  - **Wrapped placeholders**: `[..]`, `<..>`, `${..}`, `{{..}}`, `$(..)` and `%(..)s`,
    only for the free-text rules (`generic-secret`, `url-password`, `vault-kv-value`),
    and only when the contents are not random (`[code-from-the-authenticator-app]`
    is skipped, brackets around a random string are not).
  - **Regexes**: metacharacters make up at least 25% of the value with nothing random
    left once the regex syntax is removed, or the 3.1.0 strip rule above applies.
  - **Placeholder prefixes**: `abc123`, `123456`, `abcdef` or `qwerty` followed by
    nothing, a short tail, more ascending runs or a separated word (`_your_key`),
    again for the free-text rules only. Random characters after the prefix are a value.
  - **Emails**: a well-formed address under a secret-named key is a `personal` finding
    and never blocks, unless a local segment or domain label looks random (12+
    characters with entropy of 3.3 or more, 8+ characters not made of words, 6+
    characters with an inner capital not made of words);
    then it stays `generic-secret`. Digit-bearing emails such as a name with a year
    are `personal`, and a doc with only such values is not in the secret lane.
  - Known limit: a very short random token (3 letters) or a letters-only random run
    shaped like camelCase can read as a word; measured at under 1% of random samples.
    The strong rules (`vault-token`, `approle-id`, key prefixes) are never excused.
- **Allowlist**: `reconcile.secrets.allow` is a list of
  `{ "fingerprint" | "pattern", "file"?, "reason" }`. `reason` is required;
  `file` is an exact path or glob. `reconcile.secrets.disabled_rules` turns
  rules off by id. Invalid entries are dropped with a warning.
- **The `secret` lane**: a doc with its own secret, or one citing a file with
  one, goes in this lane with masked reasons. It is in no judgment shard (team
  mode too). The flagged cited file is listed in `blocked_files` and dropped
  from `cited`. **Weak hits in cited code (2.22.0)**: a cited non-markdown file
  whose findings are all `generic-secret` or `url-password` is withheld, not
  blocking: it leaves `cited`, is listed in `blocked_files`, and the doc gets the
  reason `cited file withheld: <file> (<masked>)` but keeps its normal lane. A
  cited file with any other secret rule still puts the doc in the secret lane
  (`cited file blocked`). **Linked docs are withheld (3.1.0)**: a cited `.md` or
  `.mdx` file with findings is always listed in `blocked_files` with the reason
  `cited file withheld: <path> (<masked>)` and never puts the citing doc in the
  secret lane, so a secret does not spread through doc links. Only the doc's own
  findings, or a known-shape finding in a cited code file, set the lane.
  Related-repo cited files follow the same rule.
- **The `secret` verdict**: `--write-review` proposes it with a masked entry per
  finding. On accept, `--apply` appends each value to `.env.hewtd` (mode 0600,
  git-ignored first) and replaces it with a pointer,
  `<secret: HEWTD_SECRET_NAME, see .env.hewtd>`. The name is the assignment name
  on that line, else `rule_docslug`. The ledger keeps `env_names` only. A
  failure rolls back the doc, `.env.hewtd` and `.gitignore`.
- **Report**: every `--secrets` run, and any apply that moved values, writes
  `.hewtd/reconcile/secrets-report-<date>.md` (masked; a history yes/no per
  finding; personal data in its own review-only section).
- **Next steps** (the report lists them): rotate the secret; put the new value in
  the real secret store and delete its `.env.hewtd` line; if it was ever
  committed, git history still holds it, so purge with `git filter-repo` if
  you need to; then reindex.
- **Write-time guards (2.19.0)**: integrate refuses secrets, `hewtd secrets --staged` and an opt-in pre-commit hook check new commits, and accepted findings live in the committed `.hewtd/secrets-baseline.json` (fingerprints only, merged into `allow`). See [`write-time-guards.md`](./write-time-guards.md).
- **Guarantees**: every write (review files, ledger, apply entries, the staged
  diff, the report) is checked first. A hit in the staged diff rolls the whole
  batch back.

## Reference statuses

Each cited thing resolves to `ok`, `missing` or `unknown`. Only `missing`
pushes a doc toward `archive-candidate`; `unknown` is neutral.

- Scripts are collected from every tracked `package.json`, not just the root.
- `unknown` (never `missing`): a link or path that leaves the project root
  (including a leading-slash path), a host-like URL that does not resolve in the
  repo (`example.com/docs/x`), a name that no code defines but another doc also
  mentions (an external name; the citing doc's own mention does not count), and a reference into a related repo that is not checked out.
- Not checkable (3.1.6, `unknown`, so never `missing` and not counted as checkable):
  - a path ref listed in the doc's frontmatter `external_refs: [..]` (exact text as cited);
  - a path ref that would be missing but is covered by `.gitignore` (build output, `.claude/*`, `.planning/*`), found with one batched `git check-ignore`;
  - placeholders (a `YYYY` date run such as `YYYYMMDD_name.py`, `...` or `…` segments, `<x>`, `{x}`, `*`, `?` shapes) and regexes (a `^` or backslash), which are not extracted as path refs. A lone `MM` or `DD` can be a real file name and is still checked;
  - a missing `secret/...` path (a secret-store KV path), unless the repo has a tracked `secret/` folder; then it is checked like any path.
- `./` and `../` paths resolve from the doc's own folder first, then the repo root. This also covers a path written as a link's text, such as ``[`../auth/x.md`](../auth/x.md)``; link text is still checked, so a broken target is still reported.
- An env ref is missing only when neither `NAME` nor its lowercase form is found in code. The lowercase form counts only in a file that reads settings or the environment (`BaseSettings`, `environ`, `getenv`, `process.env`, `env_prefix`, `Settings`), because pydantic settings read env vars case-insensitively; an unrelated local variable with that name does not count.
- Tables and columns are checked only against `schema_sources`. It defaults to
  `[]`, so nothing is checked until you list globs, for example
  `["**/migrations/**/*.sql", "**/schema.prisma"]`. Triage lists the schema
  files it found (`schemaFiles` in JSON, `schema files:` in text) so you can
  pick the globs.
- Cited bytes and staleness count resolved path references and `sources`
  only, not symbol hits.

## Overviews and one owner per fact (2.18.0)

Two problems this solves: a question that spans several docs has no single page
that answers it, and the same fact is copied into several docs so the copies
drift. Overviews answer the first; merge-then-point answers the second. Both go
through the same review file, `--apply`, ledger and secret guards as every other
verdict.

### Overviews from a question

```bash
hewtd reconcile --overview "how does semantic search retrieve and rank vault documents" --json
```

- Ranks docs across the whole tree with field-weighted BM25 (title, `purpose`,
  `symptoms` weigh 3; headings 2; body 1), expands by linked docs that also
  scored, and keeps at most `--limit` members (default 12). `archive/`,
  `drafts/`, `INDEX`/`REGISTRY`, generated, plan-tier and secret-lane docs are
  skipped, and `sources` is never indexed.
- Optional `reconcile.search_command` (an argv template with `{query}`, split on
  whitespace, run without a shell, 30 s timeout) puts its results first. Only
  paths that are indexed docs are kept. If it fails, reconcile warns and uses BM25.
- Each member is tagged `reconciled`, `unreviewed`, `stale` or `secret` from the
  ledger, and an existing `kind: overview` doc that already covers enough members is reported.
- The only file written is `.hewtd/reconcile/overview-<slug>.json`
  (overwritten on a re-seed of the same question). Search hits can be noise, so
  confirm the member list before going on; drop members by editing that file.
- Members that hold a copy of another member's section carry `duplicates`.

```bash
hewtd reconcile --write-review --overview .hewtd/reconcile/overview-<slug>.json
```

writes a review skeleton with an `overview` entry (`verdict: null`, empty
`draft`, the target in the first member's folder as `overview-<slug>.md`). The
judging step fills `draft` and `frontmatter`, then `--apply`.

The `overview` verdict:

- Applies only when every member is **reconciled**: verdict `verify`, or lane
  `clean`, with a matching content hash. A member that is not yet reconciled needs
  `allow_unreviewed: true` and an `(unreviewed)` mark on its link line. A
  secret-lane member is always refused.
- The target must not exist (`overview target already exists` otherwise).
- The new doc gets `kind: overview` and no `last_validated`. The ledger entry stores
  each member's hash.
- **Staleness**: when a member changes, the overview goes to the `check` lane with
  reason `member changed: <path>` and its verdict is dropped, so it stays queued
  under `--next` until re-applied.

### One owner per fact: merge, then point

A fact lives in one doc, its owner. Every other doc keeps a one-line summary and
a pointer. Reconcile finds copies, then proposes two entries:

- **Detection.** Sections are compared across the whole tree by 5-word shingle
  Jaccard (>= 0.5, sections at least `retrieval.near_duplicate_min_chars`). The
  owner is the doc whose own heading, title, `purpose` and filename best match the
  shared text, then the older first commit. On a tie, tied docs are flagged and
  the owner is not. Triage flags the holder in the `check` lane with reason
  `copy of <owner>#<section>` (plus ` (tie: a, b)`).
- **`merge`** on the owner: `{path, section, patch}` adds whatever the copy had that
  the owner lacks. Apply checks the section exists before and after.
- **`point`** on the copy: `{path, remove: {old}, pointer: {summary, target}}`
  replaces the copied text with the pointer record. `target` is `domain/owner.md#anchor`
  (docs-root-relative). `target_hash` (the owner's hash) is required unless the entry
  has `depends_on_merge` naming the merge entry's `id` (default: its path).
  Apply runs merges first, then points.

Pointer record format:

```
<one-line summary>. Details: [<owner title>: <heading>](<relative path>#<anchor>)
```

**No-loss check (mechanical).** Before a point is written, every token a reader
would act on must appear, as a whole token (`-v` is not satisfied by `--verbose`,
`30s` not by `130s`), in the owner section or the summary: every token inside code
blocks, inline code, quoted strings and table rows, and elsewhere every token with a
digit, a symbol (`-_./:@=$~#%+`), code-like casing or ALL CAPS, plus every resolved
reference. Plain prose words may be reworded. Otherwise the entry is refused with
`missing: <tokens>`: merge the detail into the owner first. A `merge` patch is held
to the same check against the owner after the merge, so a merge only ever adds.
The check never relies on the model's judgment.

**Anchors.** The anchor must exist in the owner at apply time (checked strictly,
GitHub-style slugs, `{#id}` honored, duplicates `-1`, `-2`). The general
`hewtd link-check` also reports `LINK_BROKEN_ANCHOR` warnings (advisory only).

**Staleness.** Applying a point stores a pointer record (`target` plus a hash of the
owner section) in the copy's ledger entry. If that section changes, triage sends the
copy to `check` with `pointer target changed: <target>`; if the heading was renamed
or removed, `pointer target changed: <target> (section missing)`. The verdict is
dropped until a point (or new review) is applied again; a plain `verify` does not
clear it. Pointers not written by reconcile are not tracked, and editing the pointing
doc by hand drops its record.

**Related repos.** A pointer target outside the docs tree is accepted only inside a
configured `reconcile.related_repos` path. That owner is read for the anchor and
no-loss checks and never written: the sibling-repo rule (summarize and
cross-link) is the same one-owner rule across repos.

## Related repos (2.16.0)

Projects that split code across repos keep each repo's docs in that repo.
Reconcile follows that rule: **docs stay in the owning repo. Summarize and
cross-link, never copy or move.**

`reconcile.related_repos` is `[{ "name", "path" }]`, `path` relative to the
project root, `name` matching `[\w.-]+`. Invalid entries are dropped one by one.

- Sibling repos are read-only. Reconcile never writes there; `--apply` reports
  an error for any entry that resolves outside the project root, and the
  outside lane scans only this project.
- A reference that misses locally is looked up in the siblings and resolves with
  `where: "<name>:<path>"`. Names found only in a sibling's code count too.
  `sources` may list `<name>:<path>`; links into `<sibling>/.documentation` are checked.
- A sibling's bytes and commits since the doc's last body change count toward
  the doc's size and staleness.
- If a configured sibling is not checked out, triage warns and unresolved
  references become `unknown`.
- **Ownership hint**: when at least 2 references resolve in one sibling, they
  are more than 50% of the checkable references, and the doc has no `ok` link
  into that sibling's docs, the doc moves from `clean` or `fields-only` up to
  `check` and carries `owner: <name>` ("details owned by <name>: summarize and
  cross-link"). An `archive-candidate` keeps its lane. The fix is a short
  summary plus a link to the owning doc; the hint clears once that link exists.

## Review file and apply

`--write-review` writes `<git root>/.hewtd/reconcile/review-<batch>-<shard>.md`
(secret-lane docs go to their own `review-<batch>-secrets.md`, never into a shard file)
(never overwrites). Each doc is a `## <path>` heading, a `- [ ] accept` line and
a JSON entry: `path`, `content_hash`, `verdict`, and optionally `frontmatter`,
`patch` (`{old,new}` pairs; each `old` must occur exactly once in the body),
`draft`, `sources`, `sources_remove`, `external_refs`, `reason`.

Skeleton entries (3.1.7) also print `missing: [..]` (the doc's refs triage found missing;
read-only, apply ignores it) and an empty `external_refs: []`. Secret-lane, gaps, overview
and outside entries do not get them. Decide every `missing` ref: fix it with a `patch`, or
list it in `external_refs` when it is not checkable (third-party names, other products'
files, negation or history, placeholders). `external_refs` can sit at the top level of the
entry or inside `frontmatter`.

`--write-review` with named docs includes the named docs that triage put in the
`clean` lane, so you can re-judge one on purpose. `--next` still skips clean docs.

Verdicts: `verify`, `rewrite`, `archive`, `unverifiable`, `fields`, `secret`,
`overview`, `merge`, `point` (2.18.0), `phrases` (2.21.0); outside entries use `integrate` and `delete`.

`--apply <files...>`:

- Serial. A batch makes up to two commits (3.1.0): `docs(reconcile): <scope> batch <n>`
  holds only the changed docs, and `docs(index): refresh after reconcile batch <n>` is
  made only if a regenerated index file changed. Both go through the staged-diff secret
  guard, and a rollback restores docs and index files. If only the index commit fails,
  the docs commit stands, the ledger is written, the index files are restored and a
  warning says to run `hewtd index`. The ledger `applied_commit` is
  the docs commit. Indexes are regenerated only when a verdict changes what they list
  (`phrases`, `verify`, `unverifiable` and `rewrite` entries with no title, summary,
  purpose, description, tier, status, domains, keywords or kind change skip it). Gaps
  `phrases` and `verify` applies make one docs-only commit. Skips entries not ticked `accept` or with a
  null verdict.
- Re-checks `content_hash`; a doc that changed since triage is reported
  `stale` and left alone.
- A doc in two review files is rejected and the exit code is non-zero.
- A second run reports `already-applied` and changes nothing.
- Only `verify` stamps `last_verified` (today). `unverifiable` sets
  `confidence: low`. `fields` never stamps; `rewrite` stamps like `verify`. A `last_verified`
  inside the entry's frontmatter is ignored. `sources` are **merged** into the doc's
  existing `sources` (3.1.6): existing entries first (a single string becomes a list,
  non-string entries are kept), then the new ones, no duplicates (a leading `./` is
  ignored), and the doc's own path dropped (docs-relative and repo-relative forms). List paths in
  `sources_remove` to remove them. A source that is not in the repo is kept and listed in
  the outcome `detail` (not checked for URLs, prose or `<name>:<path>`).
  `external_refs` merges the same way (3.1.7): the doc's existing list first, then the
  entry's, then `frontmatter.external_refs`, deduped, never overwritten.
- `archive` goes through `hewtd archive` machinery (creates `archive/`, link
  guard, reindex). No domain folder is created or moved.
- `rewrite` replaces the doc body with `draft` in the batch commit (3.1.6). The doc's
  frontmatter is kept, `frontmatter` and `sources` merge as for an edit, `last_verified`
  is stamped, and indexes regenerate only if an indexed key changes. A frontmatter block
  at the top of the draft can only add keys the doc does not have (the doc's value is kept
  and the outcome says so); its `sources` merge like the entry's. A draft with no body
  (empty, or frontmatter only) is an error. The body keeps the doc's line endings.
  Warnings go in the applied outcome's `detail`:
  `warning: anchors other docs link to are gone: ...; no longer cited: ...`.
  `.hewtd/reconcile/drafts/` is no longer written. A hand edit after apply reports `stale`.
- Touched domains have their indexes regenerated.
- Only the frontmatter keys an entry changes are rewritten (2.22.0; since 3.1.0 the same holds for `fix-retrieval-fields --apply`, `maintain --fix` / `metadata-sync`, `archive` / `unarchive` and the outside move, see [write-time-guards.md](./write-time-guards.md#commands-that-edit-a-doc-rewrite-only-their-own-keys-310)): `symptoms` for phrases;
  the keys in `frontmatter`, plus `sources` and `last_verified` (verify) and
  `confidence: low` (unverifiable). Every other frontmatter byte (quoting, dates,
  comments, spacing, CRLF) and the body stay byte-identical, so apply no longer
  churns the whole header. A comment sitting between a changed key and its value is lost.
- When at least one entry was applied, `.hewtd/graph.json` is rebuilt (2.20.0; see [graph-export.md](./graph-export.md)). Rolled-back batches leave it as it was. `graph_export: false` disables it.
- **All or nothing.** Files are staged with `git add -A -f` (so a gitignored
  `archive/` still commits). If anything fails after the first write (index
  regeneration, stage, commit) every touched file returns to its pre-apply
  state (uncommitted edits and pre-existing untracked files included), files and
  directories the batch created are removed, nothing is committed and the
  ledger is not saved. Rolled-back entries are reported as `error`
  (`rolled back: <msg>`).
- **Exit code**: 1 on any error outcome (also for rollback and for entries
  resolving outside the project root), with a summary line; 0 otherwise.
- A landed `rewrite` is still recorded with verdict `rewrite`, so the ledger counts the
  doc as unreviewed and `--next` offers it again. Re-judge it, or mark it `verify`.

## Search gaps (2.21.0)

`hewtd reconcile --gaps <file> [--json] [--write-review] [--batch <id>]` turns missed
search queries into proposals. The file is [`gaps.v1`](./gaps-format.md), a bare array,
a JSON array of strings, or one question per line. A wrong or missing `version`, or an
unreadable file, exits 1.

Each query ends in one of three places:

- **Phrase proposal**: it names a doc that exists (not archived, not secret-lane). The
  query becomes a candidate `symptoms.user_phrase` for that doc.
- **New-doc candidate**: no usable doc, but the query holds a code identifier that
  resolves to a source file. The report lists ranked `sources` and a suggested domain.
  Never created automatically: a person writes the doc, then `hewtd integrate`.
- **Open question**: anything else.

Phrase rules: whitespace collapsed, trailing punctuation dropped, 3 words to 200 characters
(2.22.0; it was 20 words), wording kept. Near-duplicates merge (highest count, then shortest): same keywords after stop
words, or one adding a single keyword to two or more shared ones, so questions sharing just one
keyword stay apart. Counts of the same
query add up. At most `reconcile.gaps.max_phrases_per_doc` (default 5) per doc, counting
phrases already there. Dropped: `too short`, `too long`, `secret`, `duplicate`, `over cap`.
A secret-shaped query is shown only as `[redacted]` with a masked note (rule, first 4
characters, length); it never reaches the report, review file or commit.

`--gaps` writes only `.hewtd/reconcile/gaps-report-<date>.md`. With `--write-review` it
also writes `review-<batch>-gaps.md`, one entry per doc (verdict `phrases`). Edit the
phrases, tick `- [x] accept`, then `hewtd reconcile --apply <review>`: the phrases are
added to `symptoms` in one commit (2.22.0 correction: as plain strings, or appended to the
first object symptom entry's `user_phrase` when the doc has one). A rerun reports `skipped` ("no new
phrases to add") and commits nothing. Without `--gaps`, reconcile is unchanged.
The slash command runs this as step 4b.

## Ledger

`.hewtd/reconcile.json` (config `reconcile.ledger_path`, relative to the git
root of the docs path, not the current directory). One entry per doc: lane,
verdict, `reviewed_on`, `applied_commit`, `review_file`, and a content hash.
A doc counts as reviewed only while its hash is unchanged. `--status` shows
counts per lane and verdict and the next unreviewed docs. On reviewed docs it adds
`refs in reviewed docs: N covered by external_refs, M still missing in K doc(s)` (3.1.7),
read from `.hewtd/graph.json` (written by `hewtd index` and `reconcile --apply`); with no graph it
prints a one-line hint, and a malformed graph is reported as such. It never runs triage.

## Team mode

Auto when judged docs (`fields-only` + `check`) reach `team.min_docs` (12) or
judged bytes reach `team.min_bytes` (250 KB). Lockfiles do not count toward
bytes. Shards: `max(ceil(docs/docs_per_agent), ceil(bytes/min_bytes))`, capped
at `team.max_agents` and the doc count; a plan that would be one shard runs
serial. `--serial` and `--team` override. Linked docs share a shard when
they fit a fair share of the job; a larger cluster is split in path order so no
agent carries most of it.
Agents only write review files; `--apply` stays serial.

Config lives in `.claude/hit-em-with-the-docs.json` under `reconcile`; every
key is optional and invalid values fall back to the defaults:

```json
{ "reconcile": {
    "keep_in_place": ["README.md", ".github/**", ".claude/**"],
    "ledger_path": ".hewtd/reconcile.json",
    "schema_sources": [],
    "related_repos": [{ "name": "api", "path": "../api" }],
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

Files named inside tracked config (`*.json`, `*.yaml`, `*.yml`, `*.toml`) are
classed `not-a-doc` ("referenced by <file>"); files under `archive`,
`_archive` or `archived` folders are `junk` ("archived copy"). A config or
script must name the exact path (`docs/release-notes.md` does not claim `notes.md`).
`keep_in_place` always wins, also at apply time. An integrated doc gets
`last_updated` from git (today if untracked) and no `last_validated`. An accepted `integrate` moves
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
- **`--gaps`: "unsupported version" or exit 1**: the file needs `"version": 1` (or be a bare array / one question per line); check the path.
- **`--gaps`: a query is missing from the proposals**: see `dropped` in the report (`too short`, `duplicate`, `over cap`...) and `errors` for unknown `used_doc` paths.
- **Apply dropped my `sources`** (before 3.1.6, `sources` replaced the list): fixed in
  3.1.6. `sources` now merges; use `sources_remove` to remove entries.
- **A `rewrite` says applied but the doc did not change** (before 3.1.6, the draft was only
  saved under `.hewtd/reconcile/drafts/`): fixed in 3.1.6. The draft now lands in the batch commit.
- **`generic-secret` flags a heading with a repo path** such as `tokens: config/theme/theme.data.json`:
  fixed in 3.1.6. A repo-relative path to a file that exists in the repo is not a finding;
  a path-shaped value that is not a file there is still checked like any value.
- **Rejected, doc in two review files** (or twice in one): remove the duplicate and rerun.
- **Outside entry: "target ... already exists"**: a doc with that filename is
  already in the chosen domain. Pick another `domain` in the entry, or merge by hand.
- **Outside entry: "uncommitted changes in docs that link here"**: the move would
  repoint links in those docs and commit them; commit or stash them first.
- **Many refs show `unknown` for URLs or `/abs/paths`**: by design. Only
  `missing` counts against a doc.
- **Triage reports missing refs that exist (or never could)**: update to 3.1.6. If a ref is
  still reported, it is a real miss or a bare name or partial path (`base.py`, `prom/`), which
  are still checked against tracked files. For a thing that lives outside the repo, add
  `external_refs: ["the/ref"]` to the doc's frontmatter. A doc whose only missing refs were
  false positives moves from `archive-candidate` to `check`. The incremental graph re-checks
  these refs when `.gitignore`, the `secret/` folder or a settings file changes.
- **Reviewed docs still show missing refs** (before 3.1.7, apply and the skeleton ignored
  `external_refs`): read the `missing` list in the skeleton and put the refs that are fine
  in the entry's `external_refs`. `--status` shows covered and still-missing counts.
- **Tables reported nowhere / not checked**: set `reconcile.schema_sources`
  (default `[]`); triage prints the schema files it found.
- **A reference to another repo shows missing or unknown**: add that repo to
  `reconcile.related_repos`, check it out, and rerun.
- **`owner: <name>` hint on a clean doc**: summarize the details and link to the
  owning repo's doc; do not copy it.
- **Staleness resets after a `last_verified` stamp**: it does not; only body
  changes reset it.
- **`docs(index)` commit after apply**: expected since 3.1.0 when an index file changed; the docs commit is the one before it.
- **Apply exits 1 with "rolled back"**: nothing was committed; fix the
  reported error and rerun the same review file.
- **Config ignored from a subdirectory**: fixed in 2.16.0; config is read from
  the docs path's project root, not the current directory.
- **A doc is in the secret lane only because a doc it links to has a secret**: fixed in 3.1.0; the linked `.md` is withheld in `blocked_files` and the citing doc keeps its lane.
- **Placeholder or short password flagged** (`abc123def456...`, `user:pass@host`, a regex): fixed in 3.1.0, see Placeholders above.
- **Docs in the secret lane for code like `self.token` or `settings.X`**: fixed in 2.22.0; word-made code references, `{name}` slots, email values and `<NAME ...>` pointer records are no longer `generic-secret` findings (emails stay non-blocking `personal` findings).
- **Code, a wrapped placeholder, a regex or an email still in the secret lane**: fixed in 3.1.1, see Literals only above. Upgrade and rerun `hewtd reconcile`.
- **`generic-secret` flags `openAIApiKey`, `getAPIKey(...)`, `LLMProviderKey`, `minLengthRequirement12` or a `<root-token-...>` placeholder**: fixed in 3.1.2 (the word test works per hump, see Word test). An email-only doc is never in the secret lane.
- **`generic-secret` flags `datetime.utcnow()`, `settings.qdrant_api_key`, `hsl(var(--x))`, a markdown link or a `$VAR` reference**: fixed in 3.1.4 (structured values may hold one non-English name, see Identifier-shaped code and markup).
- **`hewtd index` slow after a code commit or a `node_modules/.bin` change (about 18 s on a large tree)**: fixed in 3.1.5; only docs that read the changed paths are re-resolved, see Incremental code changes in `docs/graph-export.md`.
- **False positive flagged as a secret**: add it to `reconcile.secrets.allow`
  (by `fingerprint` from the report, the full hash or any prefix of at least 12 hex
  chars as shown there, or a `pattern`) with a `reason`.
- **"cannot git-ignore .env.hewtd"**: `.gitignore` is not writable; fix its
  permissions and rerun. Nothing was changed.
- **"NAME already exists in .env.hewtd with a different value"**: rename or
  remove the existing line, then rerun.
- **Apply rolled back with "would write a secret to the staged diff"**: the doc
  still holds the value; accept its `secret` verdict first.
- **Nothing applied**: entries need `- [x] accept` and a non-null verdict.
- **Stray `.hewtd/` in a subdirectory**: state is rooted at the git root; a
  directory created by an older build can be deleted.

- **`copy of owner.md#section` flag**: the doc repeats another doc's section. Merge any
  missing detail into the owner, then point.
- **Point refused with `missing: ...`**: the removed text holds facts the owner section and
  summary lack. Merge them into the owner (or the summary) and rerun.
- **`pointer target changed: ...`**: re-read the owner section; re-apply a `point` if the
  summary still holds, or rewrite the summary.
- **`overview target already exists` / member not reconciled**: pick another target, or
  reconcile the members first (or mark `(unreviewed)` with `allow_unreviewed`).
- **`LINK_BROKEN_ANCHOR: no heading #x`**: warning only; the heading was renamed or removed.

## Limitations

- No backfill (#61): upgrading hewtd, its postinstall, the SessionStart hooks and the routine commands
  (`index`, `maintain`, `metadata-sync`, `audit`) never add `sources` to, or otherwise change, an existing doc.
  Existing docs gain `sources` only through `/reconcile` batches; `hewtd integrate` records them for new docs only.
- No read log for `sources`: the slash command must only list files it read.
- Team defaults are provisional. Triage was measured on one real tree (121
  docs, whole-tree plan: 4 shards); wall time versus serial was not measured.
  Retune from the ledger's `reviewed_on` dates after real runs.
- Superseded: the drafting commands deferred in #50 (E) and #51 (section 3)
  are covered by `/reconcile`.
