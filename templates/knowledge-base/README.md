# Knowledge-base templates

LLM-referenceable templates for authoring the four knowledge-base primitives
shipped in 2.3.0. Each template shows the full required + commonly-optional
frontmatter, the validation rules in comments, and a body skeleton with
conventional sections.

| Template | When to use |
|---|---|
| `fact.template.md` | A single citable claim with verify command. Lives at `<vault-root>/facts/<id>.md`. |
| `incident-narrative.template.md` | An immutable postmortem. Lives at `<vault-root>/incidents/<YYYY-MM-DD-slug>/narrative.md`. |
| `incident-facts.template.md` | The bridge linking an incident to the facts it produced. Lives at `<vault-root>/incidents/<YYYY-MM-DD-slug>/facts.md`. |
| `playbook-symptoms.template.md` | A snippet showing how to enrich an EXISTING playbook with a `symptoms:` block. Not a tier on its own. |

## For LLMs

These templates are the canonical reference when creating new knowledge-base
articles. The frontmatter shows every field the validator looks for. Comments
inline (where the YAML allows) explain enums, constraints, and what counts
as required vs. optional.

When asked to create a new fact / incident / playbook entry:

1. Read the corresponding template.
2. Fill in `purpose:` (one sentence: the question the doc answers) and `symptoms:` (plain strings: how the problem is described, or literal error text); they drive retrieval.
3. Replace every `<placeholder>` with concrete content.
4. Run `hewtd audit --strict` on the parent directory to confirm validity.

## Validation reference

See `docs/knowledge-base-primitives.md` (in the plugin repo) for the full
schema reference, the list of error codes, and worked examples.
