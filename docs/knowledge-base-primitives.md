# Knowledge-base primitives (HEWTD 2.3.0+)

Three new tiers + one new optional field, introduced in HEWTD 2.3.0 to support
authoring atomic, citable, verifiable units of knowledge alongside the existing
documentation tree:

| Primitive | Tier | Lives at | Purpose |
|---|---|---|---|
| **Fact** | `fact` | `<vault-root>/facts/<id>.md` | A single citable claim with optional verify command |
| **Incident narrative** | `incident-narrative` | `<vault-root>/incidents/<YYYY-MM-DD-slug>/narrative.md` | Immutable postmortem story |
| **Incident facts bridge** | `incident-facts` | `<vault-root>/incidents/<YYYY-MM-DD-slug>/facts.md` | Bridge linking the incident to facts produced/strengthened/weakened |
| **Playbook symptoms** | (no tier — frontmatter field) | wherever playbooks already live | Optional `symptoms:` block mapping alerts/phrases/patterns to playbook anchors with `cites:` to facts |

Default `<vault-root>` is `.documentation/knowledge-base/` (configurable in
`.claude/hit-em-with-the-docs.json` — `vault.root`; ships fully in 2.3.0 PR2).

## What's special about these tiers

All three new tiers are **lifecycle-tracked** (joining `plan` from 2.2.0).
That means:

- `version` is **optional** for these tiers (they use status/last_verified, not semver).
- `status` is **not** restricted to the doc-tier enum (`draft|active|deprecated|archived`).
  Each tier uses its own lifecycle vocabulary.

For non-lifecycle tiers (`guide`, `standard`, `example`, `reference`, `admin`),
nothing changes — the 2.2.0 validation rules continue to apply unmodified.

## Tier: `fact`

A single, atomic, citable unit of knowledge. One claim per fact. If you find
yourself writing "and also...", split it into two facts.

### Required frontmatter

| Field | Required? | Notes |
|---|---|---|
| `title` | ✅ | Same as every tier |
| `tier` | ✅ | Must be `"fact"` |
| `domains` | ✅ | At least one |
| `status` | ✅ | Free-form (recommended: `active`, `weakened`, `archived`) |
| `last_updated` | ✅ | YYYY-MM-DD |
| `id` | ✅ | Kebab-case slug; **must match filename without `.md`** |
| `confidence` | ✅ | One of `high \| medium \| low \| hypothesis` |
| `last_verified` | ✅ | YYYY-MM-DD; the date a human (or `hewtd audit-facts --run-verify`) confirmed the claim |
| `provenance` | ✅ | Array; at least one entry; where this fact came from |
| `version` | ❌ | Optional. Omit. (Facts don't use semver.) |

Plus optional:
- `verify_command` — single command or multi-line script that proves the claim
- `working_dir` — CWD for `verify_command` (defaults to `<vault-root>/facts/`)
- `sources` — code/config paths that embody the fact
- `invalidated_by` — conditions under which the fact would no longer hold

### Example

```yaml
---
title: Alloy reads env only at entrypoint
tier: fact
domains:
  - observability
status: active
last_updated: 2026-05-14
id: alloy-env-set-at-entrypoint-only
confidence: high
last_verified: 2026-05-14
verify_command: |
  docker exec alloy printenv VAULT_TOKEN | head -c 10
provenance:
  - incidents/2026-05-14-vault-alloy-stuck/
tags:
  - alloy
  - env-vars
---

# Alloy reads env only at entrypoint

## Claim
Grafana Alloy reads environment variables at container entrypoint only.

## How to verify
After updating `.env`, run `docker exec alloy printenv VAR` — the value shown
will be the entrypoint-captured value until you restart the container.

## Consequences
Updating Vault tokens via `.env` requires `docker compose restart alloy`.
```

## Tier: `incident-narrative`

An immutable postmortem. Lives in a folder: `<vault-root>/incidents/<YYYY-MM-DD-slug>/`.

### Required frontmatter

| Field | Required? | Notes |
|---|---|---|
| `title` | ✅ | |
| `tier` | ✅ | Must be `"incident-narrative"` |
| `domains` | ✅ | |
| `status` | ✅ | Free-form (recommended: `active`, `resolved`, `archived`) |
| `last_updated` | ✅ | |
| `id` | ✅ | Must match `YYYY-MM-DD-<kebab-slug>` and the parent folder name |
| `date` | ✅ | YYYY-MM-DD |
| `severity` | ✅ | One of `low \| medium \| high \| critical` |
| `resolution_status` | ✅ | One of `resolved \| partial \| open \| planned` |
| `components` | ✅ | Array; at least one entry |
| `version` | ❌ | Optional. Omit. |

## Tier: `incident-facts`

The bridge linking an incident to the facts it produced. Lives alongside the
narrative at `<vault-root>/incidents/<YYYY-MM-DD-slug>/facts.md`.

### Required frontmatter

| Field | Required? | Notes |
|---|---|---|
| `title` | ✅ | |
| `tier` | ✅ | Must be `"incident-facts"` |
| `domains` | ✅ | |
| `status` | ✅ | Free-form |
| `last_updated` | ✅ | |
| `incident_id` | ✅ | Must match the sibling narrative.md's `id` |
| `produced` | ✅ | Array; **may be empty** if the incident produced no new facts |
| `strengthened` | ❌ | Optional array of fact-ids whose confidence rose |
| `weakened` | ❌ | Optional array of fact-ids whose confidence fell |
| `version` | ❌ | Optional. Omit. |

## Playbook symptoms (frontmatter field, any tier)

Playbooks stay where they are in the consumer's docs tree (`troubleshooting/`,
`devops/`, etc.). The optional `symptoms:` field in their frontmatter binds
alerts/phrases/patterns to anchors within the playbook **and** to the facts
the steps depend on.

