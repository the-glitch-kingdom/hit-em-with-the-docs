// Regression tests for the #115 adversarial review findings (3.6.0).
import { describe, it, expect } from 'vitest';
import { check_security_gate, is_constant_value } from '../../../src/core/security/gate.js';
import { extract_stated_constant } from '../../../src/core/coverage/draft.js';
import { resolve_decision, type DocText } from '../../../src/core/coverage/decide.js';

const config = { allow: [], disabled_rules: [] };
const rules = (text: string): string[] => check_security_gate(text, 'draft', config).map((finding) => finding.rule);

describe('credential-named numeric constants are never stated (review: DB_PASS = 99887766 reached a draft)', () => {
  for (const line of ['DB_PASS = 99887766', 'MASTER_PASSCODE = 20481234', 'OTP_SEED = 918273645', 'SSN = 123456789', 'CARD_NUMBER = 4111111111111111', 'ADMIN_PIN = 4321', 'HMAC_NONCE = 77', 'TOTP_SECRET_DIGITS = 6123'])
    it(`${line} is not a stated constant, and the gate refuses it`, () => {
      expect(extract_stated_constant(line)).toBeUndefined();
      expect(rules(line)).not.toEqual([]);
    });
  it('a bare integer of 9 or more digits is not a constant (an id, card or account number shape)', () => {
    expect(is_constant_value('123456789')).toBe(false);
    expect(is_constant_value('86400000')).toBe(true);
  });
});

describe('ports in neutral names are never stated (review: LISTEN_BIND = 8080 reached a draft)', () => {
  for (const line of ['export const LISTEN_BIND = 8080;', 'GRPC_BIND = 9000', 'RELAY = 443', 'UPSTREAM = 5432', 'REDIS = 6379'])
    it(`${line} is not stated`, () => expect(extract_stated_constant(line)).toBeUndefined());
  for (const line of ['MAX_RETRIES = 3', 'SERVER_TIMEOUT_MS = 30000', 'UPLOAD_TTL_HOURS = 24', 'BATCH_SIZE = 500'])
    it(`${line} is still stated`, () => expect(extract_stated_constant(line)).toBeDefined());
});

describe('host:port and environment resource names never reach the report (review: localhost:5432 was echoed)', () => {
  for (const text of ['localhost:5432', 'redis:6379', 'db-primary:5432', 'orders-prod-7', 'acme-prod-data', 'billing-staging', 'prod-eu-cluster'])
    it(`${text} is refused`, () => expect(rules(text)).not.toEqual([]));
  for (const text of ['cache_ttl', 'max_retries', 'production readiness checklist', 'retries: 3'])
    it(`${text} passes`, () => expect(rules(text)).toEqual([]));
});

describe('common size and timeout spellings are stated (review: 10 << 20 went to the judge)', () => {
  for (const [line, literal] of [['const MaxUploadBytes = 10 << 20', '10 << 20'], ['RETRY_BUDGET = 1e6', '1e6'], ['BUF = 0x400', '0x400'], ['static final long MAX = 5L * 1024 * 1024;', '5L * 1024 * 1024'], ['LIMIT = 2 * 1024 ** 2', '2 * 1024 ** 2'], ['UPLOAD_TTL = timedelta(hours=24)', 'timedelta(hours=24)'], ['MAX_BODY = 10 * MB', '10 * MB']] as const)
    it(`${line} states ${literal}`, () => expect(extract_stated_constant(line)?.literal).toBe(literal));
});

describe('a new doc is never filed under a hub doc folder (review: domain came from an incident narrative)', () => {
  it('hub docs citing nearby code do not vote on the domain', () => {
    const docs: DocText[] = [
      { path: 'knowledge-base/incidents/inc.md', text: '---\ntier: incident-narrative\n---\nlogin rollout', sources: ['src/math/pure.py'] },
      { path: 'overview/arch.md', text: '---\ntier: overview\n---\narchitecture', sources: ['src/math/pure.py'] },
    ];
    const located = { code: new Map([['round_digits', [{ file: 'src/math/pure.py', line: 1 }]], ['tax_rate', [{ file: 'src/math/pure.py', line: 2 }]]]), instructions: new Map() };
    const result = resolve_decision({ key: 'q', query: 'how many digits are amounts rounded to', count: 1, facets: ['round_digits', 'tax_rate'] }, located, docs);
    expect(result.kind).toBe('new');
    expect(result.domain).not.toBe('knowledge-base');
    expect(result.domain).not.toBe('overview');
  });
});
