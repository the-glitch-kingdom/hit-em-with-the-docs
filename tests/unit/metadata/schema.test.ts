import { describe, it, expect } from 'vitest';
import {
  MetadataSchema,
  validateMetadata,
  validatePartialMetadata,
  validateKnowledgeBaseFields,
  getMissingRequiredFields,
  getMissingFields,
  calculateMetadataCompleteness,
  REQUIRED_FIELDS,
  ALL_METADATA_FIELDS,
  getFieldCategory,
} from '../../../src/core/metadata/schema.js';
import { KB_ERROR_CODES } from '../../../src/core/metadata/errors.js';

describe('Metadata Schema', () => {
  describe('REQUIRED_FIELDS', () => {
    it('should have 6 required fields', () => {
      expect(REQUIRED_FIELDS).toHaveLength(6);
    });

    it('should include core required fields', () => {
      expect(REQUIRED_FIELDS).toContain('title');
      expect(REQUIRED_FIELDS).toContain('tier');
      expect(REQUIRED_FIELDS).toContain('domains');
      expect(REQUIRED_FIELDS).toContain('status');
      expect(REQUIRED_FIELDS).toContain('last_updated');
      expect(REQUIRED_FIELDS).toContain('version');
    });
  });

  describe('ALL_METADATA_FIELDS', () => {
    it('should have 21 fields', () => {
      expect(ALL_METADATA_FIELDS).toHaveLength(21);
    });
  });

  describe('validateMetadata', () => {
    it('should validate correct metadata', () => {
      const validMetadata = {
        title: 'Test Document',
        tier: 'guide',
        domains: ['security'],
        audience: ['all'],
        tags: ['test'],
        status: 'active',
        last_updated: '2025-01-01',
        version: '1.0.0',
      };

      const result = validateMetadata(validMetadata);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject invalid tier', () => {
      const invalidMetadata = {
        title: 'Test',
        tier: 'invalid-tier',
        domains: ['security'],
        status: 'active',
        last_updated: '2025-01-01',
        version: '1.0.0',
      };

      const result = validateMetadata(invalidMetadata);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject invalid date format', () => {
      const invalidMetadata = {
        title: 'Test',
        tier: 'guide',
        domains: ['security'],
        status: 'active',
        last_updated: '01-01-2025', // Wrong format
        version: '1.0.0',
      };

      const result = validateMetadata(invalidMetadata);
      expect(result.valid).toBe(false);
    });

    it('should reject invalid version format', () => {
      const invalidMetadata = {
        title: 'Test',
        tier: 'guide',
        domains: ['security'],
        status: 'active',
        last_updated: '2025-01-01',
        version: '1.0', // Missing patch version
      };

      const result = validateMetadata(invalidMetadata);
      expect(result.valid).toBe(false);
    });
  });

  describe('validatePartialMetadata', () => {
    it('should validate partial metadata', () => {
      const partialMetadata = {
        title: 'Test Document',
        tier: 'guide',
      };

      const result = validatePartialMetadata(partialMetadata);
      expect(result.valid).toBe(true);
    });

    it('should still reject invalid values', () => {
      const partialMetadata = {
        tier: 'invalid-tier',
      };

      const result = validatePartialMetadata(partialMetadata);
      expect(result.valid).toBe(false);
    });
  });

  describe('getMissingRequiredFields', () => {
    it('should return missing required fields', () => {
      const data = {
        title: 'Test',
        tier: 'guide',
      };

      const missing = getMissingRequiredFields(data);
      expect(missing).toContain('domains');
      expect(missing).toContain('status');
      expect(missing).toContain('last_updated');
      expect(missing).toContain('version');
      expect(missing).not.toContain('title');
      expect(missing).not.toContain('tier');
    });

    it('should return empty array when all required fields present', () => {
      const data = {
        title: 'Test',
        tier: 'guide',
        domains: ['security'],
        status: 'active',
        last_updated: '2025-01-01',
        version: '1.0.0',
      };

      const missing = getMissingRequiredFields(data);
      expect(missing).toHaveLength(0);
    });
  });

  describe('getMissingFields', () => {
    it('should return both required and optional missing fields', () => {
      const data = {
        title: 'Test',
      };

      const { required, optional } = getMissingFields(data);

      expect(required).toContain('tier');
      expect(required).toContain('domains');
      expect(optional).toContain('purpose');
      expect(optional).toContain('author');
    });
  });

  describe('calculateMetadataCompleteness', () => {
    it('should calculate 100% for complete metadata', () => {
      const data: Record<string, unknown> = {};
      for (const field of ALL_METADATA_FIELDS) {
        data[field] = 'value';
      }

      const completeness = calculateMetadataCompleteness(data);
      expect(completeness).toBe(100);
    });

    it('should calculate correct percentage for partial metadata', () => {
      const data = {
        title: 'Test',
        tier: 'guide',
        domains: ['security'],
        status: 'active',
        last_updated: '2025-01-01',
        version: '1.0.0',
      };

      const completeness = calculateMetadataCompleteness(data);
      // 6 out of 21 fields = ~28.57%
      expect(completeness).toBeCloseTo(28.57, 1);
    });

    it('should return 0 for empty metadata', () => {
      const completeness = calculateMetadataCompleteness({});
      expect(completeness).toBe(0);
    });
  });

  describe('getFieldCategory', () => {
    it('should categorize core fields', () => {
      expect(getFieldCategory('title')).toBe('core');
      expect(getFieldCategory('tier')).toBe('core');
      expect(getFieldCategory('domains')).toBe('core');
    });

    it('should categorize status fields', () => {
      expect(getFieldCategory('status')).toBe('status');
      expect(getFieldCategory('last_updated')).toBe('status');
      expect(getFieldCategory('version')).toBe('status');
    });

    it('should categorize auto-generated fields', () => {
      expect(getFieldCategory('word_count')).toBe('auto');
      expect(getFieldCategory('estimated_read_time')).toBe('auto');
      expect(getFieldCategory('backlinks')).toBe('auto');
    });
  });

  // --- 2.2.0: tier: "plan" + conditional version requirement ---
  describe('plan tier (2.2.0)', () => {
    describe('validateMetadata', () => {
      it('accepts plan tier without version', () => {
        const planMetadata = {
          title: 'My Phase Plan',
          tier: 'plan',
          domains: ['planning'],
          status: 'active',
          last_updated: '2026-05-07',
          // version intentionally omitted
        };

        const result = validateMetadata(planMetadata);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('accepts plan tier WITH version (version is allowed, just not required)', () => {
        const planMetadata = {
          title: 'My Phase Plan',
          tier: 'plan',
          domains: ['planning'],
          status: 'active',
          last_updated: '2026-05-07',
          version: '1.0.0',
        };

        const result = validateMetadata(planMetadata);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('still rejects plan tier with INVALID version format', () => {
        const planMetadata = {
          title: 'My Phase Plan',
          tier: 'plan',
          domains: ['planning'],
          status: 'active',
          last_updated: '2026-05-07',
          version: 'not-semver',
        };

        const result = validateMetadata(planMetadata);
        expect(result.valid).toBe(false);
      });

      it('still requires version for non-plan tiers (regression on existing behavior)', () => {
        const guideWithoutVersion = {
          title: 'Guide',
          tier: 'guide',
          domains: ['planning'],
          status: 'active',
          last_updated: '2026-05-07',
          // version intentionally omitted — should fail
        };

        const result = validateMetadata(guideWithoutVersion);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('version'))).toBe(true);
      });

      it('still rejects plan tier with bad date format', () => {
        const planMetadata = {
          title: 'My Plan',
          tier: 'plan',
          domains: ['planning'],
          status: 'active',
          last_updated: '05/07/2026', // wrong format
        };

        const result = validateMetadata(planMetadata);
        expect(result.valid).toBe(false);
      });
    });

    describe('getMissingRequiredFields', () => {
      it('does NOT report version as missing when tier is plan', () => {
        const data = {
          title: 'My Plan',
          tier: 'plan',
          domains: ['planning'],
          status: 'active',
          last_updated: '2026-05-07',
          // no version
        };

        const missing = getMissingRequiredFields(data);
        expect(missing).not.toContain('version');
        expect(missing).toHaveLength(0);
      });

      it('still reports version as missing for non-plan tiers', () => {
        const data = {
          title: 'Guide',
          tier: 'guide',
          domains: ['security'],
          status: 'active',
          last_updated: '2026-05-07',
          // no version
        };

        const missing = getMissingRequiredFields(data);
        expect(missing).toContain('version');
        expect(missing).toHaveLength(1);
      });

      it('still reports OTHER missing fields for plan tier', () => {
        const data = {
          title: 'My Plan',
          tier: 'plan',
          // missing domains, status, last_updated
        };

        const missing = getMissingRequiredFields(data);
        expect(missing).toContain('domains');
        expect(missing).toContain('status');
        expect(missing).toContain('last_updated');
        expect(missing).not.toContain('version'); // exempt for plan
        expect(missing).not.toContain('title');
        expect(missing).not.toContain('tier');
      });
    });

    describe('PartialMetadataSchema', () => {
      it('still allows partial plan metadata (tier alone)', () => {
        const result = validatePartialMetadata({ tier: 'plan' });
        expect(result.valid).toBe(true);
      });
    });

    // The status field is conditionally restricted:
    //   - tier === 'plan': any non-empty string accepted (plans use their own
    //     lifecycle enums: phase/task = draft|active|paused|done|archived,
    //     atom = ready|in_progress|done|blocked)
    //   - tier !== 'plan': must be one of draft|active|deprecated|archived
    //     (the historical doc-tier enum, regression-preserving)
    describe('status field — conditional enum (added in 2.2.0 alongside plan tier)', () => {
      it('accepts plan-specific status values for plan tier (e.g. "paused", "done")', () => {
        for (const status of ['draft', 'active', 'paused', 'done', 'archived']) {
          const result = validateMetadata({
            title: 'My Phase',
            tier: 'plan',
            domains: ['planning'],
            status,
            last_updated: '2026-05-07',
          });
          expect(result.valid, `phase status "${status}" should be valid`).toBe(true);
        }
      });

      it('accepts atom-specific status values for plan tier (e.g. "ready", "in_progress", "blocked")', () => {
        for (const status of ['ready', 'in_progress', 'done', 'blocked']) {
          const result = validateMetadata({
            title: 'My Atom',
            tier: 'plan',
            domains: ['planning'],
            status,
            last_updated: '2026-05-07',
          });
          expect(result.valid, `atom status "${status}" should be valid`).toBe(true);
        }
      });

      it('rejects "ready" status for non-plan tiers (regression preservation)', () => {
        const result = validateMetadata({
          title: 'Guide',
          tier: 'guide',
          domains: ['security'],
          status: 'ready', // not in doc-tier enum
          last_updated: '2026-05-07',
          version: '1.0.0',
        });
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('status'))).toBe(true);
      });

      it('rejects "paused" status for non-plan tiers (regression preservation)', () => {
        const result = validateMetadata({
          title: 'Guide',
          tier: 'guide',
          domains: ['security'],
          status: 'paused',
          last_updated: '2026-05-07',
          version: '1.0.0',
        });
        expect(result.valid).toBe(false);
      });

      it('still accepts the historical doc-tier enum values for non-plan tiers', () => {
        for (const status of ['draft', 'active', 'deprecated', 'archived']) {
          const result = validateMetadata({
            title: 'Guide',
            tier: 'guide',
            domains: ['security'],
            status,
            last_updated: '2026-05-07',
            version: '1.0.0',
          });
          expect(result.valid, `doc status "${status}" should be valid`).toBe(true);
        }
      });

      it('rejects empty status string for plan tier (status is still required, just not enum-restricted)', () => {
        const result = validateMetadata({
          title: 'My Plan',
          tier: 'plan',
          domains: ['planning'],
          status: '',
          last_updated: '2026-05-07',
        });
        expect(result.valid).toBe(false);
      });
    });
  });

  // --- 2.3.0: knowledge-base primitives (fact / incident-narrative / incident-facts / symptoms) ---

  describe('fact tier (2.3.0)', () => {
    const validFact = {
      title: 'Alloy reads env only at entrypoint',
      tier: 'fact',
      domains: ['observability'],
      status: 'active',
      last_updated: '2026-05-14',
      id: 'alloy-env-set-at-entrypoint-only',
      confidence: 'high',
      last_verified: '2026-05-14',
      provenance: ['incidents/2026-05-14-vault-alloy-stuck/'],
    };

    it('accepts a valid fact (no version required)', () => {
      const result = validateMetadata(validFact);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('accepts a fact WITH version (optional, not forbidden)', () => {
      const result = validateMetadata({ ...validFact, version: '1.0.0' });
      expect(result.valid).toBe(true);
    });

    it('accepts plan-style status values for fact tier (lifecycle-tracked)', () => {
      for (const status of ['draft', 'active', 'deprecated', 'archived', 'weakened']) {
        const result = validateMetadata({ ...validFact, status });
        expect(result.valid, `fact status "${status}" should be valid`).toBe(true);
      }
    });

    it('validateKnowledgeBaseFields flags FACT_MISSING_ID when id absent', () => {
      const errs = validateKnowledgeBaseFields({ ...validFact, id: undefined });
      expect(errs.some((e) => e.code === KB_ERROR_CODES.FACT_MISSING_ID)).toBe(true);
    });

    it('flags FACT_MISSING_ID when id is not kebab-case', () => {
      const errs = validateKnowledgeBaseFields({ ...validFact, id: 'NotKebabCase' });
      expect(errs.some((e) => e.code === KB_ERROR_CODES.FACT_MISSING_ID)).toBe(true);
    });

    it('flags FACT_INVALID_CONFIDENCE when confidence is out of enum', () => {
      const errs = validateKnowledgeBaseFields({
        ...validFact,
        confidence: 'definitely',
      });
      expect(errs.some((e) => e.code === KB_ERROR_CODES.FACT_INVALID_CONFIDENCE)).toBe(
        true
      );
    });

    it('flags FACT_MISSING_LAST_VERIFIED when missing or wrong format', () => {
      const errsMissing = validateKnowledgeBaseFields({
        ...validFact,
        last_verified: undefined,
      });
      expect(
        errsMissing.some((e) => e.code === KB_ERROR_CODES.FACT_MISSING_LAST_VERIFIED)
      ).toBe(true);

      const errsBadFormat = validateKnowledgeBaseFields({
        ...validFact,
        last_verified: '05/14/2026',
      });
      expect(
        errsBadFormat.some((e) => e.code === KB_ERROR_CODES.FACT_MISSING_LAST_VERIFIED)
      ).toBe(true);
    });

    it('flags FACT_MISSING_PROVENANCE when provenance is empty or absent', () => {
      const errsEmpty = validateKnowledgeBaseFields({
        ...validFact,
        provenance: [],
      });
      expect(
        errsEmpty.some((e) => e.code === KB_ERROR_CODES.FACT_MISSING_PROVENANCE)
      ).toBe(true);

      const errsMissing = validateKnowledgeBaseFields({
        ...validFact,
        provenance: undefined,
      });
      expect(
        errsMissing.some((e) => e.code === KB_ERROR_CODES.FACT_MISSING_PROVENANCE)
      ).toBe(true);
    });

    it('flags FACT_VERIFY_COMMAND_MULTILINE_SHEBANG for multi-line verify_command without shebang', () => {
      const errs = validateKnowledgeBaseFields({
        ...validFact,
        verify_command: 'echo hello\necho world',
      });
      expect(
        errs.some((e) => e.code === KB_ERROR_CODES.FACT_VERIFY_COMMAND_MULTILINE_SHEBANG)
      ).toBe(true);
    });

    it('does NOT flag multi-line verify_command WITH shebang', () => {
      const errs = validateKnowledgeBaseFields({
        ...validFact,
        verify_command: '#!/usr/bin/env bash\necho hello\necho world',
      });
      expect(
        errs.some((e) => e.code === KB_ERROR_CODES.FACT_VERIFY_COMMAND_MULTILINE_SHEBANG)
      ).toBe(false);
    });

    it('getMissingRequiredFields reports fact extensions but not version', () => {
      const missing = getMissingRequiredFields({
        title: 'My Fact',
        tier: 'fact',
        domains: ['observability'],
        status: 'active',
        last_updated: '2026-05-14',
        // missing: id, confidence, last_verified, provenance
      });
      expect(missing).toContain('id');
      expect(missing).toContain('confidence');
      expect(missing).toContain('last_verified');
      expect(missing).toContain('provenance');
      expect(missing).not.toContain('version');
    });
  });

  describe('incident-narrative tier (2.3.0)', () => {
    const validIncident = {
      title: 'Vault Down on Auth-Staging',
      tier: 'incident-narrative',
      domains: ['incidents', 'observability'],
      status: 'active',
      last_updated: '2026-05-14',
      id: '2026-05-14-vault-alloy-stuck',
      date: '2026-05-14',
      severity: 'high',
      resolution_status: 'resolved',
      components: ['vault', 'alloy', 'grafana'],
    };

    it('accepts a valid incident-narrative (no version required)', () => {
      const result = validateMetadata(validIncident);
      expect(result.valid).toBe(true);
    });

    it('flags missing date', () => {
      const errs = validateKnowledgeBaseFields({ ...validIncident, date: undefined });
      expect(
        errs.some((e) => e.code === KB_ERROR_CODES.INCIDENT_NARRATIVE_MISSING_DATE)
      ).toBe(true);
    });

    it('flags invalid severity', () => {
      const errs = validateKnowledgeBaseFields({ ...validIncident, severity: 'sev0' });
      expect(
        errs.some((e) => e.code === KB_ERROR_CODES.INCIDENT_NARRATIVE_INVALID_SEVERITY)
      ).toBe(true);
    });

    it('flags missing resolution_status', () => {
      const errs = validateKnowledgeBaseFields({
        ...validIncident,
        resolution_status: undefined,
      });
      expect(
        errs.some(
          (e) => e.code === KB_ERROR_CODES.INCIDENT_NARRATIVE_MISSING_RESOLUTION_STATUS
        )
      ).toBe(true);
    });

    it('flags invalid resolution_status enum', () => {
      const errs = validateKnowledgeBaseFields({
        ...validIncident,
        resolution_status: 'pending',
      });
      expect(
        errs.some(
          (e) => e.code === KB_ERROR_CODES.INCIDENT_NARRATIVE_INVALID_RESOLUTION_STATUS
        )
      ).toBe(true);
    });

    it('flags empty components', () => {
      const errs = validateKnowledgeBaseFields({ ...validIncident, components: [] });
      expect(
        errs.some(
          (e) => e.code === KB_ERROR_CODES.INCIDENT_NARRATIVE_MISSING_COMPONENTS
        )
      ).toBe(true);
    });

    it('flags id that does not match YYYY-MM-DD-slug pattern', () => {
      const errs = validateKnowledgeBaseFields({
        ...validIncident,
        id: 'not-an-incident-id',
      });
      expect(
        errs.some((e) => e.code === KB_ERROR_CODES.INCIDENT_NARRATIVE_MISSING_DATE)
      ).toBe(true);
    });
  });

  describe('incident-facts tier (2.3.0)', () => {
    const validBridge = {
      title: 'Facts from 2026-05-14 vault-alloy-stuck',
      tier: 'incident-facts',
      domains: ['incidents'],
      status: 'active',
      last_updated: '2026-05-14',
      incident_id: '2026-05-14-vault-alloy-stuck',
      produced: ['alloy-env-set-at-entrypoint-only', 'vault-server-log-omits-metrics-403s'],
    };

    it('accepts a valid incident-facts bridge', () => {
      const result = validateMetadata(validBridge);
      expect(result.valid).toBe(true);
    });

    it('accepts empty produced array (incident may have produced no new facts)', () => {
      const result = validateMetadata({ ...validBridge, produced: [] });
      expect(result.valid).toBe(true);
    });

    it('flags missing incident_id', () => {
      const errs = validateKnowledgeBaseFields({
        ...validBridge,
        incident_id: undefined,
      });
      expect(
        errs.some((e) => e.code === KB_ERROR_CODES.INCIDENT_FACTS_MISSING_INCIDENT_ID)
      ).toBe(true);
    });

    it('flags missing produced field (must be an array, even if empty)', () => {
      const errs = validateKnowledgeBaseFields({
        ...validBridge,
        produced: undefined,
      });
      expect(
        errs.some((e) => e.code === KB_ERROR_CODES.INCIDENT_FACTS_MISSING_PRODUCED)
      ).toBe(true);
    });

    it('getMissingRequiredFields treats empty produced array as PRESENT (allowed)', () => {
      const missing = getMissingRequiredFields({
        ...validBridge,
        produced: [],
      });
      expect(missing).not.toContain('produced');
    });
  });

  describe('symptoms field (2.3.0) — playbook frontmatter', () => {
    const playbookBase = {
      title: 'Grafana Alerts Runbook',
      tier: 'admin',
      domains: ['observability'],
      status: 'active',
      last_updated: '2026-05-14',
      version: '1.0.0',
    };

    it('accepts a playbook with a valid symptoms block (any tier)', () => {
      const result = validateMetadata({
        ...playbookBase,
        symptoms: [
          {
            alert_name: 'Vault Down — auth-staging',
            severity: 'critical',
            target: '#vault-down-auth-staging',
            cites: ['alloy-env-set-at-entrypoint-only'],
          },
          {
            user_phrase: ['metrics missing', 'scrape down'],
            target: '#vault-down-auth-staging',
            cites: ['alloy-env-set-at-entrypoint-only'],
          },
          {
            error_pattern: '^Vault timeout.*$',
            target: '#vault-timeout',
            cites: ['vault-server-log-omits-metrics-403s'],
          },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it('flags PLAYBOOK_SYMPTOM_MISSING_KEY when none of alert_name/user_phrase/error_pattern present', () => {
      const errs = validateKnowledgeBaseFields({
        ...playbookBase,
        symptoms: [{ target: '#anchor', cites: ['some-fact'] }],
      });
      expect(
        errs.some((e) => e.code === KB_ERROR_CODES.PLAYBOOK_SYMPTOM_MISSING_KEY)
      ).toBe(true);
    });

    it('flags PLAYBOOK_SYMPTOM_MISSING_TARGET when target absent', () => {
      const errs = validateKnowledgeBaseFields({
        ...playbookBase,
        symptoms: [{ alert_name: 'Some Alert', cites: ['some-fact'] }],
      });
      expect(
        errs.some((e) => e.code === KB_ERROR_CODES.PLAYBOOK_SYMPTOM_MISSING_TARGET)
      ).toBe(true);
    });

    it('flags PLAYBOOK_SYMPTOM_MISSING_CITES when cites empty or absent', () => {
      const errs = validateKnowledgeBaseFields({
        ...playbookBase,
        symptoms: [
          { alert_name: 'Some Alert', target: '#anchor', cites: [] },
        ],
      });
      expect(
        errs.some((e) => e.code === KB_ERROR_CODES.PLAYBOOK_SYMPTOM_MISSING_CITES)
      ).toBe(true);
    });

    it('does not flag anything when symptoms field is absent', () => {
      const errs = validateKnowledgeBaseFields(playbookBase);
      expect(errs).toEqual([]);
    });

    describe('plain-string symptoms (#46)', () => {
      const fact = {
        title: 'pkill -f exits 144',
        tier: 'fact',
        domains: ['observability'],
        status: 'active',
        last_updated: '2026-10-25',
        id: 'pkill-f-exit-144',
        confidence: 'high',
        last_verified: '2026-10-25',
        provenance: ['incidents/2026-10-25-x/'],
      };

      it('accepts plain strings on a fact, alone or mixed with object entries', () => {
        const symptoms = [
          'pkill -f: Exit code 144',
          { error_pattern: '^Exit code 144$', target: '#instead', cites: ['other-fact'] },
        ];
        expect(validateMetadata({ ...fact, symptoms }).valid).toBe(true);
        expect(validateKnowledgeBaseFields({ ...fact, symptoms })).toEqual([]);
      });

      it('rejects plain strings on other tiers with one clear error each', () => {
        const symptoms = ['pkill -f: Exit code 144'];
        expect(validateMetadata({ ...playbookBase, symptoms }).valid).toBe(false);
        const errs = validateKnowledgeBaseFields({ ...playbookBase, symptoms });
        expect(errs).toHaveLength(1);
        expect(errs[0]!.code).toBe(KB_ERROR_CODES.PLAYBOOK_SYMPTOM_MISSING_KEY);
        expect(errs[0]!.message).toMatch(/plain string; only fact docs/);
      });

      it('still requires target and cites on object entries of a fact', () => {
        const errs = validateKnowledgeBaseFields({
          ...fact,
          symptoms: [{ error_pattern: 'x' }],
        });
        expect(errs.map((e) => e.code)).toEqual([
          KB_ERROR_CODES.PLAYBOOK_SYMPTOM_MISSING_TARGET,
          KB_ERROR_CODES.PLAYBOOK_SYMPTOM_MISSING_CITES,
        ]);
      });

      it('rejects an empty string', () => {
        expect(validateMetadata({ ...fact, symptoms: [''] }).valid).toBe(false);
      });

      it('partial schema accepts plain strings', () => {
        expect(validatePartialMetadata({ symptoms: ['pkill -f: Exit code 144'] }).valid).toBe(true);
      });
    });
  });

  describe('backward compatibility (2.3.0 regression preservation)', () => {
    it('existing guide doc with all 6 required fields still validates clean', () => {
      const result = validateMetadata({
        title: 'Setup Guide',
        tier: 'guide',
        domains: ['onboarding'],
        status: 'active',
        last_updated: '2026-05-14',
        version: '1.0.0',
      });
      expect(result.valid).toBe(true);
    });

    it('existing plan tier (2.2.0) still validates without version', () => {
      const result = validateMetadata({
        title: 'Phase Plan',
        tier: 'plan',
        domains: ['planning'],
        status: 'active',
        last_updated: '2026-05-14',
      });
      expect(result.valid).toBe(true);
    });

    it('REQUIRED_FIELDS length unchanged at 6 (additions are tier-specific extensions, not new universal requirements)', () => {
      expect(REQUIRED_FIELDS).toHaveLength(6);
    });

    it('ALL_METADATA_FIELDS length unchanged at 21 (KB extensions are not universal fields)', () => {
      expect(ALL_METADATA_FIELDS).toHaveLength(21);
    });

    it('validateKnowledgeBaseFields is a no-op for non-KB tiers', () => {
      expect(
        validateKnowledgeBaseFields({
          title: 'Guide',
          tier: 'guide',
          domains: ['security'],
          status: 'active',
          last_updated: '2026-05-14',
          version: '1.0.0',
        })
      ).toEqual([]);
    });

    it('validateKnowledgeBaseFields is a no-op for plan tier (existing 2.2.0 behavior preserved)', () => {
      expect(
        validateKnowledgeBaseFields({
          title: 'My Plan',
          tier: 'plan',
          domains: ['planning'],
          status: 'active',
          last_updated: '2026-05-14',
        })
      ).toEqual([]);
    });
  });
});
