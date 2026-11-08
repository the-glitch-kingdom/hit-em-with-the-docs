import { describe, it, expect } from 'vitest';
import {
  check_naming_convention,
  check_file_placement,
  check_file_size,
  check_required_sections,
  AUDIT_RULES,
} from '../../../src/core/audit/rules.js';

describe('Audit Rules', () => {
  describe('checkNamingConvention', () => {
    it('should accept valid kebab-case filenames', () => {
      const result = check_naming_convention('my-file-name.md');
      expect(result.valid).toBe(true);
    });

    it('should accept single word filenames', () => {
      const result = check_naming_convention('readme.md');
      expect(result.valid).toBe(true);
    });

    it('should accept special files', () => {
      expect(check_naming_convention('INDEX.md').valid).toBe(true);
      expect(check_naming_convention('REGISTRY.md').valid).toBe(true);
      expect(check_naming_convention('README.md').valid).toBe(true);
    });

    it('should reject camelCase filenames', () => {
      const result = check_naming_convention('myFileName.md');
      expect(result.valid).toBe(false);
      expect(result.suggestion).toBeDefined();
    });

    it('should reject snake_case filenames', () => {
      const result = check_naming_convention('my_file_name.md');
      expect(result.valid).toBe(false);
    });

    it('should reject PascalCase filenames', () => {
      const result = check_naming_convention('MyFileName.md');
      expect(result.valid).toBe(false);
    });

    it('should reject filenames with spaces', () => {
      const result = check_naming_convention('my file name.md');
      expect(result.valid).toBe(false);
    });

    it('should suggest kebab-case alternative', () => {
      const result = check_naming_convention('MyDocumentFile.md');
      expect(result.valid).toBe(false);
      expect(result.suggestion).toBeDefined();
      expect(result.suggestion).toContain('mydocumentfile.md');
    });
  });

  describe('checkFilePlacement', () => {
    it('should validate correct domain placement', () => {
      const result = check_file_placement(
        '.documentation/security/auth-guide.md',
        '.documentation',
        'security'
      );
      expect(result.valid).toBe(true);
    });

    it('should detect misplaced documents', () => {
      const result = check_file_placement(
        '.documentation/devops/auth-guide.md',
        '.documentation',
        'security' // metadata says security but file is in devops
      );
      expect(result.valid).toBe(false);
      expect(result.suggestion).toBeDefined();
    });

    it('should handle files in root directory', () => {
      const result = check_file_placement(
        '.documentation/standalone.md',
        '.documentation',
        undefined
      );
      // Root files without domain are invalid
      expect(result.valid).toBe(false);
    });

    it('should accept files when no domain is declared and matches path', () => {
      const result = check_file_placement(
        '.documentation/api/endpoints.md',
        '.documentation',
        undefined // no declared domain - will detect from path
      );
      // If domain can be detected from path, it should be valid
      expect(result.valid).toBe(true);
    });
  });

  describe('checkFileSize', () => {
    it('should accept files within size limits', () => {
      const result = check_file_size('test.md', 5 * 1024, 'guide'); // 5KB
      expect(result.valid).toBe(true);
    });

    it('should reject very small files', () => {
      const result = check_file_size('test.md', 100, 'guide'); // 0.1KB
      expect(result.valid).toBe(false);
      expect(result.message).toContain('small');
    });

    it('should reject very large files', () => {
      const result = check_file_size('test.md', 100 * 1024, 'guide'); // 100KB
      expect(result.valid).toBe(false);
      expect(result.message).toContain('large');
    });

    it('should use tier-specific limits', () => {
      // Reference docs can be larger
      const result = check_file_size('test.md', 80 * 1024, 'reference'); // 80KB
      expect(result.valid).toBe(true);
    });
  });

  describe('checkRequiredSections', () => {
    it('should pass for guide with required sections', () => {
      const content = `
# Guide Title

## Overview
Introduction text

## Prerequisites
Requirements

## Steps
Step by step guide
`;
      const result = check_required_sections(content, 'guide');
      expect(result.valid).toBe(true);
    });

    it('should fail for guide missing sections', () => {
      const content = `
# Guide Title

Just some content without proper sections.
`;
      const result = check_required_sections(content, 'guide');
      expect(result.valid).toBe(false);
      expect(result.message).toContain('Missing');
    });

    it('should pass for content without tier', () => {
      const content = 'Any content';
      const result = check_required_sections(content, undefined);
      expect(result.valid).toBe(true);
    });
  });

  describe('AUDIT_RULES', () => {
    it('should have defined audit rules', () => {
      expect(AUDIT_RULES).toBeDefined();
      expect(AUDIT_RULES.length).toBeGreaterThan(0);
    });

    it('should have required properties for each rule', () => {
      for (const rule of AUDIT_RULES) {
        expect(rule.id).toBeTruthy();
        expect(rule.name).toBeTruthy();
        expect(rule.description).toBeTruthy();
        expect(rule.severity).toMatch(/^(error|warning|info)$/);
        expect(typeof rule.check).toBe('function');
      }
    });

    it('should include naming convention rule', () => {
      const naming_rule = AUDIT_RULES.find(r => r.id === 'naming-convention');
      expect(naming_rule).toBeDefined();
    });

    it('should include placement rule', () => {
      const placement_rule = AUDIT_RULES.find(r => r.id === 'placement');
      expect(placement_rule).toBeDefined();
    });
  });
});
