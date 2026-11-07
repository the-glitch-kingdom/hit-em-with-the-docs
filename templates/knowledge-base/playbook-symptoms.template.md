# Playbook with symptoms — frontmatter snippet

> This is NOT a standalone tier — it's a snippet showing how to enrich an
> EXISTING playbook (any tier: guide, admin, reference, etc.) with a
> `symptoms:` block. The plugin scans configured playbook paths, extracts
> symptoms blocks, and generates `<vault-root>/symptoms/INDEX.md`.

## Where this goes

Drop the `symptoms:` block into the frontmatter of an existing markdown file.
Keep the file's existing `tier:`, `domains:`, `status:`, etc. unchanged. Only
the `symptoms:` field is being added.

## Frontmatter snippet

```yaml
---
title: <existing title, unchanged>
tier: <existing tier — typically guide or admin for runbooks>
domains:
  - <existing domain>
status: active
last_updated: YYYY-MM-DD
version: 1.0.0          # required for non-lifecycle tiers

# ↓↓↓ The new bit ↓↓↓
symptoms:
  # 1. Exact alert name (e.g. from Grafana, Prometheus AlertManager).
  #    Matched character-for-character.
  - alert_name: "<exact alert name as it arrives from the alerting system>"
    severity: critical              # one of: low | medium | high | critical
    target: "#<anchor-in-this-file>"  # the heading the playbook step lives under
    cites:                          # REQUIRED — array of fact ids the playbook depends on
      - <fact-id-1>
      - <fact-id-2>

  # 2. User phrase (free-form support requests). Fuzzy substring match (lowercased).
  - user_phrase:
      - "<phrase 1>"
      - "<phrase 2>"
    severity: medium
    target: "#<same-or-different-anchor>"
    cites:
      - <fact-id-1>

  # 3. Error pattern (log lines, stack traces). Regex match.
  - error_pattern: "<JavaScript-style regex, escaped as needed>"
    severity: high
    target: "#<anchor>"
    cites:
      - <fact-id-3>
---
```

Plain strings also work as entries (`- "users report slow logins"`). They are
retrieval phrases only: no `target`/`cites`, so alert routing and `cite` skip
them. Use the object forms above when an alert must route to this playbook.

## What `cites:` does

`cites:` binds playbook steps to facts. When a fact changes (e.g. its
`confidence:` drops, or it's marked `invalidated_by:` something), the
plugin can flag every playbook that cites it as potentially stale. This is
the load-bearing field for drift detection.

If you cite a fact id that doesn't exist, `hewtd audit --strict` will emit
a `PLAYBOOK_SYMPTOM_DANGLING_CITE` error.

## Tip: use `hewtd cite <fact-id>` to insert

You don't have to write the citation by hand. Inside a playbook file:

```bash
hewtd cite <fact-id> --file <path-to-this-playbook>
```

This inserts a properly-formatted entry into the nearest `symptoms:` block,
creating one if it doesn't exist. (`hewtd cite` ships in 2.3.0 PR3.)