### Frontmatter shape

```yaml
symptoms:
  - alert_name: "Vault Down — auth-staging"   # exact match
    severity: critical
    target: "#vault-down-auth-staging"
    cites:
      - alloy-env-set-at-entrypoint-only

  - user_phrase: ["metrics missing", "scrape down"]   # fuzzy substring match (lowercased)
    severity: medium
    target: "#vault-down-auth-staging"
    cites:
      - alloy-env-set-at-entrypoint-only

  - error_pattern: "^Vault timeout.*$"   # regex match
    severity: high
    target: "#vault-timeout"
    cites:
      - vault-server-log-omits-metrics-403s
```

### Required per entry

- One of `alert_name` (string) | `user_phrase` (string or array) | `error_pattern` (regex string)
- `target` (string, anchor or path)
- `cites` (non-empty array of fact ids)

Optional: `severity` (`low|medium|high|critical`).

### Plain strings on facts (2.11.0)

On a `fact` doc, an entry may also be a plain string: a literal error text
for the fact itself. It needs no `target` (the fact is the target) and no
`cites` (a fact is what gets cited). semantic-memory indexes each string as
its own search chunk, so a terse error query finds the fact directly.

```yaml
# facts/pkill-f-matches-own-shell.md
tier: fact
symptoms:
  - "pkill -f: Exit code 144"
```

Strings and object entries can be mixed on a fact; object entries keep the
rules above. Any other tier rejects a plain string
(`PLAYBOOK_SYMPTOM_MISSING_KEY`). `cite` and the citer index skip string
entries.

## Validation behavior

### Error codes (introduced in 2.3.0)

`hewtd audit` reports specific error codes for each violation. They surface
as `code` on each `AuditIssue` and as `metadata-<code-lowercase>` in the
`rule` field.

| Code | Severity | Triggered when |
|---|---|---|
| `FACT_MISSING_ID` | error | fact missing `id` or `id` not kebab-case |
| `FACT_MISSING_PROVENANCE` | error | fact missing `provenance` or empty array |
| `FACT_INVALID_CONFIDENCE` | error | `confidence` not in `high\|medium\|low\|hypothesis` |
| `FACT_MISSING_LAST_VERIFIED` | error | `last_verified` missing or not YYYY-MM-DD |
| `FACT_VERIFY_COMMAND_MULTILINE_SHEBANG` | **warning** | multi-line `verify_command` without a `#!` line |
| `INCIDENT_NARRATIVE_MISSING_DATE` | error | `date` missing/malformed, or `id` doesn't match `YYYY-MM-DD-slug` |
| `INCIDENT_NARRATIVE_MISSING_SEVERITY` | error | `severity` missing |
| `INCIDENT_NARRATIVE_INVALID_SEVERITY` | error | `severity` not in enum |
| `INCIDENT_NARRATIVE_MISSING_RESOLUTION_STATUS` | error | missing |
| `INCIDENT_NARRATIVE_INVALID_RESOLUTION_STATUS` | error | not in enum |
| `INCIDENT_NARRATIVE_MISSING_COMPONENTS` | error | empty or missing |
| `INCIDENT_FACTS_MISSING_INCIDENT_ID` | error | missing |
| `INCIDENT_FACTS_MISSING_PRODUCED` | error | `produced` field absent (must be present, may be empty array) |
| `PLAYBOOK_SYMPTOM_MISSING_KEY` | error | symptom entry has none of `alert_name`/`user_phrase`/`error_pattern` |
| `PLAYBOOK_SYMPTOM_MISSING_TARGET` | error | symptom entry missing `target` |
| `PLAYBOOK_SYMPTOM_MISSING_CITES` | error | symptom entry has empty or missing `cites` |

