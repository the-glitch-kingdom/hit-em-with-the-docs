import { describe, it, expect } from 'vitest';
import { is_stateable_constant } from '../../../src/core/security/gate.js';
import { SURFACE_DETECTORS } from '../../../src/core/coverage/surfaces/detectors.js';

// #120: a number under a person, account or OS-identity name is an id, in every language
describe('numeric ids are never stated (#120)', () => {
  for (const [name, value] of [['ADMIN_UID', '90210'], ['SUPPORT_USER', '31337'], ['ROOT_GID', '0'], ['OWNER_ID', '42'], ['BILLING_ACCOUNT', '77'], ['CUSTOMER_PID', '12'], ['USER_LIMIT', '500'], ['DEFAULT_EMAIL', '5']] as const) {
    it(`refuses ${name}`, () => expect(is_stateable_constant(name, value)).toBe(false));
  }
  it('still states a plain limit and a plural limit', () => {
    expect(is_stateable_constant('MAX_RETRIES', '5')).toBe(true);
    expect(is_stateable_constant('MAX_USERS', '500')).toBe(true);
  });
  const sources: [string, string, string][] = [
    ['Java', 'A.java', 'public class A {\n  static final int ADMIN_UID = 90210;\n  static final int MAX_RETRIES = 5;\n}\n'],
    ['Kotlin', 'A.kt', 'const val ADMIN_UID = 90210\nconst val MAX_RETRIES = 5\n'],
    ['C#', 'A.cs', 'class A {\n  public const int ADMIN_UID = 90210;\n  public const int MaxRetries = 5;\n}\n'],
    ['Ruby', 'a.rb', 'ADMIN_UID = 90210\nMAX_RETRIES = 5\n'],
    ['Python', 'a.py', 'ADMIN_UID = 90210\nMAX_RETRIES = 5\n'],
    ['TS', 'a.ts', 'export const ADMIN_UID = 90210;\nexport const MAX_RETRIES = 5;\n'],
  ];
  for (const [language, file, text] of sources) {
    it(`${language}: the detector finds the id without its value`, () => {
      const found = SURFACE_DETECTORS.filter((detector) => detector.applies(file)).flatMap((detector) => detector.detect(file, text.split('\n')));
      const admin = found.find((surface: any) => surface.name === 'ADMIN_UID');
      expect(admin?.value).toBeUndefined();
      const retries = found.find((surface: any) => surface.name === (language === 'C#' ? 'MaxRetries' : 'MAX_RETRIES'));
      expect(retries?.value).toBe('5');
    });
  }
});
