---
description: Update hit-em-with-the-docs to the latest version (runs npm update)
allowed-tools: Bash(npx:*)
---

Run `npx --no @theglitchking/hit-em-with-the-docs update` and report the before/after versions to the user. If the project doesn't have a local install, fall back to `npx -y @theglitchking/hit-em-with-the-docs update` and note that in your summary.

Then run `npx --no @theglitchking/hit-em-with-the-docs upgrade-check` (see `/hit-em-with-the-docs:upgrade-check`) and relay its checklist, so the repo-side steps this release needs are not skipped. Offer `--fix` for the safe items.
