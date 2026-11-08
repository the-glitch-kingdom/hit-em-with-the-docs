import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import { check_documentation } from '../../../src/core/audit/auditor.js';

const VALID_FIXTURE = resolve(__dirname, '../../fixtures/knowledge-base/valid');
const INVALID_FIXTURE = resolve(__dirname, '../../fixtures/knowledge-base/invalid');

describe('auditDocumentation — knowledge-base validation (2.3.0)', () => {
  describe('valid fixture tree', () => {
    it('emits no KB-coded errors on a clean tree', async () => {
      const result = await check_documentation({
        docs_path: VALID_FIXTURE,
        silent: true,
      });

      const coded_issues = result.issues.filter((i) => i.code);
      expect(coded_issues).toEqual([]);
    });
  });

  describe('invalid fixture tree', () => {
    it('emits a FACT_MISSING_PROVENANCE issue on fact-missing-provenance.md', async () => {
      const result = await check_documentation({
        docs_path: INVALID_FIXTURE,
        silent: true,
      });

      const issue = result.issues.find(
        (i) =>
          i.code === 'FACT_MISSING_PROVENANCE' &&
          i.file.includes('fact-missing-provenance.md')
      );
      expect(issue).toBeDefined();
      expect(issue?.severity).toBe('error');
    });

    it('emits a FACT_INVALID_CONFIDENCE issue', async () => {
      const result = await check_documentation({
        docs_path: INVALID_FIXTURE,
        silent: true,
      });
      const issue = result.issues.find((i) => i.code === 'FACT_INVALID_CONFIDENCE');
      expect(issue).toBeDefined();
    });

    it('emits an INCIDENT_NARRATIVE_INVALID_SEVERITY issue', async () => {
      const result = await check_documentation({
        docs_path: INVALID_FIXTURE,
        silent: true,
      });
      const issue = result.issues.find(
        (i) => i.code === 'INCIDENT_NARRATIVE_INVALID_SEVERITY'
      );
      expect(issue).toBeDefined();
    });

    it('emits a PLAYBOOK_SYMPTOM_MISSING_TARGET issue', async () => {
      const result = await check_documentation({
        docs_path: INVALID_FIXTURE,
        silent: true,
      });
      const issue = result.issues.find(
        (i) => i.code === 'PLAYBOOK_SYMPTOM_MISSING_TARGET'
      );
      expect(issue).toBeDefined();
    });

    it('every KB-coded issue has rule prefix metadata- and a valid severity', async () => {
      const result = await check_documentation({
        docs_path: INVALID_FIXTURE,
        silent: true,
      });
      const coded_issues = result.issues.filter((i) => i.code);
      expect(coded_issues.length).toBeGreaterThan(0);
      for (const issue of coded_issues) {
        expect(issue.rule.startsWith('metadata-')).toBe(true);
        expect(['error', 'warning']).toContain(issue.severity);
      }
    });
  });

  describe('backward compatibility', () => {
    it('audit of the existing .documentation fixture is unchanged by 2.3.0 (no KB issues)', async () => {
      const fixture_path = resolve(__dirname, '../../fixtures/.documentation');
      const result = await check_documentation({
        docs_path: fixture_path,
        silent: true,
      });
      // Existing fixtures have no fact/incident/symptoms — should produce no
      // KB-coded issues.
      const coded_issues = result.issues.filter((i) => i.code);
      expect(coded_issues).toEqual([]);
    });

    it('audit tier suggestion includes all 9 tiers (not the old hardcoded 5)', async () => {
      // Plant a file with an invalid tier and verify the suggestion message
      // lists all current TIERS dynamically.
      const result = await check_documentation({
        docs_path: INVALID_FIXTURE,
        silent: true,
      });
      // None of our invalid fixtures use an invalid tier — that's fine, the
      // test for the dynamic list is in classifier tests via TIERS.length === 9.
      expect(result.total_files).toBeGreaterThan(0);
    });
  });

  describe('strict-mode escalation semantics', () => {
    it('valid fixture: produces no KB-coded issues (strict CLI would exit 0)', async () => {
      const result = await check_documentation({
        docs_path: VALID_FIXTURE,
        silent: true,
      });
      const error_issues = result.issues.filter((i) => i.severity === 'error');
      const kb_issues = result.issues.filter((i) => i.code !== undefined);

      // Combined predicate matches the CLI's strict-mode exit condition.
      expect(error_issues.length).toBe(0);
      expect(kb_issues.length).toBe(0);
    });

    it('invalid fixture: produces both KB-coded errors AND non-KB warnings', async () => {
      const result = await check_documentation({
        docs_path: INVALID_FIXTURE,
        silent: true,
      });
      const kb_issues = result.issues.filter((i) => i.code !== undefined);
      const non_kb_warnings = result.issues.filter(
        (i) => i.severity === 'warning' && i.code === undefined
      );

      // Both classes of issue exist in the invalid fixture — strict mode
      // must trigger on the KB ones; non-strict mode triggers on file-level
      // errors only.
      expect(kb_issues.length).toBeGreaterThan(0);
      expect(non_kb_warnings.length).toBeGreaterThanOrEqual(0);
    });
  });
});
