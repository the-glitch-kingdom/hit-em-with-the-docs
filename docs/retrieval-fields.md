# Retrieval fields (HEWTD 2.12.0+)

Search tools find a doc by matching a question against its frontmatter and
text. Four fields carry that match. Write them on every doc.

| Field | What to put in it |
|---|---|
| `title` | Names the specific subject. Not "Overview" or "Guide". Unique in the tree. |
| `purpose` | One sentence: the question this doc answers, or when to read it. |
| `symptoms` | Plain strings: how a person describes the problem, or the literal error text. Any tier. |
| `tags` | Short topic words. |
| `kind` | Optional. `overview` marks a doc that walks a cross-cutting flow end to end and links every stage. Validated on every tier; any other value fails the audit. Template: `templates/overview.template.md`. |

```yaml
---
title: Vault auth fails after a pod restart
purpose: Why Vault login returns 403 after a restart and how to re-seed the token.
symptoms:
  - "vault login 403 after restart"
  - "permission denied: invalid token"
tags: [vault, auth]
---
```

`symptoms` entries on a `fact` or any other tier may be plain strings. An
object entry (`alert_name`, `user_phrase`, `error_pattern`) still needs
`target` and `cites`. See `knowledge-base-primitives.md`.

## Generated files

Generated indexes, registries and reports carry `generated: true` in their
frontmatter. Search tools can skip them. The domain and root `INDEX.md` tables
have a Purpose column filled from each doc's `purpose`.

## Audit warnings

`hewtd audit` checks the fields above. Every `RETRIEVAL_*` issue is a warning:
it never changes the exit code, with or without `--strict`. `audit` prints
counts; read the issues through the auditor API or `hewtd report audit`.

| Code | Raised when | Fix |
|---|---|---|
| `RETRIEVAL_MISSING_PURPOSE` | No `purpose`. | Write one sentence. If the doc has a `summary` or `description`, run `hewtd fix-retrieval-fields --apply`. |
| `RETRIEVAL_WEAK_PURPOSE` | Purpose repeats the title, is under `purpose_min_words` words, or starts "Documentation for". | Rewrite it as the question the doc answers. |
| `RETRIEVAL_GENERIC_TITLE` | Title is in `generic_titles`, or another doc has the same title. | Name the subject. |
| `RETRIEVAL_MISSING_SYMPTOMS` | A runbook or troubleshooting doc has no `symptoms`. | Add the phrases a user would search. |
| `RETRIEVAL_OVERSIZED` | Body over `oversized_chars`, or more than `oversized_headings` H2 sections. | Split into one topic per doc. |
| `RETRIEVAL_NEAR_DUPLICATE` | Two docs share a passage of `near_duplicate_min_chars` or more. | Merge them, or archive one. |

Generated files, `INDEX.md`/`REGISTRY.md`, `drafts/`, `reports/`, `archive/`
and plan-tier docs are not checked.

## Overview docs (HEWTD 2.13.0+)

