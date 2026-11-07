/**
 * Error codes for knowledge-base primitive validation (introduced in 2.3.0).
 *
 * The schema's .refine() rules prefix their messages with one of these codes
 * in square brackets, e.g. `[FACT_MISSING_ID] id is required when tier is "fact"`.
 * The audit layer parses the code out of the message to populate AuditIssue.code,
 * which lets CI and tooling switch on specific violation types without
 * substring-matching prose.
 *
 * Codes are namespaced by primitive:
 *   FACT_*       — facts
 *   INCIDENT_*   — incident folders (narrative + facts.md)
 *   PLAYBOOK_*   — playbook symptoms blocks (the symptoms: frontmatter field)
 */

export const KB_ERROR_CODES = {
  // Facts
  FACT_MISSING_ID: 'FACT_MISSING_ID',
  FACT_ID_FILENAME_MISMATCH: 'FACT_ID_FILENAME_MISMATCH',
  FACT_MISSING_PROVENANCE: 'FACT_MISSING_PROVENANCE',
  FACT_INVALID_CONFIDENCE: 'FACT_INVALID_CONFIDENCE',
  FACT_MISSING_LAST_VERIFIED: 'FACT_MISSING_LAST_VERIFIED',
  FACT_VERIFY_COMMAND_MULTILINE_SHEBANG: 'FACT_VERIFY_COMMAND_MULTILINE_SHEBANG',

  // Incidents
  INCIDENT_FOLDER_MISSING_NARRATIVE: 'INCIDENT_FOLDER_MISSING_NARRATIVE',
  INCIDENT_FOLDER_MISSING_FACTS: 'INCIDENT_FOLDER_MISSING_FACTS',
  INCIDENT_NARRATIVE_MISSING_DATE: 'INCIDENT_NARRATIVE_MISSING_DATE',
  INCIDENT_NARRATIVE_MISSING_SEVERITY: 'INCIDENT_NARRATIVE_MISSING_SEVERITY',
  INCIDENT_NARRATIVE_INVALID_SEVERITY: 'INCIDENT_NARRATIVE_INVALID_SEVERITY',
  INCIDENT_NARRATIVE_MISSING_RESOLUTION_STATUS:
    'INCIDENT_NARRATIVE_MISSING_RESOLUTION_STATUS',
  INCIDENT_NARRATIVE_INVALID_RESOLUTION_STATUS:
    'INCIDENT_NARRATIVE_INVALID_RESOLUTION_STATUS',
  INCIDENT_NARRATIVE_MISSING_COMPONENTS: 'INCIDENT_NARRATIVE_MISSING_COMPONENTS',
  INCIDENT_FACTS_MISSING_INCIDENT_ID: 'INCIDENT_FACTS_MISSING_INCIDENT_ID',
  INCIDENT_FACTS_MISSING_PRODUCED: 'INCIDENT_FACTS_MISSING_PRODUCED',
  INCIDENT_FACTS_DANGLING_REF: 'INCIDENT_FACTS_DANGLING_REF',

  // Playbook symptoms blocks
  PLAYBOOK_SYMPTOM_MISSING_KEY: 'PLAYBOOK_SYMPTOM_MISSING_KEY',
  PLAYBOOK_SYMPTOM_MISSING_TARGET: 'PLAYBOOK_SYMPTOM_MISSING_TARGET',
  PLAYBOOK_SYMPTOM_MISSING_CITES: 'PLAYBOOK_SYMPTOM_MISSING_CITES',
  PLAYBOOK_SYMPTOM_DANGLING_CITE: 'PLAYBOOK_SYMPTOM_DANGLING_CITE',

  // Retrieval readiness (#50). Advisory: always warnings.
  RETRIEVAL_MISSING_PURPOSE: 'RETRIEVAL_MISSING_PURPOSE',
  RETRIEVAL_WEAK_PURPOSE: 'RETRIEVAL_WEAK_PURPOSE',
  RETRIEVAL_GENERIC_TITLE: 'RETRIEVAL_GENERIC_TITLE',
  RETRIEVAL_MISSING_SYMPTOMS: 'RETRIEVAL_MISSING_SYMPTOMS',
  RETRIEVAL_OVERSIZED: 'RETRIEVAL_OVERSIZED',
  RETRIEVAL_NEAR_DUPLICATE: 'RETRIEVAL_NEAR_DUPLICATE',

  // Overview docs (#51). Advisory: always warnings.
  OVERVIEW_MISSING: 'OVERVIEW_MISSING',
  OVERVIEW_STALE_LINKS: 'OVERVIEW_STALE_LINKS',
} as const;

