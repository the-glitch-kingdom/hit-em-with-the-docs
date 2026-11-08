import { z } from 'zod';
import {
  TIERS,
  LIFECYCLE_TRACKED_TIERS,
  is_lifecycle_tracked_tier,
  type Tier,
} from '../domains/classifier.js';
import { KB_ERROR_CODES, format_knowledge_base_error, type KbErrorCode } from './errors.js';
import {
  DOC_STATUS_VALUES,
  get_status_values,
  is_valid_status,
} from './status-registry.js';

/**
 * Metadata schema for documentation files (the YAML frontmatter contract).
 *
 * Universal fields: 22 across six groups (core / status / discovery / ownership
 * / implementation / auto). Plus tier-specific extensions for the lifecycle-
 * tracked tiers introduced in 2.2.0 (plan) and 2.3.0 (fact, incident-narrative,
 * incident-facts), and an optional `symptoms:` field for playbook documents.
 *
 * Conditional rules (enforced by .refine() on the merged MetadataSchema):
 *
 *   1. `version` is optional in the base schema; required for tiers that
 *      AREN'T in LIFECYCLE_TRACKED_TIERS. Lifecycle-tracked tiers (plan, fact,
 *      incident-narrative, incident-facts) use status/last_verified, not semver.
 *   2. `status` accepts any string in the base schema; conditionally restricted
 *      to the doc-tier enum (draft|active|deprecated|archived) for tiers that
 *      aren't lifecycle-tracked. Each lifecycle-tracked tier uses its own
 *      status enum.
 *   3. Each lifecycle-tracked tier has its own required-fields contract
 *      (e.g. fact requires id+confidence+last_verified+provenance).
 *   4. The optional `symptoms:` field, when present on any tier, must be an
 *      array of valid symptom entries. On any tier an entry may also be a
 *      plain string: a retrieval phrase, no target or cites (#46, #50 — the
 *      shape semantic-memory indexes). Object entries still need key+target+cites.
 */

// ----- Core schema groups (existing 22-field surface) -----

const core_identity_schema = z.object({
  title: z.string().min(1, 'Title is required'),
  tier: z.enum(TIERS as unknown as [Tier, ...Tier[]]),
  domains: z.array(z.string()).min(1, 'At least one domain is required'),
  audience: z.array(z.enum(['all', 'developers', 'devops', 'admin'])).default(['all']),
  tags: z.array(z.string()).default([]),
});



/**
 * Date-shaped value preprocessor: js-yaml auto-converts unquoted `2026-05-14`
 * style fields into Date objects. Real users writing markdown rarely quote
 * their dates, so we accept both `Date` and string-formatted YYYY-MM-DD,
 * normalizing to the latter. Added in 2.3.0 alongside the knowledge-base
 * primitives; applied universally so existing tiers (with unquoted
 * `last_updated:` fields) also benefit.
 */
const date_string_schema = z.preprocess(
  (value) => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString().slice(0, 10);
    }
    // A full ISO timestamp carries the date this field is for, so rejecting it
    // outright helped nobody: `2026-04-18T00:00:00.000Z` was neither accepted
    // nor truncated, and no `--fix` could resolve it (#28). Until the engine
    // fix in `utils/frontmatter.ts` these survived only by accident — written
    // unquoted, re-read as a `Date`, and rescued by the branch above.
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      return value.slice(0, 10);
    }
    return value;
  },
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format')
);

const status_schema = z.object({
  status: z.string().min(1, 'status is required'),
  last_updated: date_string_schema,
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Must be semver format (X.Y.Z)').optional(),
});

export const DOC_KIND_VALUES = ['overview'] as const;

const discovery_schema = z.object({
  kind: z
    .enum(DOC_KIND_VALUES, {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- zod option name
      errorMap: (issue, context) => ({
        message:
          issue.code === 'invalid_enum_value'
            ? `Invalid kind "${String(context.data)}". Allowed values: ${DOC_KIND_VALUES.join(', ')}`
            : context.defaultError,
      }),
    })
    .optional(),
  purpose: z.string().optional(),
  related_docs: z.array(z.string()).optional(),
  load_priority: z.number().min(1).max(10).optional(),
});

const ownership_schema = z.object({
  author: z.string().optional(),
  maintainer: z.string().optional(),
  review_frequency: z.enum(['weekly', 'monthly', 'quarterly', 'annually']).optional(),
});

