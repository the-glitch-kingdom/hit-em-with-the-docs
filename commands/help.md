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
- `knowledge-base` / `kb` — explain the 3 KB tiers + symptoms field; config `vault.root`, `vault.playbook_paths` (globs `find-citers`, `audit-facts` scan for playbooks) and `vault.audit_window_days` (default 90; `audit-facts --window <days>` overrides it); point at `docs/knowledge-base-primitives.md` and `templates/knowledge-base/`
- `commands` — list every `hewtd` CLI command with a one-line purpose
- `audit` — explain `hewtd audit` + `--strict`; explain when to use each
- `integrate` — explain `hewtd integrate <file>` and when to use it
- `templates` — list available templates with paths
- `domains` — explain the 15 built-in domains + custom domains (`hewtd domain add/remove/list`, 2.6.0+)
- `archive` / `deprecation` — explain the archival workflow (`hewtd archive/unarchive/archive-candidates`, 2.7.0+)
- `reconcile` — explain the doc-vs-code pass: triage lanes, reference statuses (`ok`, `missing`, `unknown` = not checkable), deciding every `missing` ref (fix it with a `patch`, or list it in `external_refs`), the `--write-review` / judge / `--apply` loop, `sources` merge (`sources_remove` to drop one), landed `rewrite` drafts, `--status`; the one ending for every created or updated doc (`--changed`); cold rotation (`--stage`, `--staged`, `--promote`, `--undo`, `--generations`, `reconcile.cold_root`, `cold_storage`); config under `reconcile` in `.claude/hit-em-with-the-docs.json`: `require_review` (boolean, default false: the pre-commit hook blocks while docs are unreviewed), `schema_sources` (globs; table and column refs stay `unknown` until it is set), `search_command` (argv template with `{query}`; `--overview` lists its results first, then the built-in ranking); point at `docs/reconcile.md` and `/hit-em-with-the-docs:reconcile`
- `graph` — explain `hewtd index` (aliased `reindex`): it regenerates the INDEX/REGISTRY files and writes `.hewtd/graph.json` (per doc resolved and missing refs, change dates, reconcile verdict, a symbol index); the export is incremental via a cache, `--no-graph` skips it, `graph_export: false` turns it off; point at `docs/graph-export.md`
- `rotation` — explain cold rotation (3.2.0): `reconcile --stage <dir>`, `--staged <dir>` (any mode on the copy, live tree untouched), `--promote --staged <dir> [--confirm]` (swap in, keep the old tree as a committed generation (files read-only, directories untouched) under `reconcile.cold_root`, default `.documentation-cold`), `--undo <gen> --confirm`, `--generations [--json]`, the `cold_storage` manifest, audit warnings on a CHANGED or MISSING generation (`checksum` covers committed files, `disk_checksum` all files; a fresh clone shows `ok (disk-only files absent: N)`), promote and undo refusing an invalid plugin config, that promote allowlists the cold root in `.gitleaks.toml` (created with `[extend] useDefault = true` if absent) and `.secrets.baseline` (3.2.1; `reconcile.cold_scanner_allowlist: false` opts out; undoing the last cold generation restores them, an older one keeps the allowlist for the newer; a dotted-key gitleaks allowlist and trufflehog need a hand-made exclude), that the plan warns about flagged and unreviewed (`DOCS_UNREVIEWED`) docs, and that cold secret findings stay in git history so rotate them; point at `docs/cold-rotation.md`
- `secrets` — explain the secret scan: `hewtd reconcile --secrets` (masked findings), `hewtd secrets --staged`, the `--baseline-add <file:line> --reason` / `--baseline-prune` baseline in `.hewtd/secrets-baseline.json`, and the opt-in `hewtd hooks install|uninstall` pre-commit block; false positives go in `reconcile.secrets.allow` (fingerprint or pattern, with a reason), and `reconcile.secrets.disabled_rules` turns a whole rule off (use sparingly: it hides real findings of that rule); point at `docs/write-time-guards.md`

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

