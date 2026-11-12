# Docs targets (3.4.0, #109)

Retrieval quality is capped by the docs: search can only return what is written, and can only be trusted if
what is written matches the code. `hewtd audit` ends with a **Targets** section that says what a healthy tree
looks like and what to fix first. It is advisory: it never adds an audit issue, never changes the exit code and
never fails `audit --strict` (like `DOCS_UNREVIEWED`).

`hewtd init` writes a `targets` block into `.claude/hit-em-with-the-docs.json` (never over an existing one);
`hewtd upgrade-check --fix` adds it to a repo that predates 3.4.0. Each target carries a `reason`.

| Metric (active docs) | Default | Next command when unmet |
|---|---|---|
| real `purpose` (present, not weak, not a copy of the first body paragraph) | `purpose_real.min` 0.9 | `hewtd reconcile --next 10 --write-review` |
| verified (`last_verified` inside `vault.audit_window_days`, or a ledger review on the current content) | `verified.min` 0.8 | `hewtd reconcile --changed --write-review` |
| docs citing no missing references (triage) | `no_missing_refs.min` 0.9 | `hewtd reconcile <folder>` (triage lists them) |
| `DOCS_UNREVIEWED` (the `--changed` rule) | `unreviewed.max` 0 | `hewtd reconcile --changed --write-review` |
| docs holding credential-shaped values (a finding in the doc itself) | `secrets.max` 0 | `hewtd reconcile --secrets` |
| docs citing a file with a credential-shaped value (the doc holds none; the cited code file does, listed in the row; a doc that also holds its own value counts on the row above only) | `secrets.max` 0 | fix the file, or `hewtd secrets --baseline-add <file:line> --reason "<why>"` for a false positive (3.4.1) |
| archive candidates still active | `archive_candidates.max` 0 | `hewtd archive-candidates` |
| named flows with an overview doc | `flows` (default `[]`: not applicable) | write a `kind: overview` doc |

Active docs are the docs triage judges, minus `reports/`, `drafts/`, generated docs and `tier: plan`; `archive/`,
INDEX and REGISTRY are never listed.

The block also holds `flows_reason` (why the flows matter), and each metric key has a `reason`.

## Held docs

`targets.held` is a list of `{ "path": "<doc path in the docs root>", "reason": "..." }`. A held doc is counted in
the **Held** column and never as a failure, for the secrets and archive-candidate targets and for the unreviewed
count. A doc in the secret lane is also never counted as unreviewed (it waits on its secret, not on a review).

## Flows

`targets.flows` is a list of flow names, for example `["Billing", "Onboarding"]`. Audit checks that each has a
`kind: overview` doc whose title, file name or tags contain the name, and lists the missing ones. Empty (the
default) means the row is not shown.

## Output

```bash
hewtd audit            # prints the table: metric, value, target, met / not met, held, one next command per unmet target
hewtd audit --json     # the full result; `targets.rows[]` has id, label, value, total, target, met, held, next, docs, missing, files (secrets_cited: the cited code files of the docs it counts, paths only)
```

## What this does not say

Docs targets met does not mean retrieval targets are met, and the reverse. Docs fix grounding and coverage; ranking
is measured by the retrieval eval in semantic-memory (semantic-memory#96).

**Deferred:** importing "coverage" misses from a retrieval eval (topics a grep oracle cannot find either) and listing
them as docs to write. It waits on semantic-memory#96 defining an export; nothing reads one today.