const implementation_schema = z.object({
  implementation_status: z.enum(['planned', 'in_progress', 'complete', 'deprecated']).optional(),
  tested: z.boolean().optional(),
  production_ready: z.boolean().optional(),
});

const auto_generated_schema = z.object({
  estimated_read_time: z.string().optional(),
  word_count: z.number().optional(),
  last_validated: date_string_schema.optional(),
  backlinks: z.array(z.string()).optional(),
});

// ----- Knowledge-base extension fields (2.3.0) -----
//
// Every field below is optional at the type level — the conditional
// .refine() rules on the merged MetadataSchema enforce per-tier requirements.

const FACT_CONFIDENCE_VALUES = ['high', 'medium', 'low', 'hypothesis'] as const;
const INCIDENT_SEVERITY_VALUES = ['low', 'medium', 'high', 'critical'] as const;
const INCIDENT_RESOLUTION_VALUES = ['resolved', 'partial', 'open', 'planned'] as const;

const KEBAB_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INCIDENT_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

const knowledge_base_schema = z.object({
  // Fact fields
  id: z.string().min(1).optional(),
  confidence: z.string().optional(),
  last_verified: date_string_schema.optional(),
  verify_command: z.string().optional(),
  provenance: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  invalidated_by: z.array(z.string()).optional(),
  working_dir: z.string().optional(),
  // Original location of a file integrated from outside the docs tree (reconcile outside lane)
  moved_from: z.string().optional(),

  // Incident-narrative fields
  date: date_string_schema.optional(),
  severity: z.string().optional(),
  resolution_status: z.string().optional(),
  components: z.array(z.string()).optional(),

  // Incident-facts fields
  incident_id: z.string().optional(),
  produced: z.array(z.string()).optional(),
  strengthened: z.array(z.string()).optional(),
  weakened: z.array(z.string()).optional(),

  // Playbook symptoms (any tier may carry this; plain strings allowed on every tier)
  symptoms: z
    .array(
      z.union([
        z.string().min(1),
        z.object({
        alert_name: z.string().optional(),
        user_phrase: z.union([z.string(), z.array(z.string())]).optional(),
        error_pattern: z.string().optional(),
        severity: z.enum(INCIDENT_SEVERITY_VALUES).optional(),
        target: z.string().min(1).optional(),
        cites: z.array(z.string()).optional(),
        }),
      ])
    )
    .optional(),
});

// ----- Archival / deprecation lifecycle fields -----
//
// Stamped by `hewtd archive` (and `superseded_by` may be set by hand on a
// still-active doc to point at its replacement). All optional; archived docs
// live under `archive/` and are scan-excluded, but `superseded_by` and
// `status: deprecated` can appear on active docs, so these must validate.
const lifecycle_schema = z.object({
  superseded_by: z.string().optional(),
  archived_on: date_string_schema.optional(),
  archived_from: z.string().optional(),
  archived_reason: z.string().optional(),
});

// ----- Merged base (no refinements yet) -----

const _base_merged_schema = core_identity_schema
  .merge(status_schema)
  .merge(discovery_schema)
  .merge(ownership_schema)
  .merge(implementation_schema)
  .merge(auto_generated_schema)
  .merge(knowledge_base_schema)
  .merge(lifecycle_schema);

// ----- Conditional refinements -----

/**
 * `version` is required for any tier NOT in LIFECYCLE_TRACKED_TIERS.
 */
const refine_version_required = (data: z.infer<typeof _base_merged_schema>) =>
  is_lifecycle_tracked_tier(data.tier) || data.version !== undefined;

/**
 * `status` must be in the ACTIVE vocabulary (built-ins + any project-declared
 * extras) for non-lifecycle-tracked tiers.
 * Lifecycle-tracked tiers use their own status enums (free-form at this layer).
 */
const refine_status_enum = (data: z.infer<typeof _base_merged_schema>) =>
  is_lifecycle_tracked_tier(data.tier) || is_valid_status(data.status);

/**
 * Fact-tier required fields: id, confidence (enum), last_verified, provenance (≥1).
 */
