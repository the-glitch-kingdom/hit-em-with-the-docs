import { describe, it, expect } from 'vitest';
import {
  DOMAINS,
  DOMAIN_DEFINITIONS,
  is_builtin_domain,
} from '../../../src/core/domains/constants.js';
import {
  get_domain_definition,
  get_all_domains,
  get_domains_by_category,
  get_domains_by_priority,
  is_valid_domain,
  get_all_keywords,
} from '../../../src/core/domains/registry.js';

describe('Domain Constants', () => {
  describe('DOMAINS', () => {
    it('should have 15 domains', () => {
      expect(DOMAINS).toHaveLength(15);
    });

    it('should include all expected domains', () => {
      const expected_domains = [
        'agents', 'api', 'architecture', 'backups', 'database',
        'devops', 'features', 'plans', 'procedures', 'quickstart',
        'security', 'standards', 'testing', 'troubleshooting', 'workflows',
      ];

      for (const domain of expected_domains) {
        expect(DOMAINS).toContain(domain);
      }
    });
  });

  describe('DOMAIN_DEFINITIONS', () => {
    it('should have a definition for each domain', () => {
      for (const domain of DOMAINS) {
        expect(DOMAIN_DEFINITIONS[domain]).toBeDefined();
      }
    });

    it('should have required properties for each definition', () => {
      for (const domain of DOMAINS) {
        const def = DOMAIN_DEFINITIONS[domain];
        expect(def.id).toBe(domain);
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.keywords).toBeInstanceOf(Array);
        expect(def.keywords.length).toBeGreaterThan(0);
        expect(def.loadPriority).toBeGreaterThanOrEqual(1);
        expect(def.loadPriority).toBeLessThanOrEqual(10);
        expect(['core', 'development', 'features', 'advanced']).toContain(def.category);
      }
    });
  });

  describe('getDomainDefinition', () => {
    it('should return the correct definition', () => {
      const security_def = get_domain_definition('security');
      expect(security_def.id).toBe('security');
      expect(security_def.name).toBe('Security');
    });
  });

  describe('getAllDomains', () => {
    it('should return all domains', () => {
      const domains = get_all_domains();
      expect(domains).toEqual(DOMAINS);
    });
  });

  describe('getDomainsByCategory', () => {
    it('should return domains for core category', () => {
      const core_domains = get_domains_by_category('core');
      expect(core_domains).toContain('security');
      expect(core_domains).toContain('devops');
      expect(core_domains).toContain('database');
      expect(core_domains).toContain('api');
    });

    it('should return domains for development category', () => {
      const dev_domains = get_domains_by_category('development');
      expect(dev_domains).toContain('standards');
      expect(dev_domains).toContain('testing');
    });
  });

  describe('getDomainsByPriority', () => {
    it('should return domains sorted by priority (highest first)', () => {
      const sorted = get_domains_by_priority();

      // First domain should have highest priority
      const first_priority = DOMAIN_DEFINITIONS[sorted[0]!].loadPriority;
      const last_priority = DOMAIN_DEFINITIONS[sorted[sorted.length - 1]!].loadPriority;

      expect(first_priority).toBeGreaterThanOrEqual(last_priority);
    });

    it('should have standards near the top (priority 10)', () => {
      const sorted = get_domains_by_priority();
      const standards_index = sorted.indexOf('standards');
      expect(standards_index).toBeLessThan(5);
    });
  });

  describe('isValidDomain', () => {
    it('should return true for valid domains', () => {
      expect(is_valid_domain('security')).toBe(true);
      expect(is_valid_domain('api')).toBe(true);
      expect(is_valid_domain('standards')).toBe(true);
    });

    it('should return false for invalid domains', () => {
      expect(is_valid_domain('invalid')).toBe(false);
      expect(is_valid_domain('')).toBe(false);
      expect(is_valid_domain('SECURITY')).toBe(false); // Case sensitive
    });
  });

  describe('isBuiltinDomain', () => {
    it('should return true only for the 15 compiled-in domains', () => {
      expect(is_builtin_domain('security')).toBe(true);
      expect(is_builtin_domain('workflows')).toBe(true);
    });

    it('should return false for non-built-in / custom ids', () => {
      expect(is_builtin_domain('compliance')).toBe(false);
      expect(is_builtin_domain('')).toBe(false);
    });
  });

  describe('getAllKeywords', () => {
    it('should return a map of keywords to domains', () => {
      const keywords = get_all_keywords();

      expect(keywords).toBeInstanceOf(Map);
      expect(keywords.size).toBeGreaterThan(0);
    });

    it('should map security keywords to security domain', () => {
      const keywords = get_all_keywords();

      const security_keyword = keywords.get('security');
      expect(security_keyword).toContain('security');

      const auth_keyword = keywords.get('auth');
      expect(auth_keyword).toContain('security');
    });
  });
});
