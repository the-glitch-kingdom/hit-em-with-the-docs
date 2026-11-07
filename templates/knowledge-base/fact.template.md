---
title: <Short human-readable claim — e.g. "Alloy reads env only at entrypoint">
tier: fact
domains:
  - <domain-1>
  # - <domain-2>   # optional additional domains
status: active     # one of: draft | active | deprecated | archived | weakened
last_updated: YYYY-MM-DD
purpose: <One sentence, the question this fact answers, e.g. "Which process reads VAULT_TOKEN, and when?">
symptoms:                       # 2-3 plain strings: how someone describes the problem before knowing the cause, or literal error text
  - <"alloy can't authenticate to vault after restart">
  - <"literal error message from the logs">
id: <kebab-case-slug>           # MUST match the filename without `.md`
confidence: high                # one of: high | medium | low | hypothesis
last_verified: YYYY-MM-DD       # the date a human (or `hewtd audit-facts --run-verify`) confirmed the claim
verify_command: |               # OPTIONAL but strongly recommended — a single shell command that proves the claim
  <one-line command, e.g. `docker exec alloy printenv VAULT_TOKEN | head -c 10`>
# For multi-line scripts, start with a shebang:
# verify_command: |
#   #!/usr/bin/env bash
#   set -euo pipefail
#   <command 1>
#   <command 2>
working_dir: <vault-root>/facts/   # OPTIONAL — CWD for verify_command; defaults to the facts dir if omitted
provenance:                     # REQUIRED — at least one entry; where this fact came from
  - <incidents/YYYY-MM-DD-incident-slug/>   # or a source path, or a postmortem reference
sources:                        # OPTIONAL — code/config paths that embody this fact
  - <repo-relative/path/to/file>
tags:
  - <tag-1>
  - <tag-2>
invalidated_by:                 # OPTIONAL — conditions under which this fact would no longer hold
  - <free-text condition>
---

# <Same as title>

## Claim
<One paragraph stating the atomic claim. One claim per fact. If you find yourself writing "and also...", split it into two facts.>

## How to verify
<How a human can confirm this claim — the prose explanation. The shell command in `verify_command:` is the machine-runnable version.>

## Consequences
<What this means in practice. What workflows it affects. Why a reader should care.>

## See also
<Optional cross-links to related facts, incidents, or runbooks.>
