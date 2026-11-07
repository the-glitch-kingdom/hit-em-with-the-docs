---
description: Brief the LLM on hit-em-with-the-docs' surface (commands, primitives, frontmatter contract, knowledge-base workflow) and orient the user.
allowed-tools: Bash(npx:*), Read
argument-hint: "[topic]"
---

Arguments: $ARGUMENTS

You are working in a project that uses **`@theglitchking/hit-em-with-the-docs`** (hewtd) — a self-managing documentation system. Your job in this turn is to orient the user (and yourself) on hewtd's surface and offer a next step.

## When the user invokes this command

If `$ARGUMENTS` is empty, give a tight orientation (what hewtd does, the 5 most common workflows, the commands available). Don't dump everything — focus on what's actionable in this project's current state. End with a question: "What would you like to do?"

If `$ARGUMENTS` matches one of the topics below, focus the orientation on that topic specifically:
- `frontmatter` — explain the 22-field schema, the 9 tiers, and per-tier required fields
- `knowledge-base` / `kb` — explain the 3 KB tiers + symptoms field; point at `docs/knowledge-base-primitives.md` and `templates/knowledge-base/`
- `commands` — list every `hewtd` CLI command with a one-line purpose
- `audit` — explain `hewtd audit` + `--strict`; explain when to use each
- `integrate` — explain `hewtd integrate <file>` and when to use it
- `templates` — list available templates with paths
- `domains` — explain the 15 built-in domains + custom domains (`hewtd domain add/remove/list`, 2.6.0+)
- `archive` / `deprecation` — explain the archival workflow (`hewtd archive/unarchive/archive-candidates`, 2.7.0+)

## What hewtd does (the one-paragraph brief)

`hewtd` manages a `.documentation/` tree organized into 15 domains (security, devops, database, api, standards, testing, architecture, features, quickstart, procedures, workflows, agents, backups, troubleshooting, plans). Every document carries YAML frontmatter validated against a 22-field schema with 9 tiers (`guide`, `standard`, `example`, `reference`, `admin`, `plan`, `fact`, `incident-narrative`, `incident-facts`). It also generates auto-indexes, audits docs for compliance, checks links, and as of 2.3.0 manages a knowledge-base subtree at `.documentation/knowledge-base/` with citable facts, postmortem incidents, and playbook-symptom mappings.

## The 5 most common workflows

1. **Adding a new doc** — write the markdown with the right frontmatter, place it in the appropriate domain folder, run `hewtd maintain` to update indexes. Use `hewtd integrate <file>` if you have a raw markdown file that needs auto-classification first.
2. **Checking doc health** — `hewtd audit` (errors + warnings) or `hewtd audit --strict` (KB-coded errors fail CI).
3. **Creating a fact in the knowledge base (2.3.0+)** — copy `templates/knowledge-base/fact.template.md` into `<vault-root>/facts/<kebab-id>.md`, fill in required fields (`id`, `confidence`, `last_verified`, `provenance`).
4. **Documenting an incident (2.3.0+)** — create `<vault-root>/incidents/YYYY-MM-DD-slug/` with both `narrative.md` and `facts.md` from the templates.
5. **Enriching a playbook (2.3.0+)** — add a `symptoms:` block to a playbook's frontmatter; cite the facts the playbook depends on.
6. **Deprecating / retiring a doc (2.7.0+)** — `hewtd archive <file>` moves a stale doc into `.documentation/archive/` (excluded from all scans), reversibly and link-safely. Run `hewtd archive-candidates` to see what's worth retiring; `hewtd unarchive <file>` to bring one back.

## Commands available

CLI (via `npx --no @theglitchking/hit-em-with-the-docs <cmd>` or `hewtd <cmd>` if globally installed):

