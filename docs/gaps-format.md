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
| `gaps[].query` | yes | The reader's words. Whitespace is collapsed and trailing punctuation dropped; the wording is kept. |
| `gaps[].used_doc` | no | The doc the reader finally used, or `null`. Docs-relative, vault-relative (`.documentation/...`) or absolute; resolved against the docs root. An unknown, archived, secret-lane, non-markdown or generated (`generated: true`, such as `INDEX.md`) doc is treated as no doc (unknown paths are also reported). |
| `gaps[].suggested` | no | `symptoms.user_phrase` or `new doc`. A hint only; hewtd re-derives the outcome. |
| `gaps[].count` | no | Integer >= 1. Ranks gaps and picks the winning wording among near-duplicates. |
| `gaps[].last_seen` | no | `YYYY-MM-DD`. |

## Hand-written

No search tool needed. Any of these work:

- A bare array of gap objects (the same objects as above).
- A JSON array of strings: `["how do I roll back a deploy", "where is the rls check"]`.
- A plain text file, one question per line (blank lines and lines starting with `#` are skipped).

Questions without a usable `used_doc` have no doc to attach to, so they become new-doc candidates or open questions.

## Errors

An invalid entry is reported with its index (`gaps[3]: ...`) and skipped; the rest are kept. Never put doc text or secrets in the file: every query is secret-scanned and a hit is dropped with a masked note.

Reader: `parseGaps` in `src/core/reconcile/gaps.ts`.
