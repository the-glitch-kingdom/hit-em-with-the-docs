# Code coverage (3.7.0, #117)

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
| scheduled job | crontab and `cron.d` files (named by the script or program the line runs, not by wrappers such as `flock`, `cd X &&`, `nice`, `timeout`, `sh -c`, `python`, `node`, or `VAR=..`; `@daily`, `@reboot` and the like too), GitHub workflow `schedule`, Kubernetes `CronJob`, celery beat (`beat_schedule` in any case, `CELERY_BEAT_SCHEDULE`, one-line entries), APScheduler |
| alert rule | Prometheus rule files, Grafana alert JSON |
| HTTP route | web framework route declarations |
| CLI command and flag | argparse, click (multi-line `@click.option(`, `@click.command`, `@<group>.command`, with or without a name), commander style declarations |
| CI workflow and job | GitHub workflows, GitLab CI jobs |
| background task | celery tasks, sidekiq workers |
| constant | module-level numeric constants (a size, timeout or limit) |
| config key | declared config keys |

Generated files, tests, `vendor/`, `third_party/` and any `archive/` folder are skipped; `coverage.ignore` covers
the rest. **Known limit:** there is no Go detector, so cobra commands and flags and Go
constants are not detected. A Go repo shows only its CI, schedules and alert rules.

## Grades

| Grade | Meaning |
|---|---|
| `absent` | no doc names it |
| `named` | a doc names it (whole identifier, split spellings too) but says nothing about what it does or holds |
| `explained` | a doc that cites its source has a sentence about it, or a section under a heading with its name; a constant is explained when a doc states its value next to its name |

Named is not covered. Archive docs do not count. Knowledge-base docs count like any doc and are never judged
against the code. A repo with no docs folder grades every surface `absent` instead of failing.

The table is per surface kind and code area (first folder of the source file). A kind the code declares as a
list (schedules, alert rules, routes, CLI flags, config keys) is listed under "generate the reference first":
generate or link the list from the code rather than writing each entry out.

## Triage

Absent surfaces, and named ones that carry behaviour (jobs, alerts, tasks, constants), go through the gaps
engine (`src/core/coverage/`), which gives each one outcome (extend a doc, new doc, covered) with the same
rules as `reconcile --gaps` in [reconcile.md](./reconcile.md). Surfaces already have their `file:line`, so
locating is skipped.

Never overwritten: a `create` entry whose path is taken gets a numbered sibling and apply refuses to
overwrite. Drafts use the shipped templates. Institutional knowledge is protected: coverage only adds what the
code declares; it never proposes rewriting or archiving a knowledge-base fact because the code does not show it.

## Security rules

- **No values** in the table, `--json`, review files or drafts: hosts, IPs, ports, IDs, URLs, credentials, key
  material, env or config values and defaults. Names are fine. A code constant (size, timeout, limit) may be
  stated; a number under a credential-like name or a network name may not.
- **Names are screened too.** Every surface name from every detector passes the gate's value rules and the secrets
  scan. A name with a finding (a host, `host:port`, IP, environment resource name such as `sync-prod-eu-west-1`, key
  or id shape) is replaced everywhere (table, `--json` name, key, query, facets, review files) by `<kind> at
  file:line`, for example `scheduled job at deploy/crontab:3`, and the surface is matched by its position, never
  by the value. Route segments that are ids or keys become `:param`. A crontab line that runs a URL (`curl`,
  `wget`) is named by position, never by the URL.
- **Routing is code-based.** A unit is withheld for a human only when a located line is an auth, crypto or
  credential check. A topic word alone (login, token, an `auth` folder) keeps it drafted, marked
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