const refine_fact_requirements = (data: z.infer<typeof _base_merged_schema>) => {
  if (data.tier !== 'fact') return true;
  const checks = [
    typeof data.id === 'string' && data.id.length > 0,
    typeof data.confidence === 'string' &&
      (FACT_CONFIDENCE_VALUES as readonly string[]).includes(data.confidence),
    typeof data.last_verified === 'string',
    Array.isArray(data.provenance) && data.provenance.length > 0,
  ];
  return checks.every(Boolean);
};

/**
 * Incident-narrative required fields: id, date, severity (enum),
 * resolution_status (enum), components (array).
 */
const refine_incident_narrative_requirements = (
  data: z.infer<typeof _base_merged_schema>
) => {
  if (data.tier !== 'incident-narrative') return true;
  const checks = [
    typeof data.id === 'string' && data.id.length > 0,
    typeof data.date === 'string',
    typeof data.severity === 'string' &&
      (INCIDENT_SEVERITY_VALUES as readonly string[]).includes(data.severity),
    typeof data.resolution_status === 'string' &&
      (INCIDENT_RESOLUTION_VALUES as readonly string[]).includes(
        data.resolution_status
      ),
    Array.isArray(data.components),
  ];
  return checks.every(Boolean);
};

/**
 * Incident-facts required fields: incident_id, produced (array, may be empty).
 */
const refine_incident_facts_requirements = (
  data: z.infer<typeof _base_merged_schema>
) => {
  if (data.tier !== 'incident-facts') return true;
  const checks = [
    typeof data.incident_id === 'string' && data.incident_id.length > 0,
    Array.isArray(data.produced),
  ];
  return checks.every(Boolean);
};

/**
 * Symptoms entries (any tier): each must have one of alert_name/user_phrase/
 * error_pattern AND target AND non-empty cites array. Fact docs may also
 * list plain strings on any tier (#46, #50).
 */
const refine_symptoms_entries = (data: z.infer<typeof _base_merged_schema>) => {
  if (!Array.isArray(data.symptoms)) return true;
  for (const symptom of data.symptoms) {
    if (typeof symptom === 'string') continue;
    const has_key =
      symptom.alert_name !== undefined ||
      symptom.user_phrase !== undefined ||
      symptom.error_pattern !== undefined;
    if (!has_key) return false;
    if (typeof symptom.target !== 'string' || symptom.target.length === 0) return false;
    if (!Array.isArray(symptom.cites) || symptom.cites.length === 0) return false;
  }
  return true;
};

// ----- Exported schema -----

/**
 * Complete metadata schema with all conditional refinements applied.
 *
 * Required fields by tier:
 *   - Non-lifecycle-tracked (guide/standard/example/reference/admin):
 *       title, tier, domains, status (enum), last_updated, version
 *   - plan: title, tier, domains, status, last_updated (no version)
 *   - fact: title, tier, domains, status, last_updated, id, confidence,
 *       last_verified, provenance (no version)
 *   - incident-narrative: title, tier, domains, status, last_updated,
 *       id, date, severity, resolution_status, components (no version)
 *   - incident-facts: title, tier, domains, status, last_updated,
 *       incident_id, produced (no version)
 */
export const metadata_schema = _base_merged_schema
  .refine(refine_version_required, {
    message: 'version is required unless tier is plan, fact, incident-narrative, or incident-facts',
    path: ['version'],
  })
  .refine(refine_status_enum, () => ({
    message:
      `status must be one of ${get_status_values().join('|')} for non-lifecycle-tracked ` +
      `tiers (declare extra values in .claude/hit-em-with-the-docs.json "status")`,
    path: ['status'],
  }))
  .refine(refine_fact_requirements, {
    message: format_knowledge_base_error(
      KB_ERROR_CODES.FACT_MISSING_ID,
      'fact tier requires id (kebab-case), confidence (high|medium|low|hypothesis), last_verified (YYYY-MM-DD), and provenance (≥1 entry)'
    ),
    path: ['fact'],
  })
  .refine(refine_incident_narrative_requirements, {
    message: format_knowledge_base_error(
      KB_ERROR_CODES.INCIDENT_NARRATIVE_MISSING_DATE,
      'incident-narrative tier requires id, date (YYYY-MM-DD), severity (low|medium|high|critical), resolution_status (resolved|partial|open|planned), and components (array)'
    ),
    path: ['incident-narrative'],
  })
  .refine(refine_incident_facts_requirements, {
    message: format_knowledge_base_error(
      KB_ERROR_CODES.INCIDENT_FACTS_MISSING_INCIDENT_ID,
      'incident-facts tier requires incident_id and produced (array, may be empty)'
    ),
    path: ['incident-facts'],
  })
  .refine(refine_symptoms_entries, {
    message: format_knowledge_base_error(
      KB_ERROR_CODES.PLAYBOOK_SYMPTOM_MISSING_KEY,
      'each symptoms[] entry requires one of alert_name|user_phrase|error_pattern AND a target AND a non-empty cites[] array (or be a plain string, on any tier)'
    ),
    path: ['symptoms'],
  });