- `init` — scaffold a `.documentation/` tree
- `maintain` — full maintenance pass (sync metadata, check links, audit, generate KB indexes)
- `audit [--strict]` — compliance check
- `link-check` — internal link validation
- `metadata-sync` — backfill missing frontmatter fields
- `integrate <file>` — auto-classify and place a raw markdown file
- `discover patterns|anti-patterns|standards|dependencies` — extract conventions from source code
- `report health|audit|links` — generate detailed reports
- `list` — list the built-in domains
- `domain list|add|remove` — manage custom domains (2.6.0+); `add <id> -k <keywords>` registers + scaffolds a project-specific domain
- `archive <file>` — deprecate a doc into `archive/` (reversible, link-safe, reindexes) (2.7.0+)
- `unarchive <file>` — restore an archived doc to its domain folder (2.7.0+)
- `archive-candidates` — advisory list of docs worth retiring (2.7.0+)
- `search <query>` — search documentation
- `fix-retrieval-fields [--apply]` — move `summary`/`description` into `purpose`, merge `keywords` into `tags` (dry run by default) (2.12.0+)

Slash commands (Claude Code):
- `/hit-em-with-the-docs:domain` — add/remove/list custom domains (2.6.0+)
- `/hit-em-with-the-docs:archive` — deprecate/restore docs, or list candidates (2.7.0+)
- `/hit-em-with-the-docs:status` — installed version, update policy, hook state
- `/hit-em-with-the-docs:policy [auto|nudge|off]` — get/set update policy
- `/hit-em-with-the-docs:update` — pull the latest version
- `/hit-em-with-the-docs:relink` — re-run skill linker
- `/hit-em-with-the-docs:help` — this command

## Frontmatter contract (the short version)

**Required for every doc:** `title`, `tier`, `domains` (array, ≥1), `status`, `last_updated` (YYYY-MM-DD), `version` (semver).

**Exception — lifecycle-tracked tiers** (`plan`, `fact`, `incident-narrative`, `incident-facts`): `version` is **optional**, and `status` is free-form. These tiers have their own required-field extensions:
- `fact`: `id`, `confidence`, `last_verified`, `provenance` (≥1 entry)
- `incident-narrative`: `id`, `date`, `severity`, `resolution_status`, `components`
- `incident-facts`: `incident_id`, `produced` (may be empty)

**Retrieval fields (2.12.0+):** write `purpose` (one sentence) and `symptoms` (plain strings, any tier) on every doc. `hewtd audit` raises advisory `RETRIEVAL_*` warnings when they are missing, weak, generic or duplicated; they never fail the audit. See `docs/retrieval-fields.md`.

**Overview docs (2.13.0+):** a `kind: overview` doc (template `templates/overview.template.md`) links every stage of a cross-cutting flow. `hewtd audit` raises advisory `OVERVIEW_MISSING` / `OVERVIEW_STALE_LINKS` warnings for flows of 5+ docs; they never fail the audit. Config: `overview` block (`min_cluster_size`, `min_link_coverage`, `backlinks`, `disabled`). `hewtd maintain --fix` edits doc bodies to add `Part of:` back-links; set `overview.backlinks: false` to stop it.

Full reference: `docs/knowledge-base-primitives.md` and `docs/plan-tier-frontmatter.md`.

## Templates

For knowledge-base authoring, four templates ship at `templates/knowledge-base/`:
- `fact.template.md`
- `incident-narrative.template.md`
- `incident-facts.template.md`
- `playbook-symptoms.template.md` (frontmatter snippet)

When asked to create one of these, **read the template first**, replace every `<placeholder>` with concrete content, and run `hewtd audit --strict` on the parent dir to confirm.

## Where to find more

- **README.md** — full reference (long; use the index)
- **docs/LLM-GUIDE.md** — concise agent-facing guide (this is the cheat sheet)
- **docs/knowledge-base-primitives.md** — KB schema reference + error codes table
- **docs/retrieval-fields.md** — retrieval fields, `RETRIEVAL_*` codes and fixes, config
- **docs/plan-tier-frontmatter.md** — plan-tier reference (added in 2.2.0)
- **CHANGELOG.md** — recent changes, version history

After giving the orientation, ask the user: "What would you like to do next?" and wait. Don't speculatively run commands.
