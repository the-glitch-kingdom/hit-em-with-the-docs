# Search gaps file (`gaps.v1`)

Input to `hewtd reconcile --gaps <file>`: queries a reader searched for and how it ended. The schema is `schemas/gaps.v1.schema.json`; semantic-memory's `gaps --json` emits it, and you can write one by hand.

## Generated

```json
{
  "version": 1,
  "source": "semantic-memory 1.13.0",
  "gaps": [
    {"query": "how do I roll back a bad deploy", "used_doc": "devops/release-flow.md", "suggested": "symptoms.user_phrase", "count": 4, "last_seen": "2026-11-06"},
    {"query": "where is the rls coverage check", "used_doc": null, "suggested": "new doc", "count": 2}
  ]
}
```

| Field | Required | Use |
|---|---|---|
| `version` | yes | Must be `1`. Any other value is refused with a message naming the supported version. Additive fields keep `1`. |
| `source` | no | Free text naming the producer. |
| `gaps[].query` | yes | The reader's words. Whitespace is collapsed and trailing punctuation dropped; the wording is kept. Queries run from 3 words up to 200 characters (2.22.0); longer ones are dropped as `too long`. |
| `gaps[].used_doc` | no | The doc the reader finally used, or `null`. Docs-relative, vault-relative (`.documentation/...`) or absolute; resolved against the docs root. An unknown, archived, secret-lane, non-markdown or generated (`generated: true`, such as `INDEX.md`) doc is treated as no doc (unknown paths are also reported). |
| `gaps[].suggested` | no | `symptoms.user_phrase` or `new doc`. A hint only; hewtd re-derives the outcome. |
| `gaps[].count` | no | Integer >= 1. Ranks gaps and picks the winning wording among near-duplicates. |
| `gaps[].last_seen` | no | `YYYY-MM-DD`. |

## Coverage misses (3.5.0)

An entry may also carry the retrieval-eval fields from semantic-memory#101. All are optional and keep `version: 1`:

| Field | Use |
|---|---|
| `id`, `tier` | The question's id and tier from the eval. |
| `blind` | `true` for a blind-set question. Blind entries warn and are not drafted unless `--include-blind` is passed (feeding a blind set here spoils it for measurement). |
| `facets` | Regexes, one per fact the answer needs. An entry with `facets` leaves the phrase buckets and gets a coverage outcome (`extend`, `new doc`, `covered`, `instruction file only`). Entries without `facets` classify exactly as before. |
| `missing_facets` | The facets the nearest doc lacks. |
| `nearest_doc` | `{path, facet_coverage: "n/m", rank}` for the closest doc the eval found. |
| `expected` | Doc paths the question should have reached. |

The eval's question-set JSONL (`{id, tier, q, facets, expected?}`, one object per line) is accepted as input too; `q` is the query, and `//` and `#` comment lines are skipped. A wrong-typed `id`, `tier`, `blind`, `missing_facets`, `nearest_doc` or `expected` is ignored: on an entry with facets it is listed in `errors`; on one without, the entry reads exactly as in 3.4.1.

Facets are untrusted regexes and matched case-insensitively. A facet that does not compile, is longer than 300 characters, has a nested quantifier, or has a `|` group under a quantifier (such as `(a|aa)*b`) is refused and listed in `errors`; `(foo|bar)x` is fine. Matching also runs under a time limit (500 ms per file or doc), so a slow pattern the shape check misses (`((a+))+$`, `a*a*a*a*b`) is stopped, counts as matching nothing, and is named in `warnings`. A facet or query holding a value (host, IP, port, ID, config value, secret) is not echoed: the facet is dropped as `[redacted facet]`, the query shown as `[question <id>]`. If every facet of an entry is refused, the entry falls back to the old buckets. Code-line-shaped facets (`x = 24 * 60`, `def f(`, `class C`) are flagged: prefer one-fact, prose-tolerant facets.