export type DocumentMetadata = z.infer<typeof metadata_schema>;

/**
 * Partial schema for documents that may have incomplete metadata.
 * Built from the un-refined base so every field is optional regardless of
 * tier — used by `hewtd fix` to identify incomplete docs.
 */
export const partial_metadata_schema = _base_merged_schema.partial();
export type PartialDocumentMetadata = z.infer<typeof partial_metadata_schema>;

/**
 * Required fields shared across all tiers.
 *
 * Note: `version` is conditionally required — it must be present for all
 * tiers NOT in LIFECYCLE_TRACKED_TIERS. The list below preserves the
 * historical 6-required-field contract for non-lifecycle docs; for lifecycle-
 * tracked docs (plan/fact/incident-narrative/incident-facts), `version` is
 * dropped and the per-tier extension fields are added by
 * `getRequiredFieldsForTier()`.
 *
 * Prefer `getMissingRequiredFields(data)` for tier-aware checks rather than
 * iterating REQUIRED_FIELDS directly.
 */
export const REQUIRED_FIELDS = [
  'title',
  'tier',
  'domains',
  'status',
  'last_updated',
  'version',
] as const;

/**
 * Tier-specific required-field extensions for lifecycle-tracked tiers.
 *
 * For each tier, these fields are required IN ADDITION to the universal
 * five (title, tier, domains, status, last_updated). `version` is excluded.
 */
const TIER_REQUIRED_EXTENSIONS: Partial<Record<Tier, readonly string[]>> = {
  fact: ['id', 'confidence', 'last_verified', 'provenance'],
  'incident-narrative': [
    'id',
    'date',
    'severity',
    'resolution_status',
    'components',
  ],
  'incident-facts': ['incident_id', 'produced'],
};

export const OPTIONAL_FIELDS_DEFAULTS: Partial<DocumentMetadata> = {
  audience: ['all'],
  tags: [],
  backlinks: [],
};

export const AUTO_GENERATED_FIELDS = [
  'estimated_read_time',
  'word_count',
  'last_validated',
  'backlinks',
] as const;

/**
 * All 22 universal field names (unchanged from 2.2.0). The 2.3.0 knowledge-
 * base extension fields (id, confidence, etc.) are intentionally NOT in this
 * list — they apply per-tier and would skew completeness calc on non-KB docs.
 */
export const ALL_METADATA_FIELDS = [
  // Core Identity (5)
  'title',
  'tier',
  'domains',
  'audience',
  'tags',
  // Status & Lifecycle (3)
  'status',
  'last_updated',
  'version',
  // Discovery & Navigation (3)
  'purpose',
  'related_docs',
  'load_priority',
  // Ownership & Maintenance (3)
  'author',
  'maintainer',
  'review_frequency',
  // Implementation (3)
  'implementation_status',
  'tested',
  'production_ready',
  // Auto-generated (4)
  'estimated_read_time',
  'word_count',
  'last_validated',
  'backlinks',
] as const;

export type MetadataField = (typeof ALL_METADATA_FIELDS)[number];

export function validate_metadata(data: unknown): {
  valid: boolean;
  errors: string[];
  data?: DocumentMetadata;
} {
  const result = metadata_schema.safeParse(data);

  if (result.success) {
    return { valid: true, errors: [], data: result.data };
  }

  const errors = result.error.errors.map(
    (error) => `${error.path.join('.')}: ${error.message}`
  );

  return { valid: false, errors };
}

/**
 * Coded error produced by `validateKnowledgeBaseFields()`. The auditor maps
 * these to `AuditIssue` entries with `code` populated, so CI tooling can
 * switch on specific violation kinds without substring-matching prose.
 */
