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

The KB subtree lives at `.documentation/knowledge-base/` by default (configurable via `.claude/hit-em-with-the-docs.json` → `vault.root`). That same config file also holds the `domains: []` array — custom domains added via `hewtd domain add` (2.6.0+). Each entry has `id`, `name`, `description`, `keywords` (≥1), `loadPriority` (1-10), and `category` (one of `core | development | features | advanced`). You normally don't hand-edit this; use `hewtd domain add/remove`.

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
| `hewtd discover patterns` | Extract coding patterns from source code. |
| `hewtd discover anti-patterns` | Detect anti-patterns in source code. |
| `hewtd report {health\|audit\|links}` | Generate a saved report. |
| `hewtd search <query>` | Cross-doc text search. |
| `hewtd list` | List all built-in domains. |
| `hewtd domain list` | List built-in + custom domains (mark each by kind). |
| `hewtd domain add <id> -k <keywords>` | Add a custom domain (keywords REQUIRED). Validates, writes config, scaffolds the folder. Use `--dry-run` to preview first. |
| `hewtd domain remove <id>` | Remove a custom domain from config. Never deletes docs — reports how many become orphaned. Can't remove a built-in. |
| `hewtd archive <file>` | Retire a doc: move it into `archive/`, stamp lifecycle frontmatter, reindex. Reversible. Link guard refuses if active docs still link to it — `--force` overrides; `--dry-run` previews; `-r/--reason` records why. |
| `hewtd unarchive <file>` | Restore an archived doc to its recorded `archived_from` path; clears the archive stamp. Refuses if the target already exists. |
| `hewtd archive-candidates` | Advisory, read-only. List docs that may warrant archiving (score + reasons). Never moves anything. `--json` for machine output. |

## Slash commands (Claude Code)

| Command | What it does |
|---|---|
| `/hit-em-with-the-docs:help` | Orient yourself or the user on hewtd's surface |
| `/hit-em-with-the-docs:status` | Show installed version, update policy, hook state |
| `/hit-em-with-the-docs:policy [auto\|nudge\|off]` | Get/set the update policy |
| `/hit-em-with-the-docs:domain list\|add\|remove` | Manage custom domains (add confirms via dry-run; remove confirms the orphaned-doc count before applying) |
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

## What NOT to do

- **Don't write to `<vault-root>/{facts,incidents,symptoms}/INDEX.md`** — those are auto-generated. Edits will be overwritten on the next `hewtd maintain`.
- **Don't invent new tiers** — the 9 in this guide are exhaustive. If you think you need a new tier, ask the user.
- **Don't drop docs into an undeclared domain folder.** If a doc genuinely needs a new domain, the supported path is `hewtd domain add <id> -k <keywords>` (which registers it + scaffolds the folder) — not hand-creating a `.documentation/<id>/` folder. Ask the user before adding a domain.
- **Don't skip frontmatter** — every doc in `.documentation/` needs it. The auditor will flag missing fields.
- **Don't move docs between domains without running `hewtd link-check` afterward** — internal links break silently otherwise.
- **Don't manually quote dates in YAML if you don't have to** — as of 2.3.0, both `last_updated: 2026-05-14` and `last_updated: '2026-05-14'` are accepted.

## Where to dig deeper

- **Reference docs:** `docs/plan-tier-frontmatter.md`, `docs/knowledge-base-primitives.md`
- **Templates:** `templates/knowledge-base/{fact,incident-narrative,incident-facts,playbook-symptoms}.template.md`
- **CHANGELOG.md** for recent additions
- **README.md** for the full feature surface (long; scan, don't read top-to-bottom)
- **CLAUDE.md template** at `templates/claude/CLAUDE.md` — drop into your project root for an `.documentation/` quick-reference embedded in your CLAUDE.md
