# LLM guide to `hit-em-with-the-docs`

> A concise, agent-facing brief on what this plugin does and the specific workflows you'll perform. **Read this first** when working in a project that uses hewtd. For complete reference, see README.md (long).

## 30-second model

**hewtd manages `.documentation/`.** Every markdown file there has YAML frontmatter validated against a 9-tier, 22-field schema. The plugin scaffolds the tree, classifies new docs, audits for compliance, checks internal links, and (as of 2.3.0) maintains a knowledge-base subtree at `.documentation/knowledge-base/` with citable atomic facts, postmortem incidents, and playbook-symptom mappings.

You are the **writer**. The plugin is the **validator + indexer**. The user is the **owner** of what gets written.

## Decision tree

**Is the user asking you to add documentation?**
→ Determine the tier (see "Picking a tier" below). Write the markdown with proper frontmatter. Place it in the right domain folder. After saving, suggest the user run `hewtd maintain` (or do it via Bash if authorized).

**Is the user asking you to capture an incident or atomic fact?**
→ This is the 2.3.0 knowledge-base workflow. See "Knowledge-base authoring" below.

**Is the user reporting a doc-health issue (broken links, missing frontmatter, stale content)?**
→ Run `hewtd audit` (or `audit --strict` for CI-style checking). Triage the issues. Use `metadata-sync --fix` to backfill missing fields.

**Is the user just exploring or asking how to use hewtd?**
→ Invoke `/hit-em-with-the-docs:help`. Or quote relevant sections of this guide.

## Picking a tier

| Tier | Pick when... |
|---|---|
| `guide` | The doc walks the reader through doing something step-by-step. |
| `standard` | The doc defines conventions, rules, or "do / don't" patterns. |
| `example` | The doc is primarily code samples or templates. |
| `reference` | The doc is an exhaustive API/schema/specification listing. |
| `admin` | The doc covers operational procedures (deployment, monitoring, etc.). |
| `plan` | The doc is a phase/task/atom planning artifact (persistent-planning lg-mode). |
| `fact` | The doc is a single atomic citable claim (2.3.0+). |
| `incident-narrative` | The doc is a postmortem story (2.3.0+). |
| `incident-facts` | The doc bridges an incident to facts it produced (2.3.0+). |

If unsure, write 2-3 sentences of body, then ask `hewtd discover patterns` or read a few neighboring docs in the target domain to match style.

## Universal frontmatter (required, every doc)

Optional reconcile keys: `sources: [paths]` (merged by apply) and `external_refs: [names]` (cited things that cannot be checked in this repo). See "Reconcile in 3.x".

```yaml
---
title: <Human readable>
tier: <one of the 9 tiers>
domains:                # array, ≥1; see DOMAINS list below
  - <domain-name>
status: active          # draft | active | deprecated | archived (free-form for lifecycle-tracked tiers)
last_updated: YYYY-MM-DD
version: 1.0.0          # semver — OPTIONAL for lifecycle-tracked tiers
---
```

Lifecycle-tracked tiers (`plan`, `fact`, `incident-narrative`, `incident-facts`) skip `version` and use tier-specific status enums. See per-tier extensions in `docs/knowledge-base-primitives.md` and `docs/plan-tier-frontmatter.md`.

## Domains (15 built-in + custom)

There are **15 built-in domains** — part of the compiled contract, always present:

`security`, `devops`, `database`, `api`, `standards`, `testing`, `architecture`, `features`, `quickstart`, `procedures`, `workflows`, `agents`, `backups`, `troubleshooting`, `plans`.

Projects can add **custom domains** beyond these via `hewtd domain add <id> -k <keywords>` (2.6.0+). Custom domains are stored in `.claude/hit-em-with-the-docs.json` under `domains: []`, get a scaffolded `.documentation/<id>/` folder, and are then valid in the `domains:` frontmatter array just like a built-in. Run `hewtd domain list` to see the active set (built-in + custom). The `keywords` on a custom domain drive auto-classification in `hewtd integrate`.

Files belong in `<docs-path>/<domain>/<filename>.md`. The auditor warns when files appear to be in the wrong domain.

### Deprecation workflow (2.7.0+)

