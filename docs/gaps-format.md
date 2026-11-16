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

Facets are untrusted regexes and matched case-insensitively. A facet that does not compile, is longer than 300 characters, has a nested quantifier, or has a `|` group under a quantifier (such as `(a|aa)*b`) is refused and listed in `errors`; `(foo|bar)x` is fine. Matching also runs under a time limit (500 ms per file or doc), so a slow pattern the shape check misses (`((a+))+$`, `a*a*a*a*b`) is stopped, counts as matching nothing, and is named in `warnings`. A facet or query holding a value (host, IP, port, ID, config value, secret) is not echoed: the facet is dropped (counted as withheld, never shown), the query shown as `[question <id>]`. If every facet of an entry is refused, the entry falls back to the old buckets. Code-line-shaped facets (`x = 24 * 60`, `def f(`, `class C`) are flagged: prefer one-fact, prose-tolerant facets.

**Triage in 3.6.0 (#115).** Facets that are weak (fewer than 4 word characters, or no letter: `410`, `30\.0`) or that match more than 10 files only count inside the files the distinctive facets locate; a miss with only weak facets gets no sources. Docs, instruction files and non-code files (baselines, ignore files, lockfiles, generated JSON, fixtures, mockups) are never located. A facet naming a code constant (a size, timeout or limit) is allowed; hosts, IPs, ports, IDs, URLs, credentials and env or config values are not. Report and `--json` additions: each `needs_human` entry has `reason` (matched word and where, or "only on a credential line"; never a value); a question whose every facet was withheld is listed with the rule names; an entry that has a missing fact hewtd cannot state safely lists it as `for_judge: [{facet, at: ["file:line"]}]` and has `verdict: null` until the judge writes a sentence. A hub doc that is the only holder of facets is still extended and flagged hub. Input files without facets are unaffected.

**Triage in 3.7.0 (#118).** A citing doc with no facet is a target only when relevant to the question; file-map docs are hubs; `nearest_doc` holding at least one facet beats a zero-facet citer. Only a located security check (by code shape) lists the unit under `needs_human`; a topic word alone keeps it drafted and adds `security_adjacent: {keys, word, where}` to the entry. New-doc names come from the subject, not the question text, and the folder from nearby docs. A simple constant is stated from its located line even for a code-line-shaped facet.

**Triage in 3.8.0 (#120).** Misses that share only a declared-list file (a schedule, routes, alert rules, CLI flags, config keys) stay separate units; otherwise two misses tie on a file only when their facet lines sit within 30 lines of each other in it (`FILE_TIE_WINDOW`, a shortcut: two same-file facets that close still merge). A merged unit is targeted by the union of its facets and never inherits one member's `nearest_doc`, and a security check located for one member holds that member only; the others draft. The "generate the reference" hint is added only for facets that are entries of the declared list, and sits beside the draft for the rest. Table-style file maps (rows whose first cell is a path) and docs titled or keyworded file map or inventory are hubs. A new doc goes in the deepest folder shared by the majority of the docs about nearby code and is titled and given a purpose from its subject (module or shared identifier stem), not from a boolean-looking facet (`is_`/`has_`) or the question text: an identifier names it only when it shares a word with the question, else the source module stem, else the question's noun phrase, and an identifier that reads as a security check (`verify_password`) never names a doc unless the question shares that word; the question stays in `symptoms`. A whole-file lexer (per language family: Python, C-style, Ruby) tracks normal, line-comment, block-comment and every string state across lines (single and double quotes, Python triple strings with any prefix and f-string braces, JS and TS template literals with `${}` nesting, Go raw strings, Java, Kotlin, Swift and Scala text blocks, Rust and C++ raw strings, C# verbatim strings, PHP heredoc and nowdoc, Ruby heredocs, `%q`-style literals and `#{}`). A line is prose only when it is wholly inside a block comment (`/* */`, nested in Rust, Kotlin, Swift and Scala; `=begin`/`=end` at column 0) or a Python docstring (a triple-quoted statement that is the first of the module or follows a `def` or `class` header, with nothing after it). String data after `return`, `=`, `(`, `:`, `+`, `,`, `yield` or `lambda`, a template literal, a raw string or a heredoc is never prose, so `/*` in a gitignore body or SQL hint opens nothing. It fails closed: an unterminated string or comment, an unknown extension, or anything it cannot classify marks nothing for the file and every check there is held as in 3.7.0. Code syntax stays a second guard (a comparison or logical operator, an assignment, a call, a leading statement keyword, a brace or semicolon, a decorator `@name`, a Ruby symbol argument, a bang call such as `authorize!`, an object-literal entry `key: value,`). Inside a quoted literal a matched facet is a value unless it starts with `--` (a long flag) or `/` (a route or path), as in 3.7.0; the additions are a one-letter flag (`-v`), a file name with a known extension (a person or customer name inside a file name is shown), a command phrase with a `--long-flag`, and a name a surface detector found on the same line. Short flags with a value (`-ptopsecret`), dotted names (`john.smith`, `user.created`) and hyphenated words are withheld unless a detector names them. A doc that lists the located file in its `sources` (a file at most 5 docs cite) and whose title shares a question term is a target even when it cites many files. Value overlap (3.8.0 security review): a facet is withheld when ANY match of it on ANY located line overlaps a value span, so `-pSup3rS3cretPw` and `-usvc:pw` (the value starts after `-p`/`-u`) are withheld, not only a facet wholly inside a value; the 3.7.0 wholly-inside rule still holds as well. An option argument is a value when it is a short flag with attached characters (`-pX`, `-uX`, `-hX`, always), when the long flag names a value or a person (`--password`, `--token`, `--user`, `--username`), or when the argument is not a plain lowercase word (digits, mixed case, a separator other than `-`, key-shaped); `--omit=dev` and `--omit dev` stay names. A command phrase is a name only when its first word is a known tool (npm, npx, yarn, pnpm, pip, pipx, poetry, uv, git, docker, kubectl, helm, terraform, make, cargo, go, node, deno, bun, python, python3, ruby, bundle, rake, rails, gem, mvn, gradle, dotnet, hewtd, gh) and every other word is a `--flag` that is not a value name or a lowercase subcommand word that is not a value name; a word after a flag without `=` is never allowed, so `ledger deploy swordfish --prod` and `su postgres --login` are values. A facet whose exact text is a surface name the detector found on that line is not counted as an overlap. A name that also sits inside a quoted value on a line (`# emits user.created, see "user.created"`) is withheld. `gate:gaps` now has 31 checks.

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
