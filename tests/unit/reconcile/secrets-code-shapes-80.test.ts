import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { scan_text, compute_entropy, is_identifier_shaped } from '../../../src/core/reconcile/secrets';

// Random tokens are built at runtime from a seeded generator so the repo never holds a scannable literal.
const make_draw = (seed: number) => (alphabet: string, n: number) => { let out = ''; for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out += alphabet[(seed >> 8) % alphabet.length]; } return out; };
const draw = make_draw(80);
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', HEX = '0123456789abcdef';
const config = { allow: [], disabled_rules: [] } as Parameters<typeof scan_text>[2];
const rules = (text: string) => scan_text(text, 'doc.md', config).map((finding) => finding.rule);

describe('structured code and markup are not generic-secret (#80)', () => {
  it.each([
    'token_expiry = datetime.utcnow() + timedelta(hours=1)',
    'api_key = settings.qdrant_api_key',
    "self.api_key = vault_kv.read_secret_version",
    "'new-token': 'hsl(var(--new-token))'",
    "'new-token': 'rgba(var(--new-token), 0.5)'",
    "token: calc(var(--token-width) * 2)",
    '- Get token: [codecov.io](https://codecov.io)',
    'token: [the token page](./docs/tokens.md)',
    'sed -i "s/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=$NEW_KEY/" .env',
    'api_key = ${QDRANT_API_KEY}/v1',
    'token: `login rejected offline token: code 401`',
    'token_expiry = datetime.utcnow().isoformat()',
  ])('ignores %s', (text) => expect(rules(text)).not.toContain('generic-secret'));
});

describe('literal and random values in the same shapes are still found (#80)', () => {
  const batches: Array<[string, () => string]> = [
    ['member access, base62', () => `api_key = settings.${draw(BASE62, 24)}`],
    ['member access, hex', () => `api_key = settings.${draw(HEX, 32)}`],
    ['call, random name', () => `token = client.${draw(BASE62, 20)}()`],
    ['call, random argument', () => `token = settings.get_value(${draw(BASE62, 24)})`],
    ['index, random', () => `token = config[${draw(BASE62, 24)}]`],
    ['two random parts', () => `api_key = ${draw(BASE62, 8)}.${draw(BASE62, 24)}`],
    ['css, random', () => `token: hsl(${draw(BASE62, 24)})`],
    ['link, random text', () => `token: [${draw(BASE62, 24)}](https://docs.acme.dev/x)`],
    ['reference beside random', () => `token = "${draw(BASE62, 24)}/$HOME"`],
  ];
  it.each(batches)('%s', (_name, build) => {
    const misses = Array.from({ length: 100 }, () => { let text = build(); while (compute_entropy(text.slice(-20)) < 3.5) text = build(); return text; }).filter((text) => !rules(text).includes('generic-secret')).length;
    expect(misses).toBeLessThanOrEqual(1);
  });
});

describe('is_identifier_shaped (#80)', () => {
  it.each(['utcnow', 'qdrant_api_key', 'hsl', 'kv', 'isoformat', 'QDRANT_API_KEY', 'getApiKey', 'OpenAIKey', 'sha256', 'v1'])('%s', (token) => expect(is_identifier_shaped(token)).toBe(true));
  it.each(['', 'a1b2c3d4e5', 'aB3dE9fG2h', 'x'.repeat(41), '9abc'])('%s is not', (token) => expect(is_identifier_shaped(token)).toBe(false));
  it('passes 99% of the identifier corpus', () => {
    const corpus = readFileSync(join(__dirname, '../../fixtures/identifier-corpus.txt'), 'utf-8').split('\n').filter(Boolean);
    const rejected = corpus.filter((name) => !is_identifier_shaped(name));
    expect(rejected.length / corpus.length, rejected.slice(0, 20).join(' ')).toBeLessThanOrEqual(0.01);
  });
});