`archive/` is the parking lot for retired docs: hewtd **excludes the entire `archive/` subtree from every scan** (audit, link-check, metadata-sync, integrate dup-detection, link graph, search). Archived docs are not validated, never indexed, and won't break audit/link-check with stale frontmatter. `archive` is a reserved name (not a domain; `hewtd domain add archive` is rejected). As of **2.7.0** there's a real workflow around it instead of just the folder convention.

**`status: deprecated` vs `hewtd archive` — they're different steps.** Setting `status: deprecated` is a *signal* ("this is on its way out") — the doc stays in its domain folder, stays indexed, stays linkable. `hewtd archive` is the *retirement*: it physically moves the doc out of the active corpus. The audit now bridges the two — a doc left at `status: deprecated` in an active folder raises an INFO issue (`deprecated-not-archived`) that nudges toward `hewtd archive`. So: mark `deprecated` when you want to flag intent but keep the doc live; run `archive` when you're actually retiring it.

**`hewtd archive <file>`** moves a doc into `archive/<same-domain-subpath>/` (so `api/old.md` → `archive/api/old.md`), stamps lifecycle frontmatter (`status: archived`, `archived_on`, `archived_from`, and `archived_reason` if you pass `-r/--reason`), and regenerates indexes so the doc drops out of its domain INDEX. It prefers `git mv` (history-preserving) and falls back to a plain move outside a git repo. **Link guard:** by default it *refuses* if active docs still link to the target, and reports each linking doc — fix those links first, or pass `--force` to archive anyway (the inbound links become dangling). Use `--dry-run` to preview the move without touching anything.

**`hewtd unarchive <file>`** is the lossless reverse: it restores the doc to the path recorded in `archived_from`, sets `status: active`, and strips the `archived_*` fields. It refuses if the restore target already exists (no clobber).

**`hewtd archive-candidates`** is advisory and read-only — it lists docs that *may* warrant archiving with a score + reasons, and never moves anything. Signals, ranked: `status: deprecated` and `superseded_by:` are strong and each qualify a doc on their own; orphaned (zero inbound links) and stale (git-last-touched, or `last_updated` as fallback, older than `candidate_after_days`) are weaker — **age never qualifies a doc alone**, it only counts when the doc is *also* orphaned. The design rejects access-recency (hewtd has no read telemetry) and age-alone signals on purpose: docs aren't code, and an unchanged foundational doc is often the most important one, not the most disposable. Detection proposes; humans (or you, with the user's say-so) execute; nothing is ever auto-archived.

New lifecycle frontmatter fields the schema now recognizes: `superseded_by` (set by hand to point at the doc that replaces this one), and the archive-stamped `archived_on`, `archived_from`, `archived_reason`. To restore an archived doc, prefer `hewtd unarchive` over a manual move — it puts the doc back exactly where it came from and cleans up the stamp.

## Knowledge-base authoring (2.3.0+)

The KB subtree lives at `.documentation/knowledge-base/` by default (configurable via `.claude/hit-em-with-the-docs.json` → `vault.root`). That same config file also holds the `domains: []` array — custom domains added via `hewtd domain add` (2.6.0+). Each entry has `id`, `name`, `description`, `keywords` (≥1), `loadPriority` (1-10), and `category` (one of `core | development | features | advanced`). You normally don't hand-edit this; use `hewtd domain add/remove` (`add` takes `--name`, `--description`, `--keywords`, `--category`).

KB config (`vault` block): `vault.playbook_paths` (globs `find-citers` and `audit-facts` scan for playbooks, default `.documentation/**/*.md`) and `vault.audit_window_days` (default 90; `hewtd audit-facts --window <days>` overrides it). `hewtd cite <fact-id> --file <playbook>` targets one symptom with `--alert-name`, `--user-phrase` or `--error-pattern`.

```
<vault-root>/
├── facts/                    # one .md per fact, filename = id
├── incidents/
│   └── <YYYY-MM-DD-slug>/
│       ├── narrative.md      # the postmortem
│       └── facts.md          # bridge to produced/strengthened/weakened facts
└── (auto-generated indexes — don't edit by hand)
    ├── facts/INDEX.md
    ├── incidents/INDEX.md
    └── symptoms/INDEX.md
```

### Creating a fact

