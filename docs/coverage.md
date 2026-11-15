# Code coverage (3.7.0, #117; 3.8.0, #120)

`hewtd coverage` answers one question: of the things the code declares, which ones do the docs cover? It lists
each declared surface, grades it against the docs, prints a table, and drafts what is missing through the same
engine as `reconcile --gaps`. It is deterministic, never calls a model, and is read-only unless you pass
`--write-review`. Nothing lands in the docs without `reconcile --apply`.

```bash
npx hewtd coverage                        # the table
npx hewtd coverage --json                 # machine-readable
npx hewtd coverage --write-review         # drafts to .hewtd/reconcile/review-<batch>-coverage.md (--batch <id>)
```

The judging pass is the slash command `/hit-em-with-the-docs:coverage` (`commands/coverage.md`).

## Surfaces (declared only)

Detectors live in `src/core/coverage/surfaces/detectors.ts`; adding one is adding an entry to
`SURFACE_DETECTORS`. Only what the code declares is in scope: no procedures, git history or runbooks.

| Kind | Found in |
|---|---|
| scheduled job | crontab and `cron.d` files (named by the script or program the line runs, not by wrappers such as `flock`, `cd X &&`, `nice`, `timeout`, `sh -c`, `python`, `node`, `bundle exec` or `VAR=..`, interpreter options and their values, or the user column of `/etc/crontab` and `cron.d` files; a management runner is named by its subcommand: `manage.py clearsessions`, `rake db:cleanup`, `artisan X`, `npm run X`, `yarn X`, `make X`, `rails runner`; `docker`/`kubectl exec` by the command run inside, `flock -c` and `sh -c` by the quoted command; two jobs on different lines are never merged; `@daily`, `@reboot` and the like too), GitHub workflow `schedule`, Kubernetes `CronJob`, celery beat (`beat_schedule` in any case, `CELERY_BEAT_SCHEDULE`, one-line entries), APScheduler |
| alert rule | Prometheus rule files, Grafana alert JSON |
| HTTP route | web framework route declarations |
| CLI command and flag | argparse, click (multi-line `@click.option(`, `@click.command`, `@<group>.command`, with or without a name), commander style declarations |
| CI workflow and job | GitHub workflows, GitLab CI jobs |
| background task | celery tasks, sidekiq workers |
| constant | numeric constants (a size, timeout or limit) at module level or in a class body (Python class bodies; Java/C#/Kotlin/Rust `static`, `final`, `const`; TS `static readonly`), and annotated collection constants (`BOUNDS: List[int] = [...]`, `X: Record<number, number> = {...}`), which are named and never stated |
| config key | declared config keys |

Generated files, tests, root-level `vendor/`, `third_party/` and `archive/` folders and `node_modules` are skipped (`src/vendor/` and `src/archive/` are the repo's own code and are graded); `coverage.ignore` covers
the rest. **Known limit:** there is no Go detector, so cobra commands and flags and Go
constants are not detected. A Go repo shows only its CI, schedules and alert rules.

## Grades

| Grade | Meaning |
|---|---|
| `absent` | no doc names it |
| `named` | a doc names it (whole identifier, split spellings too) but says nothing about what it does or holds, or the doc does not cite the surface's source |
| `explained` | a doc that cites its source has a sentence about it (a verb phrase, or any sentence that is not a list with the name and at least 3 other content words: words that are not stop words, other surface names or list items), or a section under a heading with its name; a constant is explained when a doc states its value next to its name |

A name inside a list of three or more single-name items, with an optional lead-in and `and`/`or` joiners (`Scheduled: purge_trials, send_digest, rotate_logs`, `The jobs are a, b and c`; snake, kebab and camel names are one item each)
stays `named`: the other items are not words about it, unless another sentence about that one name says what it does.
Named is not covered. Archive docs do not count. Knowledge-base docs count like any doc and are never judged
against the code. A repo with no docs folder grades every surface `absent` instead of failing.

The table is per surface kind and code area (first folder of the source file). A kind the code declares as a
list (schedules, alert rules, routes, CLI flags, config keys) is listed under "generate the reference first":
generate or link the list from the code rather than writing each entry out.

## Triage

Absent surfaces, and named ones that carry behaviour (jobs, alerts, tasks, constants), go through the gaps
engine (`src/core/coverage/`), which gives each one outcome (extend a doc, new doc, covered) with the same
rules as `reconcile --gaps` in [reconcile.md](./reconcile.md). A named surface is never `covered`: it extends the
most specific non-hub, non-knowledge-base doc that names it (one that cites its source first), and its located line
is listed for the judge to write what it does; a named constant with a stateable value is stated. Surfaces already have their `file:line`, so
locating is skipped.

Never overwritten: a `create` entry whose path is taken gets a numbered sibling and apply refuses to
overwrite. Drafts use the shipped templates. Institutional knowledge is protected: coverage only adds what the
code declares; it never proposes rewriting or archiving a knowledge-base fact because the code does not show it, and a
knowledge-base doc is never an extend target (a fact that already states it still counts as covered).

## Security rules

- **No values** in the table, `--json`, review files or drafts: hosts, IPs, ports, IDs, URLs, credentials, key
  material, env or config values and defaults. Names are fine. A code constant (size, timeout, limit) may be
  stated; a number under a credential-like name or a network name (bind, relay, collector, exporter, broker, sink,
  agent, otlp, statsd, syslog...) may not, a well-known port number is never stated, whatever the name measures
  (`BIND_MAX = 8080`), and a bare integer from 1 to 65535 is stated only when the name says what it is (timeout, ttl, interval, size, bytes,
  max, limit, count, code, digits, ratio...), so `OTLP_COLLECTOR = 4317` and `LEVEL = 3` go to the judge. Underscored numbers
  (`5_432`) are read as numbers, simple integer arithmetic is evaluated, and the port check runs on the result and on each
  operand (`8000 + 80`). A hex literal over 6 digits (a key, hash or hex IP) is never a constant, and every constant value also
  passes the key-token and value rules.
- **Names are screened too.** Every surface name from every detector passes the gate's value rules and the secrets
  scan, run on the name as written, with `_` and `-` read as spaces (dashed digit runs rejoined to an IP), and split
  at letter, digit and case boundaries, so `sync_to_10.0.0.5`, `High5xxOn10.1.2.3` and `deploy-to-10-0-0-5` are found; a
  key-shaped token inside a name (`backup_s3_<key>`, `sk-`, `ghp_`, `AKIA`, `xox`, `npm_` prefixes, long hex or mixed
  runs) is a finding too. A name with a finding (a host, `host:port`, IP, environment resource name such as `sync-prod-eu-west-1`, key
  or id shape) is replaced everywhere (table, `--json` name, key, query, facets, review files) by `<kind> at
  file:line`, for example `scheduled job at deploy/crontab:3`, and the surface is matched by its position, never
  by the value. Route segments that are ids or keys (key-shaped tokens such as `sk_live_...`; a segment, or a dash-separated piece of one, of 6+ characters that mixes letters and digits or looks like base64; a known key prefix such as `sk-`, `pk_`, `xox`, `ghp_`, `AKIA`) become `:param`, and a query string is dropped from the name; version segments (`v1`, `v2beta`) stay. A crontab line that runs a URL (`curl`,
  `wget`) is named by position, never by the URL. Names are normalized first (repeated separators collapsed, leading zeros
  stripped from digit groups: `sync_010_000_000_005`, `10__0__0__5`), IPv6 forms (`fe80::1`, `[::1]`) count, a run of 8 or
  more digits or an 8-digit hex token in a name is an id (decimal and hex IPs), and `_` is also read as `-` for environment
  resource names (`notify_db_prod_01`). A cron script name loses only a script extension (`.sh .py .rb .js .ts .php .pl
  .bash`), so `backup_to_10.0.0.5` keeps its IP and is withheld.
- **File paths are screened too.** Each path segment (folder, file name and stem) passes the same name screen. A surface
  whose path holds a value is not graded or drafted: it is held for a human with the reason `value in file path`, shown
  as `[withheld path]` everywhere, and no doc is ever named from such a stem. Hostname-shaped names such as
  `config.local.ts` or `docker-compose.dev.yml` are not read as hosts in a path.
- **Facets by context (`reconcile --gaps`).** A facet is a value, shown as `[redacted facet]` everywhere and never naming a
  doc, when every match in code sits inside a string literal that is shaped like a value (a host, URL, key, id or password) or set under a value name (`"password": "..."`), inside an option argument of a shell line (`-p<x>`, `-H "..."`,
  `--password=...`, `--token ...`), inside URL or DSN userinfo, or in a heredoc body; when its text without regex escapes is
  key-shaped; or when it holds a value by the name screen. A literal that is an import path, an env var name, a route path or
  a flag is a name, and so is any other quoted literal or comment text (a fixture file name, a flag in a comment). Identifier facets outside literals are unaffected. A gaps question that holds a value is shown as
  `[redacted question]`. `hewtd coverage` builds its facets from screened names, so only the line-shape rule applies there.
- **Routing is code-based.** A unit is withheld for a human only when a located line is an auth, crypto or
  credential check, found by code shape across languages (decorators, attributes, middleware and guards naming
  auth, permission, role, login or admin; a token, secret, password, signature or expected value compared;
  hashing, signing or password-hash calls; TLS verification turned off), and by a general rule: a security operand
  word (token, key, password, role, owner, policy and the like, after splitting identifiers) on a line with a check form
  (an equality, equals, compare, verify, an `in` test, an is/has/can predicate, a guard); crypto API calls count alone. A topic word alone (login, token, an `auth` folder) keeps it drafted, marked
  "security-adjacent: judge carefully".

## Ignore list

`coverage.ignore` in `.claude/hit-em-with-the-docs.json`: surfaces held on purpose. Each entry is a path prefix
or glob, or a surface `name`, with an optional `reason`. Held surfaces are counted apart, never as misses.

```json
{ "coverage": { "ignore": ["vendor/**", { "name": "DEBUG_LIMIT", "reason": "debug only" }] } }
```

## Audit target (opt-in, advisory)

`targets.code_coverage` in the same file adds a row per surface kind to the `hewtd audit` Targets section
([docs-targets.md](./docs-targets.md)): the share `explained`, against `min` (default 0.8) with a `reason`.
It is not written by `upgrade-check --fix`, never adds an audit issue and never fails `audit --strict`.

```json
{ "targets": { "code_coverage": { "min": 0.8, "reason": "declared code is explained in a doc" } } }
```

## Release gate

`npm run gate:coverage` (in `prepublishOnly`, a sibling of `gate:gaps`) runs the command against the synthetic
fixture with one case per detector, plus checks: ignore list holds, generated files skipped, declared lists
get "generate the reference", every stated fact is true at its `file:line`, read-only without
`--write-review` and nothing overwritten, and a secret scan of every output.

## Troubleshooting

- **A surface shows `named`, not `explained`**: a doc mentions the name but has no sentence about it. Add one
  in a doc that cites the source file.
- **A surface is missing from the table**: no detector matches its framework or language (see the Go limit), or
  the file is generated or on `coverage.ignore`.
- **`for_judge` entries with `verdict: null`**: hewtd states only simple constants; read the cited lines and
  write the sentence, or leave it for a human.
- **Two surfaces merged into one new-doc draft**: the file name comes from the first facet and the title from
  the first question, so they can differ. Rename before applying.
- **A constant under a path containing `auth` goes to `for_judge`**: judge it; it is not withheld.

## Changes in 3.8.0 (#120)

`coverage` and `reconcile --gaps` share the engine, so the triage rules in [reconcile.md](./reconcile.md) apply: table file maps and file-map or inventory docs are hubs; a new doc goes in the majority folder of nearby docs and is titled from its subject; merges follow declared-list and same-block rules with no inherited `nearest_doc` and a per-member security split; the "generate the reference" hint sits beside drafts and covers only list entries; docstrings and block strings are not security checks; names in literals and comments are names. Class-level and annotated collection constants are surfaces (see the constant row above). `gate:gaps` is 31 checks, `gate:coverage` 40.

## Known limits

- `explained` means a citing doc has a sentence about the surface, not that every why is there: a nightly job can be `explained` while the reason it keys on idle time is missing. Read it as "not a gap by name", not "fully documented".
- Collection constants need a type annotation or a typed declaration (Java/Kotlin/C# `Map<..>`, `int[]`, `List.of(..)`, `listOf(..)`, `new[] {..}`; Kotlin in a top level or companion `object`), are never stated, and are skipped when the name looks like a credential or the first line holds a key. Supported: Python and TypeScript with a type annotation, Java, Kotlin and C# typed fields and arrays or a collection factory call. Not detected: unannotated collections in other languages and indented constants outside a class (function locals, TS/JS local `const`). In Java and C# a field needs `static` or an access modifier with `final`/`const`/`readonly`, so a method-local `final int X = 7;` is skipped (and a package-private `final int X` field is missed). PascalCase names (`public const int MaxSeats`, `static readonly int[] Tiers`) are constants in `.cs` files only, with the same screening.
- A file is a declared list when the surface detectors (or the older regexes) find 3 or more entries of one list kind in it (celery beat with `crontab()` or `timedelta`, Flask/FastAPI decorators, flags, keys); an entry that opens a block covers, for the hint, its own key or name line and, within its next 4 lines, only its schedule, route path or flag line (never a task path or options line). Multi-line decorators (`@router.post(\n  "/orders", ...)`), `api_route`, `websocket` and Flask `add_url_rule` are routes.
- Two misses whose facets sit in one file within 30 lines (`FILE_TIE_WINDOW`) still merge, except on a declared-list file; this is a shortcut, tighten it if unrelated misses collapse.
- Surfaces come from `git ls-files`: untracked files are not scanned. Outside a git repo, or with nothing committed, the table is all zero and `hewtd coverage` prints a warning (also in `--json` `warnings`).
- A cron line with `&&` or `;` is named by its first non-`cd` command; later commands in the chain are not separate jobs. A `(...)` subshell is unwrapped. A name shorter than 2 characters or a stop word (`a`, `the`) becomes `scheduled job at file:line` and a surface with such a name is matched only inside a code span.
- A click command named from its function (`migrate_data` is `migrate-data`) is located by position (its decorator line), since the name is not spelled there. A boolean flag pair (`--shout/--no-shout`) is the first long flag.
- GitLab jobs are top-level keys (`test:unit:`, quoted, with a trailing comment) holding `script`, `trigger`, `extends` or `run`; reserved keys (`stages`, `variables`, `default`, `include`, `workflow`, `image`, `services`, `cache`, `before_script`, `after_script`) and hidden `.jobs` are skipped.
- The content-word rule is lexical: three content words in a sentence with the name explain it even when the sentence is not accurate; a doc that does not cite the source never explains it (except a stated constant value).
- A heredoc is found only when its `<<TAG` is within 200 lines above; a multi-line string literal other than a heredoc is
  read line by line, so a value on a continuation line is caught only by the other rules.
- Inside a quoted literal or a comment a facet is a name only when it is clearly name-shaped: an option flag (`--omit=dev`),
  a file name or path ending in a known code, data or doc extension (`fixtures/orders.json`; no key-shaped segment), a route
  (`/api/orders/:id`), a dotted lowercase event name (`user.created`; not hostname-shaped), or a command phrase with a
  `--long-flag` and lowercase words (`npm audit fix --package-lock-only`; no word that is a flag's argument), and it passes the
  name screen. Every other literal is a value: one bare token (`.command('serve')`), digits mixed in, a slash path with no
  extension (`jsmith/prod`, `a/b/c`), two or more plain words (`payments-db-replica`, `open sesame please`), anything after
  `key=`, `Bearer`, `Basic` or a value-named key. This errs toward withholding. Known limit: a lowercase word before a
  `--flag` in a quoted phrase reads as a command (`"hunter --verbose"`). An uppercase `NAME = "word"`
  assignment is still a config value.
- Docstrings (`.py`, at a statement or after `=` or `(`), `/* */` blocks (C-family, JS/TS, Java, Go, C#, Rust, PHP, CSS,
  Kotlin, Swift, Scala files) and Ruby `=begin` blocks (`.rb`, column 0) are prose, never a security check, and only the lines
  wholly inside them (a line with code before the opening or after the closing delimiter is still checked). A block that never closes, or does not close within 200 lines, marks nothing; a `/*` opens a block only at the start of a line or after `;`, `{`, `}` or `)` and a space, never inside a regex literal, a string or after a backslash, and `#` is a line comment in PHP (`#[` is an attribute). A block that never
  closes, or a delimiter hidden by a quote inside a comment, is not recognised.
- Hostnames in file paths are not screened (`config.local.ts` is not a host); IPs, ids, key shapes and environment resource
  names are.
- A bare integer under a name with no measuring or describing word is not stated, even when it is harmless (`LEVEL = 3`).
- The security-check rule is by code shape and context, not a parser: a check whose operand is only inside a string (`headers['authorization']` aside), a check spelled with a user-defined helper whose name holds no operand word, and a decorator named for neither auth nor a guard are not detected; the topic-word route still marks them security-adjacent.
- Helper-style checks are found by name words: an operand word (token, password, signature, pin, otp, totp, stored, expected) or a constant-time word (`safe_equal`, `timing_safe`) with a validity or permission word (valid, ok, eq, eql, verify, check, match, allowed, allows, permitted, in group); a negated request or session user is an auth check. A few ordinary lines are withheld by mistake (`is_allowed_file(name)`, `len(tokens) == 0`); that is the safe direction. Small ids and personal names inside job or constant names are identifiers, not credentials, and are kept.
- `code` measures only as a status, response, http, exit, error, return or reason code; access, invite, unlock, verification, door, admin, reset and recovery codes are values. A bare integer from 1024 to 65535 under a db, database, redis, cache, queue, host or server name is not stated unless the name carries a unit (timeout, ttl, size, bytes, ...).
- A route piece that is a word followed by 3+ digits or a base64-like token (`sha256sum`, `base64`) can become `:param`; the route is still listed, only that piece is generalised.
- A membership call (`includes`, `has`, `contains`) counts only on a role, permission, scope, policy or grant collection; `tokens.includes(x)` alone is not a check.
- Arithmetic is evaluated for integers, `+ - * / << **` and parentheses only; anything else follows the constant rules as written.
- A user column in a non-system crontab is recognised only for the listed account words (`root`, `www-data`, `nobody`, `daemon`, `postgres`, `deploy`, `app`, `ubuntu`) or a bare word followed by a path, wrapper or interpreter; any other account name is dropped only in `/etc/crontab` and `cron.d` files.
- Wrapper option values are skipped by known flags (`timeout -s`, `nice -n`, `docker exec -it`, `npm --silent`); an unknown flag that takes a value may still be read as the program.
- `gate:gaps` and `gate:coverage` reject a malformed `expected.json` (empty `cases`, unknown keys, an unknown or typo'd `draft`, `stated` or `judge` without a non-empty list) before scoring; they still do not check that a listed value is sensible, only that the case is well-formed.
- `gate:coverage` also requires `draft` on every case, a scored case for every detector kind, and every surface the fixture produces to be expected or listed in `expected.json` `unscored` with a reason; `gate:gaps` requires a case for every fixture gap. It checks completeness, not that the fixture is representative: a new detector shape needs a new fixture line.
