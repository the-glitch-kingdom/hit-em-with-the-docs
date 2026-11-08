# Plan-tier frontmatter (HEWTD 2.2.0+)

The `plan` tier was introduced in HEWTD 2.2.0 to support persistent-planning's lg-mode layered planning artifacts (phase / task / atom / notes documents) without forcing semver versioning on what are fundamentally lifecycle-tracked plans.

## What's special about `tier: plan`

Plans behave like every other tier with one exception: **`version` is conditionally optional**.

- `tier !== "plan"` → `version` is **required** (regression-preserving for guides, standards, examples, references, admin docs)
- `tier === "plan"` → `version` is **optional** (may be absent or supplied; either is valid)

Why: plans use `status` for lifecycle (`draft → active → done → archived`), not semver. A "version" on a plan would be redundant noise — the whole point of a plan is that it evolves until it's done, then it's archived.

## Required frontmatter for plan-tier docs

| Field | Required? | Notes |
|---|---|---|
| `title` | ✅ | Same as every tier |
| `tier` | ✅ | Must be `"plan"` |
| `domains` | ✅ | At least one |
| `status` | ✅ | One of `draft \| active \| paused \| done \| archived` (note: `paused` is a plan-friendly addition not present in other tiers' typical workflow) |
| `last_updated` | ✅ | YYYY-MM-DD format |
| `version` | ❌ | Optional. Omit, or supply if it makes sense (e.g. for a v3.0 release plan) |

Plus all the optional HEWTD fields (purpose, related_docs, load_priority, audience, tags, author, maintainer, implementation_status, etc.) work the same way.

## Plan-specific extension fields (NOT validated by HEWTD)

persistent-planning's lg-mode templates also use these fields, which HEWTD ignores (they pass through `additionalProperties` validation):

| Field | Used by | Description |
|---|---|---|
| `plan_kind` | persistent-planning | One of `phase \| task \| atom \| notes` |
| `parent` | persistent-planning | Slug of the parent plan artifact (e.g. an atom's parent task; `null` for phases) |
| `depends_on` | persistent-planning task | Array of task slugs this task depends on |
| `parallelizable` | persistent-planning task | Boolean — `true` if this task has no inter-task deps |
| `sequence` | persistent-planning atom | Integer — order within the parent task's atoms |
| `reopened_at` | persistent-planning atom | ISO 8601 timestamp — set when an atom transitions `done → in_progress` |

These are **persistent-planning concerns**, not HEWTD concerns. HEWTD validates the 22-field standard schema; the extra fields are tolerated.

## Example: phase

```yaml
---
title: Foundation
tier: plan
domains:
  - planning
status: active
last_updated: 2026-05-07
plan_kind: phase
parent: null
---

# Phase: Foundation

## Goal
[...]
```

`version` is intentionally omitted. `hewtd validate` accepts this in 2.2.0+.

## Example: task

```yaml
---
title: HEWTD schema extension
tier: plan
domains:
  - planning
  - schema
status: done
last_updated: 2026-05-07
plan_kind: task
parent: foundation
depends_on: []
parallelizable: true
---

# Task: HEWTD schema extension

[...]
```

## Example: atom

```yaml
---
title: Add plan to TIERS enum
tier: plan
domains:
  - planning
  - schema
status: done
last_updated: 2026-05-07
plan_kind: atom
parent: hewtd-schema-extension
sequence: 1
---

# Atom: Add plan to TIERS enum

## What to do
Edit `src/core/domains/classifier.ts` line 6 — add `'plan'` to the TIERS const array.

## Inputs
- src/core/domains/classifier.ts

## Expected outputs
- TIERS array now contains 6 values: guide, standard, example, reference, admin, plan
- TIER_DEFINITIONS gains a `plan` entry
- scores Record in classify_tier() gains `plan: 0`

## Acceptance criteria
- `npm test tests/unit/domains/classifier.test.ts` passes
- New tests for `plan` tier are added in tests/unit/domains/classifier.test.ts
```

## Example: notes

```yaml
---
title: Foundation — Notes
tier: plan
domains:
  - planning
status: active
last_updated: 2026-05-07
plan_kind: notes
scope: foundation
---

# Notes: Foundation

[...]
```

## Validation behavior

```typescript
import { validate_metadata, get_missing_required_fields } from '@theglitchking/hit-em-with-the-docs';

// Plan tier without version: VALID
validate_metadata({
  title: 'Foundation',
  tier: 'plan',
  domains: ['planning'],
  status: 'active',
  last_updated: '2026-05-07',
});
// → { valid: true, errors: [], data: {...} }

// Plan tier WITH version: also VALID (version is optional, not forbidden)
validate_metadata({
  title: 'Release 3.0',
  tier: 'plan',
  domains: ['planning'],
  status: 'active',
  last_updated: '2026-05-07',
  version: '3.0.0',
});
// → { valid: true, errors: [], data: {...} }

// Guide tier WITHOUT version: still INVALID (regression preservation)
validate_metadata({
  title: 'Setup',
  tier: 'guide',
  domains: ['onboarding'],
  status: 'active',
  last_updated: '2026-05-07',
  // no version
});
// → { valid: false, errors: ['version: ...'] }

// get_missing_required_fields is tier-aware
get_missing_required_fields({
  title: 'Foundation',
  tier: 'plan',
  domains: ['planning'],
  status: 'active',
  last_updated: '2026-05-07',
});
// → []  (does NOT include 'version' for plan tier)

get_missing_required_fields({
  title: 'Setup',
  tier: 'guide',
  domains: ['onboarding'],
  status: 'active',
  last_updated: '2026-05-07',
});
// → ['version']  (still requires version for guide)
```

## Auto-classification

The `plan` tier is included in `classify_tier()`'s scoring, with indicators (`phase`, `task`, `atom`, `milestone`, `deliverable`, `plan`, `roadmap`) and heading patterns (`## Phases`, `## Tasks`, `## Atoms`, `## Decisions Made`, etc.) that match plan-shaped content.

In practice plan-tier docs should always carry explicit `tier: plan` frontmatter (since they're authored by persistent-planning's templates), so auto-classification is a fallback for edge cases.

## Migration

For docs in your existing HEWTD-managed corpora that should become plans (rare — usually plans are new docs in a `.planning/` directory, not retroactively reclassified):

1. Change `tier:` to `plan`
2. Optionally remove `version:` (it's now optional, not forbidden)
3. Re-run `hewtd validate` — should pass

For brand-new plan-tier docs, use persistent-planning's lg-mode templates (`/start-planning`, `/start-task`, `/start-atom`) which produce correct frontmatter automatically.

## See also

- `docs/tier-reference.md` — full tier enum reference (TBD — separate doc, not yet written)
- [persistent-planning lg-mode guide](https://github.com/TheGlitchKing/persistent-planning/blob/main/docs/lg-mode.md) — full layered model documentation
- CHANGELOG entry for 2.2.0 — schema changes
- `~/workspace/the-glitch-kingdom/persistent-planning/.planning/layered-planning-with-mcp-and-hewtd-frontmatter/task_plan.md` — meta-plan