Common options (run `hewtd <cmd> --help` for each command's full list):
- `-p, --path <path>` (`-p, --docs-path` on `reconcile`, `secrets`, `hooks`, `fix-retrieval-fields`): the docs folder, default `.documentation`
- `-d, --domain <domain>`: limit the command to one domain (`audit`, `index`, `metadata-sync`, `link-check`), or pick the target domain (`integrate`, which then adds no detected extra domain)
- `--force`: override the command's safety check. It means something different per command: overwrite existing files (`init`), integrate despite duplicates (`integrate`), archive a doc active docs still link to (`archive`), migrate onto an existing folder (`migrate-incident`)

- `init` — scaffold a `.documentation/` tree
- `maintain` — full maintenance pass (sync metadata, check links, audit, generate KB indexes)
- `audit [--strict]` — compliance check
- `link-check` — internal link validation
- `metadata-sync` — backfill missing frontmatter fields
- `integrate <file>` — auto-classify and copy a raw markdown file into the tree (the original stays; it refuses to overwrite a different doc of the same name), then report its reconcile lane, missing refs and next step; `--review` also writes the review skeleton (the single-doc form of `reconcile --changed --write-review`). Never invents a `purpose`. Start new docs from `templates/doc.template.md`
- `discover patterns|anti-patterns|standards|dependencies` — extract conventions from source code (`discover patterns --category <cat> --language <lang> --root <path>` narrows the scan)
- `report health|audit|links` — generate detailed reports
- `list` — list the built-in domains
- `domain list|add|remove` — manage custom domains (2.6.0+); `add <id> -k <keywords> [--name <name>] [--description <desc>] [--category <category>]` registers + scaffolds a project-specific domain
- `archive <file>` — deprecate a doc into `archive/` (reversible, link-safe, reindexes) (2.7.0+)
- `unarchive <file>` — restore an archived doc to its domain folder (2.7.0+)
- `archive-candidates` — advisory list of docs worth retiring (2.7.0+)
- `index` (alias `reindex`) `[--dry-run|--no-graph|-d <domain>]` — regenerate every domain + root INDEX/REGISTRY from the docs on disk and write the `.hewtd/graph.json` export
- `reconcile <scope> [--json|--write-review|--apply <files>|--status|--next N|--serial|--team|--outside|--secrets|--overview "<q>"|--gaps <file>|--changed|--check|--cached|--stage <dir>|--staged <dir>|--promote --confirm|--undo <gen> --confirm|--generations]` — deterministic triage, review files and serial apply for the reconcile pass (the judging is the slash command). `--changed` selects the docs created or changed since their last review (scope args optional, no clean-tree check): the one ending for every create or update is `reconcile --changed --write-review`, judge each entry yourself (verify, sources, external_refs, purpose, symptoms), `--apply`; `--changed --check [--cached]` is the advisory form the pre-commit hook runs (exit 1 only with `reconcile.require_review: true`). `--stage <dir>` / `--staged <dir>` / `--promote` / `--undo` / `--generations` are cold rotation (see the `rotation` topic)
- `secrets [--staged|--baseline-add <file:line> --reason "..."|--baseline-prune]` — secret scan baseline; `--staged` scans only the lines a staged diff adds (exit 1 on a finding). Never prints a value
- `hooks install|uninstall` — add or remove the opt-in pre-commit block that runs `hewtd secrets --staged`; never overwrites an existing hook
- `find-citers <fact-id>` — list the playbooks and incidents that cite a fact
- `audit-facts [--run-verify <id>|--run-verify-all|--window <days>]` — report facts past their review window; re-run a fact's `verify_command`
- `cite <fact-id> -f <playbook>` — insert a `cites:` entry into a playbook's symptom (`--alert-name`, `--user-phrase`, `--error-pattern` pick the symptom; `--dry-run`)
- `migrate-incident <flat-file>` — convert a legacy flat-file incident into the folder form (`narrative.md` + `facts.md`)
- `fix-legacy-layout` — move incident folders written by the buggy 2.3.0 `migrate-incident` into `<vault>/incidents/`; idempotent
- `extract-facts <incident-folder>` — write accepted fact specs to `<vault>/facts/` (the specs come from the slash command)
- `update` / `policy [auto|nudge|off]` / `status` / `relink` — plugin maintenance: install the latest version, get or set the update policy, show version and hook state, refresh skill symlinks
- `search <query>` — search documentation (for ranked search over the docs tree with an optional external command, see `reconcile --overview` and `reconcile.search_command`)
- `fix-retrieval-fields [--apply]` — move `summary`/`description` into `purpose`, merge `keywords` into `tags` (dry run by default); drops filler, clears generator-fallback purposes (2.12.0+, filler 2.14.0)

Slash commands (Claude Code):
- `/hit-em-with-the-docs:domain` — add/remove/list custom domains (2.6.0+)
- `/hit-em-with-the-docs:archive` — deprecate/restore docs, or list candidates (2.7.0+)
- `/hit-em-with-the-docs:reconcile <scope>` — check existing docs against the code, propose fixes, apply only what you accept (serial or agent team); `--next N`, `--status`, `--outside`
- `/hit-em-with-the-docs:find-citers`, `/hit-em-with-the-docs:audit-facts`, `/hit-em-with-the-docs:cite` — the knowledge-base CLI commands of the same names
- `/hit-em-with-the-docs:extract-facts` — propose atomic facts from an incident narrative; you accept, edit or reject, then the accepted ones are committed
- `/hit-em-with-the-docs:migrate-incident` — convert a legacy flat-file incident into the folder form
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

**Optional reconcile fields:** `sources` (files a doc was checked against; `reconcile --apply` merges new ones into it, never replaces) and `external_refs` (names or paths the doc cites that cannot be checked in this repo, such as third-party names, other products' files, negation or history, placeholders; reconcile treats them as not checkable, so they never count as `missing`). `last_verified` is stamped only by a `verify` or `rewrite` verdict. A `fields` or `phrases` apply on a doc whose review still holds keeps that review (verdict and `reviewed_on`) and records `fields_on` instead.

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

- **docs/reconcile.md** — the reconcile pass, reference statuses, review-file format
- **docs/graph-export.md** — `.hewtd/graph.json` schema and the incremental index
- **docs/write-time-guards.md** — secret scan, baseline, pre-commit hook
- **README.md** — full reference (long; use the index)
- **docs/LLM-GUIDE.md** — concise agent-facing guide (this is the cheat sheet)
- **docs/knowledge-base-primitives.md** — KB schema reference + error codes table
- **docs/retrieval-fields.md** — retrieval fields, `RETRIEVAL_*` codes and fixes, config
- **docs/plan-tier-frontmatter.md** — plan-tier reference (added in 2.2.0)
- **CHANGELOG.md** — recent changes, version history

After giving the orientation, ask the user: "What would you like to do next?" and wait. Don't speculatively run commands.