1. Pick a kebab-case id (e.g. `alloy-env-set-at-entrypoint-only`).
2. Copy `templates/knowledge-base/fact.template.md` into `<vault-root>/facts/<id>.md`.
3. Fill required fields: `id`, `confidence` (high|medium|low|hypothesis), `last_verified` (YYYY-MM-DD), `provenance` (≥1 entry pointing at incident, source path, or doc).
4. Optional but recommended: `verify_command` — a single shell command that proves the claim.
5. Body: `## Claim` (one paragraph), `## How to verify`, `## Consequences`.

### Creating an incident

1. Folder: `<vault-root>/incidents/YYYY-MM-DD-slug/` (date + kebab-case slug).
2. `narrative.md` from the template. Required: `id` (matches folder), `date`, `severity` (low|medium|high|critical), `resolution_status` (resolved|partial|open|planned), `components` (≥1).
3. `facts.md` from the template. Required: `incident_id` (matches narrative), `produced` (array, may be empty).

### Enriching a playbook

Playbooks stay where they are (`troubleshooting/`, `devops/`, etc.). Add a `symptoms:` block to the frontmatter — see `templates/knowledge-base/playbook-symptoms.template.md` for the snippet. Each entry needs one of `alert_name` | `user_phrase` | `error_pattern`, a `target` (anchor or path), and a non-empty `cites` array of fact ids. A **fact** may also list plain strings (literal error text for that fact, no target or cites); no other tier may.

## Commands you'll invoke

Use Bash to run these. They're all available via `npx --no @theglitchking/hit-em-with-the-docs <cmd>` (or `hewtd <cmd>` if installed globally).

| Command | When to run |
|---|---|
| `hewtd init` | Once, at project setup. Idempotent with `--force`. |
| `hewtd maintain` | After adding/changing docs. Updates indexes, runs full audit. |
| `hewtd audit` | Spot-check compliance. Exits 1 on errors. |
| `hewtd audit --strict` | CI gate. Exits 1 on any error OR any KB-coded violation. Stylistic warnings (naming, placement) don't fail strict. |
| `hewtd link-check` | Validate internal links. Run after moves/renames. |
| `hewtd metadata-sync --fix` | Backfill missing frontmatter fields. |
| `hewtd integrate <file>` | Auto-classify and place a raw markdown file. |
| `hewtd discover patterns` | Extract coding patterns from source code (`--language`, `--root`, `--category` such as `security` or `testing`). |
| `hewtd discover anti-patterns` | Detect anti-patterns in source code. |
| `hewtd report {health\|audit\|links}` | Generate a saved report. |
| `hewtd search <query>` | Cross-doc text search. |
| `hewtd list` | List all built-in domains. |
| `hewtd domain list` | List built-in + custom domains (mark each by kind). |
| `hewtd domain add <id> -k <keywords>` | Add a custom domain (keywords REQUIRED). Validates, writes config, scaffolds the folder. Use `--dry-run` to preview first. |
| `hewtd domain remove <id>` | Remove a custom domain from config. Never deletes docs — reports how many become orphaned. Can't remove a built-in. |
| `hewtd archive <file>` | Retire a doc: move it into `archive/`, stamp lifecycle frontmatter, reindex. Reversible. Link guard refuses if active docs still link to it — `--force` overrides; `--dry-run` previews; `-r/--reason` records why. |
| `hewtd unarchive <file>` | Restore an archived doc to its recorded `archived_from` path; clears the archive stamp. Refuses if the target already exists. |
| `hewtd index` (alias `reindex`) | Regenerate every INDEX/REGISTRY from disk and write `.hewtd/graph.json` (incremental via a cache since 3.1.4/3.1.5; `--no-graph` skips the export, `--dry-run` previews). |
| `hewtd reconcile <scope>` | Check existing docs against the code (2.15.0+). Deterministic triage; `--write-review` writes review files, `--apply <files>` applies accepted entries, `--status`, `--outside`, `--secrets [scope] [--json]` (masked secret scan, 2.17.0), `--overview "<q>"` (seed an overview from a question) and `--write-review --overview <members-file>` (2.18.0; verdicts `overview`, `merge`, `point` give one owner per fact). `--gaps <file> [--write-review]` (2.21.0; missed search queries become `user_phrase` proposals, new-doc candidates or open questions; format in `docs/gaps-format.md`). Judging is done by `/hit-em-with-the-docs:reconcile`. See `docs/reconcile.md` and "Reconcile in 3.x" below. |
| `hewtd secrets --staged` | Scan only lines the staged diff adds for secrets (2.19.0); exit 1 with masked findings. `--baseline-add <file:line> --reason "..."` and `--baseline-prune` manage `.hewtd/secrets-baseline.json`. See `docs/write-time-guards.md`. |
| `hewtd hooks install\|uninstall` | Opt-in pre-commit block running `hewtd secrets --staged` (2.19.0). Appended, never overwrites; uninstall is byte-exact. |
| `hewtd archive-candidates` | Advisory, read-only. List docs that may warrant archiving (score + reasons). Never moves anything. `--json` for machine output. |

