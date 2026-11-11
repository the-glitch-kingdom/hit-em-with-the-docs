---
description: Show installed version, latest available version, current update policy, and hook registration state
allowed-tools: Bash(npx:*)
---

Run `npx --no @theglitchking/hit-em-with-the-docs status` and relay the output to the user verbatim. When the installed version differs from the latest, or from the version the repo last checked (`last_upgrade_check`), suggest `/hit-em-with-the-docs:upgrade-check`.