Two codes are reserved for PR2/PR3 (graph-aware checks):
- `INCIDENT_FACTS_DANGLING_REF` — `incident-facts` references a fact id that doesn't exist
- `PLAYBOOK_SYMPTOM_DANGLING_CITE` — a `cites:` references a non-existent fact id
- `FACT_ID_FILENAME_MISMATCH` — fact `id` doesn't match the filename

### `--strict` mode

```bash
hewtd audit --strict
```

Exits non-zero on **any error-severity issue OR any KB-coded issue** (including
warning-severity KB checks like `FACT_VERIFY_COMMAND_MULTILINE_SHEBANG`).
Non-KB stylistic warnings (naming convention, placement) do NOT fail strict
mode — those are advisory and don't represent knowledge-base integrity
violations.

In non-strict mode (existing default), the audit exits non-zero only when a
file has at least one error-severity issue, matching pre-2.3.0 behavior.

### Programmatic API

```typescript
import {
  validateMetadata,
  validateKnowledgeBaseFields,
  getMissingRequiredFields,
} from '@theglitchking/hit-em-with-the-docs';

// Full validation (zod schema with all refinements):
validateMetadata({
  title: 'Alloy reads env only at entrypoint',
  tier: 'fact',
  domains: ['observability'],
  status: 'active',
  last_updated: '2026-05-14',
  id: 'alloy-env-set-at-entrypoint-only',
  confidence: 'high',
  last_verified: '2026-05-14',
  provenance: ['incidents/2026-05-14-vault-alloy-stuck/'],
});
// → { valid: true, errors: [], data: {...} }

// KB-only coded errors (the audit layer's entrypoint):
validateKnowledgeBaseFields({
  tier: 'fact',
  /* missing provenance */
});
// → [{ code: 'FACT_MISSING_PROVENANCE', message: '...', path: 'provenance' }, ...]

// Tier-aware missing-required check:
getMissingRequiredFields({
  title: 'My Fact',
  tier: 'fact',
  domains: ['observability'],
  status: 'active',
  last_updated: '2026-05-14',
});
// → ['id', 'confidence', 'last_verified', 'provenance']
// (does NOT include 'version' — facts are lifecycle-tracked)
```

## Templates

Four templates ship in `templates/knowledge-base/` and are bundled with the
npm package. An LLM (or a human) creating a new KB article can reference them
directly:

- `templates/knowledge-base/fact.template.md`
- `templates/knowledge-base/incident-narrative.template.md`
- `templates/knowledge-base/incident-facts.template.md`
- `templates/knowledge-base/playbook-symptoms.template.md` (frontmatter snippet)

Each template shows all required + commonly-optional fields with inline
comments explaining enums and constraints.

## Backward compatibility

The 2.3.0 surface is **purely additive**:

- Consumers with no `knowledge-base/` subtree and no `symptoms:` blocks
  observe **zero behavior change** from 2.2.0.
- Existing tiers (`guide`, `standard`, `example`, `reference`, `admin`, `plan`)
  validate exactly as they did before.
- `REQUIRED_FIELDS` and `ALL_METADATA_FIELDS` are unchanged. The 2.3.0
  extensions live in `TIER_REQUIRED_EXTENSIONS` and are exposed only via
  the tier-aware helpers.
- The audit's tier suggestion now dynamically lists all current tiers from
  `TIERS` (it had been hardcoded to the original 5; the 2.2.0 plan tier
  was missing).

## See also

- `templates/knowledge-base/` — author templates (one per primitive)
- `docs/plan-tier-frontmatter.md` — the 2.2.0 plan-tier reference (parallel pattern)
- `src/core/metadata/errors.ts` — the canonical error-code module
- 2.3.0 phase plan in `.planning/knowledge-base-primitives-230/` (workspace-local)
