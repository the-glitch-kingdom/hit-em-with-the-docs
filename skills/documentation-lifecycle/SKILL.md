---
name: documentation-lifecycle
description: Create, update, retire, or reorganize documentation in a project managed by hit-em-with-the-docs (a `.documentation/` tree with domain folders). Use when writing a new doc, updating an existing one, deleting/deprecating/archiving a doc, fixing a broken docs link, wondering where a doc belongs, or when an INDEX.md/REGISTRY.md looks out of date. Also use when a tool call was denied by the hewtd lifecycle guard, or when logging an incident, recording a fact or gotcha, or otherwise working in the knowledge base (`.documentation/knowledge-base/`).
---

# Documentation lifecycle (hit-em-with-the-docs)

This project's docs live in `.documentation/`, split into domain folders. hewtd
owns that tree: it classifies documents, maintains their frontmatter, generates
the indexes, checks the links, and retires docs without destroying them.

**The one thing to internalize:** `INDEX.md` and `REGISTRY.md` are *generated*.
They are rebuilt from the documents on disk on every `hewtd index` / `hewtd
maintain`. Editing them by hand accomplishes nothing — your rows are overwritten
on the next run. To change what an index says, change the documents, then
regenerate.

Run every command with `npx hit-em-with-the-docs …` (or `hewtd …`).

## Creating a doc

Write the markdown wherever is convenient, then:

```bash
hewtd integrate path/to/new-doc.md          # classifies + moves + registers it
hewtd integrate path/to/new-doc.md --dry-run  # preview the chosen domain first
```

`integrate` picks the domain from `--domain <id>` if given, else the doc's own
first `domains:` entry, else by keyword-matching the content. It moves the file
into `.documentation/<domain>/`, stamps frontmatter (`status: draft`, `tier:
guide`, `version: 1.0.0`, `last_updated`, `word_count`), and regenerates the
indexes. It never overwrites frontmatter you wrote yourself — it only fills what
is missing.

A markdown file left outside `.documentation/` is invisible to hewtd: not
indexed, not link-checked, not validated. Don't hand-create `docs/` folders.

### The `status` vocabulary is extensible

`draft`, `active`, `deprecated`, `archived` are built in and always valid. A
project may declare **additional** values in `.claude/hit-em-with-the-docs.json`
under `status: []` — e.g. `complete`, `current`, `in_progress`.

Check that config before "fixing" a `status:` you don't recognize. If the value
is declared there it is correct, and rewriting it to `active` is the drift, not
the fix. Match the vocabulary the corpus already uses when authoring new docs.

Note that `status` and `implementation_status` are separate fields with separate
vocabularies — `complete` is a built-in *`implementation_status`* value and leaks
onto `status` constantly.

## Updating a doc

Edit the document normally, then:

```bash
hewtd maintain --quick     # regenerate indexes + sync metadata
hewtd maintain --fix       # also auto-fix what it can
```

Never hand-edit `INDEX.md` or `REGISTRY.md` — a `PreToolUse` guard denies it.

## Retiring a doc

**Documents are never deleted.** hewtd's own source contains no `rm`/`unlink`
calls anywhere, and the guard denies shell deletion of anything under
`.documentation/`.

Two distinct steps, often confused:

| | What it does |
|---|---|
| `status: deprecated` | Flags *intent*. The doc stays in its domain folder, still indexed, still scanned. `audit` raises an INFO nudge toward archiving. |
| `hewtd archive <file>` | Actually retires it. |

```bash
hewtd archive .documentation/api/old-guide.md --dry-run
hewtd archive .documentation/api/old-guide.md -r "superseded by v2 guide"
hewtd unarchive .documentation/archive/api/old-guide.md   # lossless restore
```

`archive` moves the doc to `archive/<same-subpath>/` (preferring `git mv` to keep
history), stamps `status: archived`, `archived_on`, `archived_from`, and
`archived_reason`, and reindexes so it drops out of its domain INDEX. The
`archived_from` stamp is what makes `unarchive` exact — **a hand-rolled `mv`
loses it**, and there is then nothing to restore from.

