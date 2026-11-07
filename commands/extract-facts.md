---
description: Propose 5-10 atomic facts from an incident narrative; user accepts/edits/rejects; commit accepted facts
allowed-tools: Bash(npx:*), Read
argument-hint: "<path-to-incident-folder>"
---

Arguments: $ARGUMENTS

This is the **LLM-driven proposer** for the `hewtd extract-facts` workflow. Your job in this turn is to:

1. **Read the incident narrative.** Open `<incident-folder>/narrative.md`. Skim the Timeline, Root Cause, Resolution, and Lessons Learned sections.
2. **Propose 5-10 candidate facts.** Each candidate is a single atomic citable claim. Look for things like:
   - "X reads/writes/depends-on Y under condition Z"
   - "X fails when Y, but appears successful at the surface level"
   - "X requires Y in order to Z"
   - Specific timing windows, retry behaviors, exact log signatures, configuration gotchas
   - Things that were SURPRISING during the incident (those make the best facts)
3. **For each candidate, produce a FactSpec:**

   ```json
   {
     "id": "<kebab-case-slug>",
     "title": "<short human-readable claim>",
     "confidence": "high | medium | low | hypothesis",
     "claim": "<one-paragraph stating the atomic claim>",
     "howToVerify": "<one paragraph on how to confirm it>",
     "consequences": "<one paragraph on what this means in practice>",
     "purpose": "<one sentence: the question this fact answers>",
     "symptoms": ["<how someone would describe the problem before knowing the cause>", "<or literal error text>"],
     "verifyCommand": "<optional one-line shell command that proves the claim>",
     "tags": ["<tag-1>", "<tag-2>"],
     "domains": ["<domain>"]
   }
   ```

4. **Present the candidates to the user.** For each one, include:
   - The proposed id, title, confidence
   - A quote from the narrative justifying the fact
   - The proposed `purpose` and 2-3 plain-string `symptoms` (phrases a person would search with, or exact error text; no invented ones)
   - The proposed verify_command (with caveat: it's LLM-derived, may need refinement)

5. **Let the user accept / edit / reject each.** Don't proceed to step 6 until the user has signed off on the final list.

6. **Commit accepted facts.** Construct a JSON array of the accepted FactSpec objects. Then run:

   ```bash
   npx --no @theglitchking/hit-em-with-the-docs extract-facts "<incident-folder>" --accept '<JSON-array>'
   ```

   The CLI is the **deterministic writer** — it writes the fact files with provenance auto-populated, and updates the incident's `facts.md` `produced:` list (idempotent).

7. **Suggest next steps.** After commit, suggest:
   - Run `npx --no @theglitchking/hit-em-with-the-docs audit --strict` to confirm the new facts validate cleanly
   - Enrich relevant playbooks with `cites:` for the new facts via `/hit-em-with-the-docs:cite`

## Quality bar for fact proposals

Reject your own first instinct if any of these are true:
- The proposed fact has "and" / "also" in the title — split into two facts
- The proposed fact restates something obvious (e.g. "Vault is a secrets manager")
- The proposed fact has no actionable consequences for future on-calls
- The proposed verify_command would require an SSH'd shell on a remote host the LLM can't reach — flag it for the user as "verify manually" rather than including in `verify_command`

## What NOT to do

- **Do not commit facts without user sign-off.** Even if a fact looks obvious, the user accepts each one.
- **Do not fabricate provenance or sources.** The CLI auto-populates `provenance` with the incident folder path; you don't need to set it.
- **Do not propose more than 10 facts in one pass.** If the incident is rich, propose the top 10 and offer a second pass.
- **Do not start writing `<vault>/facts/*.md` directly.** Always go through the `hewtd extract-facts --accept` CLI.