export type KbErrorCode = (typeof KB_ERROR_CODES)[keyof typeof KB_ERROR_CODES];

/**
 * Severity for each KB error code.
 *
 * Most violations are `error`. The shebang check on verify_command is `warning`
 * because the spec calls it out as "warning only — multi-line is fine, shebang
 * missing is OK". Dangling refs (facts referencing non-existent fact-ids, or
 * playbook citations to non-existent fact-ids) are `error`.
 */
export const KB_ERROR_SEVERITY: Record<KbErrorCode, 'error' | 'warning'> = {
  FACT_MISSING_ID: 'error',
  FACT_ID_FILENAME_MISMATCH: 'error',
  FACT_MISSING_PROVENANCE: 'error',
  FACT_INVALID_CONFIDENCE: 'error',
  FACT_MISSING_LAST_VERIFIED: 'error',
  FACT_VERIFY_COMMAND_MULTILINE_SHEBANG: 'warning',
  INCIDENT_FOLDER_MISSING_NARRATIVE: 'error',
  INCIDENT_FOLDER_MISSING_FACTS: 'error',
  INCIDENT_NARRATIVE_MISSING_DATE: 'error',
  INCIDENT_NARRATIVE_MISSING_SEVERITY: 'error',
  INCIDENT_NARRATIVE_INVALID_SEVERITY: 'error',
  INCIDENT_NARRATIVE_MISSING_RESOLUTION_STATUS: 'error',
  INCIDENT_NARRATIVE_INVALID_RESOLUTION_STATUS: 'error',
  INCIDENT_NARRATIVE_MISSING_COMPONENTS: 'error',
  INCIDENT_FACTS_MISSING_INCIDENT_ID: 'error',
  INCIDENT_FACTS_MISSING_PRODUCED: 'error',
  INCIDENT_FACTS_DANGLING_REF: 'error',
  PLAYBOOK_SYMPTOM_MISSING_KEY: 'error',
  PLAYBOOK_SYMPTOM_MISSING_TARGET: 'error',
  PLAYBOOK_SYMPTOM_MISSING_CITES: 'error',
  PLAYBOOK_SYMPTOM_DANGLING_CITE: 'error',
  RETRIEVAL_MISSING_PURPOSE: 'warning',
  RETRIEVAL_WEAK_PURPOSE: 'warning',
  RETRIEVAL_GENERIC_TITLE: 'warning',
  RETRIEVAL_MISSING_SYMPTOMS: 'warning',
  RETRIEVAL_OVERSIZED: 'warning',
  RETRIEVAL_NEAR_DUPLICATE: 'warning',
  OVERVIEW_MISSING: 'warning',
  OVERVIEW_STALE_LINKS: 'warning',
};

/**
 * Format a code-prefixed error message. The audit layer parses the leading
 * `[CODE]` to populate `AuditIssue.code` without losing the human-readable
 * description.
 */
export function formatKbError(code: KbErrorCode, message: string): string {
  return `[${code}] ${message}`;
}

const KB_ERROR_PREFIX_RE = /^\[([A-Z_]+)\]\s+(.*)$/;

/**
 * Extract a KB error code from a refine() message, if present. Returns null
 * for messages that don't begin with `[CODE] `.
 */
export function parseKbErrorCode(
  message: string
): { code: KbErrorCode; message: string } | null {
  const match = message.match(KB_ERROR_PREFIX_RE);
  if (!match) return null;

  const code = match[1] as string;
  const remainder = match[2] ?? '';

  if (!(code in KB_ERROR_SEVERITY)) return null;
  return { code: code as KbErrorCode, message: remainder };
}