export interface KbValidationError {
  code: KbErrorCode;
  message: string;
  path: string;
}

/**
 * Run all KB-specific validation predicates against a partial metadata object
 * and return a typed error list. This is the entrypoint the audit layer uses
 * for the knowledge-base primitives (fact / incident-narrative / incident-facts
 * / symptoms).
 *
 * Unlike `validateMetadata()`, this does NOT require the base schema to pass
 * first — it can run on partial / in-progress docs and surface ONLY the KB
 * coded errors, which lets the auditor combine KB checks with its existing
 * missing-required-fields reporting without duplicate output.
 */
/**
 * YAML dates (e.g. `date: 2026-05-14` unquoted) are auto-parsed by js-yaml
 * into Date objects. We accept both `string` (YYYY-MM-DD) and `Date` as
 * valid date-shaped values, so users don't have to quote dates manually.
 */
function is_date_like(value: unknown): boolean {
  if (typeof value === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return true;
  return false;
}

export function validate_knowledge_base_fields(
  data: Record<string, unknown>
): KbValidationError[] {
  const errors: KbValidationError[] = [];
  const tier = typeof data.tier === 'string' ? data.tier : undefined;

  // ----- Fact tier -----
  if (tier === 'fact') {
    if (typeof data.id !== 'string' || data.id.length === 0) {
      errors.push({
        code: KB_ERROR_CODES.FACT_MISSING_ID,
        message: 'fact tier requires an id (kebab-case slug)',
        path: 'id',
      });
    } else if (!KEBAB_SLUG_RE.test(data.id)) {
      errors.push({
        code: KB_ERROR_CODES.FACT_MISSING_ID,
        message: `fact id must be kebab-case (got: ${data.id})`,
        path: 'id',
      });
    }
    if (typeof data.confidence !== 'string') {
      errors.push({
        code: KB_ERROR_CODES.FACT_INVALID_CONFIDENCE,
        message: `fact tier requires confidence (one of ${FACT_CONFIDENCE_VALUES.join('|')})`,
        path: 'confidence',
      });
    } else if (!(FACT_CONFIDENCE_VALUES as readonly string[]).includes(data.confidence)) {
      errors.push({
        code: KB_ERROR_CODES.FACT_INVALID_CONFIDENCE,
        message: `confidence must be one of ${FACT_CONFIDENCE_VALUES.join('|')} (got: ${data.confidence})`,
        path: 'confidence',
      });
    }
    if (data.last_verified === undefined || data.last_verified === null) {
      errors.push({
        code: KB_ERROR_CODES.FACT_MISSING_LAST_VERIFIED,
        message: 'fact tier requires last_verified (YYYY-MM-DD)',
        path: 'last_verified',
      });
    } else if (!is_date_like(data.last_verified)) {
      errors.push({
        code: KB_ERROR_CODES.FACT_MISSING_LAST_VERIFIED,
        message: `last_verified must be YYYY-MM-DD (got: ${String(data.last_verified)})`,
        path: 'last_verified',
      });
    }
    if (!Array.isArray(data.provenance) || data.provenance.length === 0) {
      errors.push({
        code: KB_ERROR_CODES.FACT_MISSING_PROVENANCE,
        message: 'fact tier requires at least one provenance entry',
        path: 'provenance',
      });
    }
    // Warning: verify_command with TRULY multi-line content (multiple commands)
    // but missing shebang. YAML's `|` block scalar leaves a trailing newline
    // on single-line commands, so we trim first to avoid false positives.
    if (typeof data.verify_command === 'string') {
      const trimmed = data.verify_command.trim();
      if (trimmed.includes('\n') && !trimmed.startsWith('#!')) {
        errors.push({
          code: KB_ERROR_CODES.FACT_VERIFY_COMMAND_MULTILINE_SHEBANG,
          message:
            'multi-line verify_command without a shebang line — fine, but consider adding `#!/usr/bin/env bash` for clarity',
          path: 'verify_command',
        });
      }
    }
  }

  // ----- Incident-narrative tier -----
  if (tier === 'incident-narrative') {
    if (typeof data.id !== 'string' || data.id.length === 0) {
      errors.push({
        code: KB_ERROR_CODES.INCIDENT_NARRATIVE_MISSING_DATE,
        message: 'incident-narrative tier requires an id (YYYY-MM-DD-slug)',
        path: 'id',
      });
    } else if (!INCIDENT_ID_RE.test(data.id)) {
      errors.push({
        code: KB_ERROR_CODES.INCIDENT_NARRATIVE_MISSING_DATE,
        message: `incident id must match YYYY-MM-DD-<slug> (got: ${data.id})`,
        path: 'id',
      });
    }
    if (data.date === undefined || data.date === null) {
      errors.push({
        code: KB_ERROR_CODES.INCIDENT_NARRATIVE_MISSING_DATE,
        message: 'incident-narrative tier requires date (YYYY-MM-DD)',
        path: 'date',
      });
    } else if (!is_date_like(data.date)) {
      errors.push({
        code: KB_ERROR_CODES.INCIDENT_NARRATIVE_MISSING_DATE,
        message: `date must be YYYY-MM-DD (got: ${String(data.date)})`,
        path: 'date',
      });
    }
    if (typeof data.severity !== 'string') {
      errors.push({
        code: KB_ERROR_CODES.INCIDENT_NARRATIVE_MISSING_SEVERITY,
        message: `incident-narrative tier requires severity (${INCIDENT_SEVERITY_VALUES.join('|')})`,
        path: 'severity',
      });
    } else if (!(INCIDENT_SEVERITY_VALUES as readonly string[]).includes(data.severity)) {
      errors.push({
        code: KB_ERROR_CODES.INCIDENT_NARRATIVE_INVALID_SEVERITY,
        message: `severity must be one of ${INCIDENT_SEVERITY_VALUES.join('|')} (got: ${data.severity})`,
        path: 'severity',
      });
    }
    if (typeof data.resolution_status !== 'string') {
      errors.push({
        code: KB_ERROR_CODES.INCIDENT_NARRATIVE_MISSING_RESOLUTION_STATUS,
        message: `incident-narrative tier requires resolution_status (${INCIDENT_RESOLUTION_VALUES.join('|')})`,
        path: 'resolution_status',
      });
    } else if (
      !(INCIDENT_RESOLUTION_VALUES as readonly string[]).includes(data.resolution_status)
    ) {
      errors.push({
        code: KB_ERROR_CODES.INCIDENT_NARRATIVE_INVALID_RESOLUTION_STATUS,
        message: `resolution_status must be one of ${INCIDENT_RESOLUTION_VALUES.join('|')} (got: ${data.resolution_status})`,
        path: 'resolution_status',
      });
    }
    if (!Array.isArray(data.components) || data.components.length === 0) {
      errors.push({
        code: KB_ERROR_CODES.INCIDENT_NARRATIVE_MISSING_COMPONENTS,
        message: 'incident-narrative tier requires at least one component',
        path: 'components',
      });
    }
  }

  // ----- Incident-facts tier -----
  if (tier === 'incident-facts') {
    if (typeof data.incident_id !== 'string' || data.incident_id.length === 0) {
      errors.push({
        code: KB_ERROR_CODES.INCIDENT_FACTS_MISSING_INCIDENT_ID,
        message: 'incident-facts tier requires incident_id',
        path: 'incident_id',
      });
    }
    if (!Array.isArray(data.produced)) {
      errors.push({
        code: KB_ERROR_CODES.INCIDENT_FACTS_MISSING_PRODUCED,
        message: 'incident-facts tier requires produced (array, may be empty)',
        path: 'produced',
      });
    }
  }

  // ----- Symptoms entries (any tier) -----
  if (Array.isArray(data.symptoms)) {
    for (let i = 0; i < data.symptoms.length; i++) {
      if (typeof data.symptoms[i] === 'string') {
        continue;
      }
      const text = data.symptoms[i] as Record<string, unknown>;
      const has_key =
        typeof text.alert_name === 'string' ||
        typeof text.user_phrase === 'string' ||
        Array.isArray(text.user_phrase) ||
        typeof text.error_pattern === 'string';
      if (!has_key) {
        errors.push({
          code: KB_ERROR_CODES.PLAYBOOK_SYMPTOM_MISSING_KEY,
          message: `symptoms[${i}] must have one of alert_name, user_phrase, or error_pattern`,
          path: `symptoms[${i}]`,
        });
      }
      if (typeof text.target !== 'string' || text.target.length === 0) {
        errors.push({
          code: KB_ERROR_CODES.PLAYBOOK_SYMPTOM_MISSING_TARGET,
          message: `symptoms[${i}] requires a target (anchor or path)`,
          path: `symptoms[${i}].target`,
        });
      }
      if (!Array.isArray(text.cites) || text.cites.length === 0) {
        errors.push({
          code: KB_ERROR_CODES.PLAYBOOK_SYMPTOM_MISSING_CITES,
          message: `symptoms[${i}] requires at least one cite (fact id)`,
          path: `symptoms[${i}].cites`,
        });
      }
    }
  }

  return errors;
}

export function validate_partial_metadata(data: unknown): {
  valid: boolean;
  errors: string[];
  data?: PartialDocumentMetadata;
} {
  const result = partial_metadata_schema.safeParse(data);

  if (result.success) {
    return { valid: true, errors: [], data: result.data };
  }

  const errors = result.error.errors.map(
    (error) => `${error.path.join('.')}: ${error.message}`
  );

  return { valid: false, errors };
}

/**
 * Get missing required fields, respecting both the version-exemption for
 * lifecycle-tracked tiers AND the tier-specific extension requirements.
 *
 *   - For non-lifecycle tiers: REQUIRED_FIELDS (all six, including version).
 *   - For lifecycle-tracked tiers: REQUIRED_FIELDS minus 'version', plus
 *     any tier-specific extensions from TIER_REQUIRED_EXTENSIONS.
 */
export function get_missing_required_fields(
  data: Record<string, unknown>
): string[] {
  const tier = typeof data.tier === 'string' ? data.tier : undefined;
  const is_lifecycle = is_lifecycle_tracked_tier(tier);
  const extensions = tier
    ? (TIER_REQUIRED_EXTENSIONS[tier as Tier] ?? [])
    : [];

  const base_required = REQUIRED_FIELDS.filter((field) => {
    if (field === 'version' && is_lifecycle) return false;
    return true;
  });

  const all_required = [...base_required, ...extensions];

  return all_required.filter((field) => {
    const value = (data as Record<string, unknown>)[field];
    if (value === undefined || value === null) return true;
    if (Array.isArray(value) && value.length === 0) {
      // provenance and components are required to be non-empty arrays;
      // produced (incident-facts) is allowed to be empty.
      return field === 'provenance' || field === 'components';
    }
    return false;
  });
}

export function get_missing_fields(
  data: Record<string, unknown>
): { required: string[]; optional: string[] } {
  const required = get_missing_required_fields(data);

  const optional = ALL_METADATA_FIELDS.filter(
    (field) =>
      !REQUIRED_FIELDS.includes(field as typeof REQUIRED_FIELDS[number]) &&
      !(field in data)
  );

  return { required, optional };
}

export function compute_metadata_completeness(
  data: Record<string, unknown>
): number {
  const present_fields = ALL_METADATA_FIELDS.filter(
    (field) => field in data && data[field] !== undefined && data[field] !== null
  );

  return (present_fields.length / ALL_METADATA_FIELDS.length) * 100;
}

export function get_field_category(
  field: MetadataField
): 'core' | 'status' | 'discovery' | 'ownership' | 'implementation' | 'auto' {
  if (['title', 'tier', 'domains', 'audience', 'tags'].includes(field)) {
    return 'core';
  }
  if (['status', 'last_updated', 'version'].includes(field)) {
    return 'status';
  }
  if (['purpose', 'related_docs', 'load_priority'].includes(field)) {
    return 'discovery';
  }
  if (['author', 'maintainer', 'review_frequency'].includes(field)) {
    return 'ownership';
  }
  if (['implementation_status', 'tested', 'production_ready'].includes(field)) {
    return 'implementation';
  }
  return 'auto';
}

// Re-export tier-related symbols that consumers (and the auditor) need.
export {
  LIFECYCLE_TRACKED_TIERS,
  is_lifecycle_tracked_tier as isLifecycleTrackedTier,
  DOC_STATUS_VALUES,
  FACT_CONFIDENCE_VALUES,
  INCIDENT_SEVERITY_VALUES,
  INCIDENT_RESOLUTION_VALUES,
  KEBAB_SLUG_RE,
  INCIDENT_ID_RE,
  TIER_REQUIRED_EXTENSIONS,
};