**Link guard:** `archive` refuses if active docs still link to the target,
listing each offender so you can fix them first. `--force` overrides, and the
inbound links go dangling.

`hewtd archive-candidates` lists docs that may warrant retiring — advisory and
read-only, it never moves anything. Nothing is ever auto-archived.

Point a replacement at the old doc with `superseded_by: <path>` in frontmatter.

## Archived content: referenceable, never concrete

**Anything under an `archive/` folder — at any depth — is history, not truth.**

It is excluded from every hewtd scan: not indexed, not audited, not
link-checked, not metadata-validated, never counted. Links *into* it still
resolve, so history stays reachable and you may cite it as "what we used to do."

What it is **not** is evidence of how the system works now. Never quote an
archived doc as current behavior, never carry its claims into a new doc, and
never treat a `status:`/`version:` inside it as live. If it turns out an archived
doc is still correct and still needed, it should be restored, not read in place:

```bash
hewtd unarchive .documentation/archive/api/old-guide.md
```

Editing a file under `archive/` is not destructive, but it is almost always a
mistake — the edit lands in a subtree nothing reads, so it changes nothing anyone
will see. The guard warns when you try.

## The knowledge base

Alongside the domain docs, `.documentation/knowledge-base/` (the vault; its
location is `vault.root` in `.claude/hit-em-with-the-docs.json`) holds
operational knowledge in three tiers, each with a template in
`templates/knowledge-base/`:

- **Incidents:** `incidents/YYYY-MM-DD-<slug>/` holding `narrative.md` (tier
  `incident-narrative`: what happened) and `facts.md` (tier `incident-facts`:
  which facts it produced, strengthened or weakened).
- **Facts:** `facts/<id>.md` (tier `fact`), one atomic claim each, with
  `confidence`, `last_verified`, `provenance` and ideally a `verify_command`.
  Gotchas are facts tagged `gotcha`, with an `## Instead` section.
- **Symptoms:** a `symptoms:` block in a playbook's frontmatter maps an alert
  name, user phrase or error pattern to a section of the playbook, and `cites:`
  the facts that step relies on. `symptoms/INDEX.md` is generated from them.
  A fact may also carry `symptoms:` as plain strings of literal error text
  (`- "pkill -f: Exit code 144"`); only facts may use that form.

Logging an incident:

```bash
# 1. write incidents/<YYYY-MM-DD-slug>/narrative.md (or convert an old flat file:)
hewtd migrate-incident path/to/old-incident.md --dry-run
# 2. turn the narrative into facts (the slash command proposes, this writes)
/hit-em-with-the-docs:extract-facts incidents/<YYYY-MM-DD-slug>/
# 3. give the playbook that handles it a symptoms: entry (playbook-symptoms
#    template), then cite the fact from it
hewtd cite <fact-id> -f <playbook.md> --error-pattern '<pattern>'
# 4. check it
hewtd maintain && hewtd audit --strict
```

`hewtd audit-facts` lists facts past their review window;
`--run-verify <id>` re-checks one and `--run-verify-all` re-checks every fact
with a `verify_command`. `/hit-em-with-the-docs:help` covers the rest.

## Checking the tree

```bash
hewtd audit                # policy + drift violations, health score
hewtd link-check           # broken internal links
hewtd index --dry-run      # what the indexes would become
```

`audit`'s `index-drift` rule reports any document on disk that its domain's
`INDEX.md` fails to list — the fix is always `hewtd index`.

## If the guard denied your tool call

It denies exactly two things, both destructive:

- **Editing a generated `INDEX.md`/`REGISTRY.md`** → change the documents and run
  `hewtd index`.
- **Deleting a doc under `.documentation/`** → use `hewtd archive` instead.

Both rules are opt-out via `.claude/hit-em-with-the-docs.json`:

```json
{ "enforcement": { "block_index_edits": true, "block_doc_deletion": true } }
```

Turning one off is a deliberate choice by the human who owns the repo — not
something to do to get past a denial.