**Triage in 3.6.0 (#115).** Facets that are weak (fewer than 4 word characters, or no letter: `410`, `30\.0`) or that match more than 10 files only count inside the files the distinctive facets locate; a miss with only weak facets gets no sources. Docs, instruction files and non-code files (baselines, ignore files, lockfiles, generated JSON, fixtures, mockups) are never located. A facet naming a code constant (a size, timeout or limit) is allowed; hosts, IPs, ports, IDs, URLs, credentials and env or config values are not. Report and `--json` additions: each `needs_human` entry has `reason` (matched word and where, or "only on a credential line"; never a value); a question whose every facet was withheld is listed with the rule names; an entry that has a missing fact hewtd cannot state safely lists it as `for_judge: [{facet, at: ["file:line"]}]` and has `verdict: null` until the judge writes a sentence. A hub doc that is the only holder of facets is still extended and flagged hub. Input files without facets are unaffected.

**Triage in 3.7.0 (#118).** A citing doc with no facet is a target only when relevant to the question; file-map docs are hubs; `nearest_doc` holding at least one facet beats a zero-facet citer. Only a located security check (by code shape) lists the unit under `needs_human`; a topic word alone keeps it drafted and adds `security_adjacent: {keys, word, where}` to the entry. New-doc names come from the subject, not the question text, and the folder from nearby docs. A simple constant is stated from its located line even for a code-line-shaped facet.

**Triage in 3.8.0 (#120).** Misses that share only a declared-list file (a schedule, routes, alert rules, CLI flags, config keys) stay separate units; otherwise two misses tie on a file only when their facet lines sit within 30 lines of each other in it (`FILE_TIE_WINDOW`, a shortcut: two same-file facets that close still merge). A merged unit is targeted by the union of its facets and never inherits one member's `nearest_doc`, and a security check located for one member holds that member only; the others draft. The "generate the reference" hint is added only for facets that are entries of the declared list, and sits beside the draft for the rest. Table-style file maps (rows whose first cell is a path) and docs titled or keyworded file map or inventory are hubs. A new doc goes in the deepest folder shared by the majority of the docs about nearby code and is titled and given a purpose from its subject (module or shared identifier stem), not from a boolean-looking facet (`is_`/`has_`) or the question text; the question stays in `symptoms`. Docstrings, triple-quoted strings, `/* */` and `=begin` blocks are prose, never a security check. Inside quoted literals and comments only a clearly name-shaped facet is a name (an option flag, a file name or path with a known extension, a route, a dotted lowercase event name, or a command phrase with a `--long-flag`); a single bare token (`.command('serve')`), a slash path with no extension, plain words (`payments-db-replica`), digits mixed in, and anything after `key=`, `Bearer`, `Basic` or a value-named key are values, so a one-word name in quotes is withheld. Block syntax is read per language (`.py`, C-family, `.rb`); a `/*` opens only at a line start or after `;`, `{`, `}` or `)` and a space, never in a regex literal, and a block unclosed within 200 lines marks nothing. A doc that lists the located file in its `sources` (a file at most 5 docs cite) and whose title shares a question term is a target even when it cites many files. `gate:gaps` now has 31 checks.

Located files over 512 KB are skipped, and the input file itself is never searched. See [reconcile.md](./reconcile.md) for the outcomes, merging, drafts and the security rules.

## Hand-written

No search tool needed. Any of these work:

- A bare array of gap objects (the same objects as above).
- A JSON array of strings: `["how do I roll back a deploy", "where is the rls check"]`.
- A plain text file, one question per line (blank lines and lines starting with `#` are skipped).

Questions without a usable `used_doc` have no doc to attach to, so they become new-doc candidates or open questions.

## Errors

An invalid entry is reported with its index (`gaps[3]: ...`) and skipped; the rest are kept. Never put doc text or secrets in the file: every query is secret-scanned and a hit is dropped with a masked note.

Reader: `parse_gaps` in `src/core/reconcile/gaps.ts`.