An overview doc walks a cross-cutting flow end to end and links every stage,
so a search for the flow lands on one page. Mark it `kind: overview` and start
from `templates/overview.template.md` (tier `guide`; a numbered "How it fits
together" list, one link per stage). `kind` accepts only `overview`; any other
value fails the audit as `metadata-invalid` and lists the allowed values.

hewtd finds the flows itself. A cluster is a domain, or a cross-domain
connected component of linked docs. Generated files, `archive/`, `drafts/`,
`reports/`, plan-tier docs and draft or archived docs are ignored. A cluster
of `min_cluster_size` or more docs needs an overview. A `kind: overview` doc
qualifies as its overview only if it links at least `min_link_coverage` of the
other members. A generated `INDEX.md` never counts as an overview.

| Code | Raised when | Fix |
|---|---|---|
| `OVERVIEW_MISSING` | A cluster has no qualifying overview. Reported on the domain name for a domain cluster, on the first member for a component. A `kind: overview` doc below the coverage bar also lands here. | Write an overview from the template and link the members, or add the missing links to an existing one. |
| `OVERVIEW_STALE_LINKS` | A qualifying overview misses some members. | Add a link to each member listed. |

Both are advisory warnings with no `code`: they never change the exit code
(with or without `--strict`) and the GitHub Action ignores them.

`hewtd maintain` lists pending back-links as a dry run. `hewtd maintain --fix`
**edits doc bodies**: it inserts `Part of: [Title](rel.md)` after the first H1
(or at the top of the body when there is no H1) in each member. It is
idempotent, skips generated and plan-tier docs, and runs before the metadata
sync so one `--fix` run converges. Set `overview.backlinks` to `false` to turn
it off.

```json
{
  "overview": {
    "min_cluster_size": 5,
    "min_link_coverage": 0.6,
    "backlinks": true,
    "disabled": []
  }
}
```

Invalid values fall back to these defaults. `disabled` silences the audit
rules only (`["OVERVIEW_MISSING"]`); health-report coverage and back-links do
not consult it.

## Migrating old fields

```bash
hewtd fix-retrieval-fields              # dry run: lists what would change
hewtd fix-retrieval-fields --apply      # write it
hewtd fix-retrieval-fields -p docs      # docs path other than .documentation
```

It moves `summary` (else `description`) into `purpose` when `purpose` is
absent. When both exist it reports a conflict and changes nothing. It also
merges `keywords` into `tags` and removes `keywords`. Only the frontmatter
block is rewritten (with hewtd's own YAML writer, which keeps dates as quoted
strings); the body is left byte for byte. YAML quoting, list style and
comments in that block may be normalised. A file whose frontmatter does not
parse is skipped and reported, and the rest of the run continues.
`integrate` no longer invents a purpose: if the first paragraph is not a
usable sentence, `purpose` stays missing and the audit says so.

## Config

In `.claude/hit-em-with-the-docs.json`:

```json
{
  "retrieval": {
    "purpose_min_words": 8,
    "generic_titles": ["Admin", "Reference", "Guide", "Overview", "Notes", "README", "Index", "Introduction"],
    "oversized_chars": 15000,
    "oversized_headings": 12,
    "near_duplicate": true,
    "near_duplicate_min_chars": 300,
    "disabled": []
  },
  "reports_dir": "docs-reports"
}
```

Invalid values fall back to the defaults shown. `disabled` lists codes to
silence, for example `["RETRIEVAL_OVERSIZED"]`. `reports_dir` is relative to
the repo root. A value that escapes the repo prints a warning and falls back to
the default. Unset, reports go to `<docs root>/reports`.
Reports outside the docs root are not scanned by hewtd.

## Coverage report

`hewtd report health` adds a Retrieval Coverage table (and a
`retrievalCoverage` object in JSON): docs with a purpose, docs with symptoms,
docs with a unique title, each as `n/total | pct%`. It also reports
"N cluster(s) with an overview, M without" and a table of clusters missing one
(Docs, Generated-only hub columns; `overviewCoverage` in JSON). It does not change the
health score. `hewtd maintain` writes its own `maintenance-*.md` report.

## Writing guidance

- One topic per doc. If a doc answers two questions, split it.
- Put the answer or summary first. Search tools often index only the top.
- Cross-cutting flows get an overview doc that links to the topic docs.
- A trap buried in a runbook becomes a fact with `symptoms`, so a search for
  the error finds it directly.
- Do not copy a paragraph between docs. Link to it.

## Troubleshooting

### "audit shows RETRIEVAL warnings but exits 0"

That is by design. The rules are advisory.

### "integrate left purpose empty"

The first paragraph was a code block, table, list or over 200 characters.
Write the purpose by hand.

### "fix-retrieval-fields reports a conflict"

The doc has both `purpose` and `summary`. Pick one by hand and delete the other.

### "strict audit fails on missing INDEX files"

Run `hewtd maintain` or `hewtd index` first.