## Reconcile in 3.x

- **Statuses:** each cited thing is `ok`, `missing` or `unknown`. `unknown` means not checkable (outside the repo, gitignored, a placeholder or regex, a `secret/` path with no such folder, or listed in `external_refs`) and never counts as `missing`.
- **Decide every `missing` ref.** The review skeleton prints `missing` (read-only) and an empty `external_refs: []` per entry. Fix the doc with a `patch`, or list the ref in `external_refs` (third-party names, other products' files, negation or history, placeholders). Apply unions `external_refs` into the doc's frontmatter (existing first, deduped) and never overwrites; it works for symbol-shaped and path-shaped names.
- **`sources` merge:** apply merges an entry's `sources` into the doc's (existing first, no duplicates); `sources_remove: [..]` drops one.
- **`rewrite`:** an accepted draft replaces the body in the batch commit; the doc's frontmatter is kept and merged. Warnings list dropped anchors others link to and dropped cited paths.
- **`--write-review` on named docs** includes clean-lane docs (for a sources-only fix-up); `--next` skips them.
- **`--status`** also prints, for reviewed docs, refs covered by `external_refs` vs still missing (needs `.hewtd/graph.json`).
- **`--status`** also prints "reviewed, metadata updated since": reviewed docs (any kept verdict) where a `fields`/`phrases` apply touched the metadata (the same day counts). Such an apply keeps the earlier verdict and `reviewed_on` (new ledger key `fields_on`) while the doc is unchanged since that review (#92).
- **Table and column refs** are `unknown` until `reconcile.schema_sources` lists schema globs (for example `["**/migrations/**/*.sql"]`); triage prints the schema files it found.
- **`reconcile.search_command`:** optional argv template with a `{query}` placeholder (no shell, 30 s timeout) that `--overview` runs; the doc paths it prints come first, then the built-in BM25 ranking. If it fails, reconcile warns and uses BM25.
- **Secret false positives:** `reconcile.secrets.allow` (fingerprint or pattern, with a `reason`) excuses one finding; `reconcile.secrets.disabled_rules` turns a whole rule off and hides its real findings too, so prefer `allow`.
- **Secrets:** a repo path value such as `tokens: config/theme/theme.data.json` is not a `generic-secret` finding when that file exists in the repo.

## Slash commands (Claude Code)

| Command | What it does |
|---|---|
| `/hit-em-with-the-docs:help` | Orient yourself or the user on hewtd's surface |
| `/hit-em-with-the-docs:status` | Show installed version, update policy, hook state |
| `/hit-em-with-the-docs:policy [auto\|nudge\|off]` | Get/set the update policy |
| `/hit-em-with-the-docs:domain list\|add\|remove` | Manage custom domains (add confirms via dry-run; remove confirms the orphaned-doc count before applying) |
| `/hit-em-with-the-docs:reconcile <scope>` | Reconcile existing docs with the code; proposes fixes, applies only what you accept (`--next N`, `--status`, `--outside`) |
| `/hit-em-with-the-docs:archive` | Deprecate/restore docs or list candidates |
| `/hit-em-with-the-docs:find-citers`, `audit-facts`, `cite`, `extract-facts`, `migrate-incident` | Knowledge-base workflows (prefix each with `/hit-em-with-the-docs:`) |
| `/hit-em-with-the-docs:update` | Update to the latest version |
| `/hit-em-with-the-docs:relink` | Re-run the skill linker (no-op for hewtd; useful for plugin-stack debugging) |

## Validation: error codes

When `hewtd audit` reports an `AuditIssue.code`, it's one of the 2.3.0 KB error codes. The full list lives in `docs/knowledge-base-primitives.md` ("Error codes" table). The most common ones you'll need to fix:

- `FACT_MISSING_ID` — fact has no `id` or `id` is not kebab-case
- `FACT_INVALID_CONFIDENCE` — `confidence` is not one of high|medium|low|hypothesis
- `FACT_MISSING_PROVENANCE` — `provenance` empty or missing
- `INCIDENT_NARRATIVE_INVALID_SEVERITY` — `severity` is not in enum
- `PLAYBOOK_SYMPTOM_MISSING_TARGET` — a `symptoms[]` entry has no `target`
- `PLAYBOOK_SYMPTOM_MISSING_CITES` — a `symptoms[]` entry has empty `cites`

### Retrieval warnings (2.12.0+)

`hewtd audit` also raises advisory warnings, never errors and never a failing
exit code: `RETRIEVAL_MISSING_PURPOSE`, `RETRIEVAL_WEAK_PURPOSE`,
`RETRIEVAL_GENERIC_TITLE`, `RETRIEVAL_MISSING_SYMPTOMS`, `RETRIEVAL_OVERSIZED`,
`RETRIEVAL_NEAR_DUPLICATE`. Write `purpose` and `symptoms` on every new doc.
To move old `summary`/`description` values into `purpose`, run
`hewtd fix-retrieval-fields` (dry run) then `--apply`. Fixes for each code are
in `docs/retrieval-fields.md`.

`fix-retrieval-fields` also drops filler `summary`/`description` and clears a
`Documentation for <title>` purpose. `hewtd index` is the upgrade step for
pre-2.13 trees (rebuilds KB indexes, stamps old reports). Commands find
`.documentation` from any subdirectory; `integrate` refuses a file already in
the docs tree at a different path (use `maintain --fix` / `metadata-sync`).

### Overview docs (2.13.0+)

`kind: overview` marks a doc that links every stage of a cross-cutting flow
(template: `templates/overview.template.md`; `kind` accepts only `overview`).
`hewtd audit` raises advisory `OVERVIEW_MISSING` and `OVERVIEW_STALE_LINKS`
warnings (never a failing exit code), one per dense flow, for flows of `min_cluster_size` docs
or more. Config: an `overview` block (`min_cluster_size` 5, `min_link_coverage`
0.6, `backlinks` true, `disabled` []). `hewtd maintain --fix` now edits doc
bodies, inserting `Part of: [Title](...)` back-links to the overview.
Details: `docs/retrieval-fields.md`.

## What NOT to do

- **Don't write to `<vault-root>/{facts,incidents,symptoms}/INDEX.md`** — those are auto-generated. Edits will be overwritten on the next `hewtd maintain`.
- **Don't invent new tiers** — the 9 in this guide are exhaustive. If you think you need a new tier, ask the user.
- **Don't drop docs into an undeclared domain folder.** If a doc genuinely needs a new domain, the supported path is `hewtd domain add <id> -k <keywords>` (which registers it + scaffolds the folder) — not hand-creating a `.documentation/<id>/` folder. Ask the user before adding a domain.
- **Don't skip frontmatter** — every doc in `.documentation/` needs it. The auditor will flag missing fields.
- **Don't move docs between domains without running `hewtd link-check` afterward** — internal links break silently otherwise.
- **Don't manually quote dates in YAML if you don't have to** — as of 2.3.0, both `last_updated: 2026-05-14` and `last_updated: '2026-05-14'` are accepted.

## Where to dig deeper

- `docs/reconcile.md` — reconciling existing docs with the code
- `docs/gaps-format.md` — the `gaps.v1` search-gaps file read by `hewtd reconcile --gaps` (2.21.0)
- `docs/graph-export.md` — the `.hewtd/graph.json` doc-to-code export (2.20.0; written by `hewtd index` and `reconcile --apply`, `graph_export: false` disables; `hewtd index --no-graph` skips it for one run, 2.22.0; each symbol carries `file_kind`)
- `docs/retrieval-fields.md` — the retrieval standard, warning codes, config

- **Reference docs:** `docs/plan-tier-frontmatter.md`, `docs/knowledge-base-primitives.md`
- **Templates:** `templates/knowledge-base/{fact,incident-narrative,incident-facts,playbook-symptoms}.template.md`
- **CHANGELOG.md** for recent additions
- **README.md** for the full feature surface (long; scan, don't read top-to-bottom)
- **CLAUDE.md template** at `templates/claude/CLAUDE.md` — drop into your project root for an `.documentation/` quick-reference embedded in your CLAUDE.md
