import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { scan_text, compute_entropy, is_identifier_shaped, is_word_like } from '../../../src/core/reconcile/secrets';

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

// Review of the #80 branch: random values hidden in link targets, snake/UPPER chains, short lowercase runs and CSS wrappers.
describe('random values inside the #80 exemptions are still found (review)', () => {
  const draw_review = make_draw(8080);
  const LOWER = 'abcdefghijklmnopqrstuvwxyz', UPPER = LOWER.toUpperCase();
  const parts = (alphabet: string, count: number, sep: string) => Array.from({ length: count }, () => draw_review(alphabet, 3 + (draw_review('0123', 1).charCodeAt(0) % 4))).join(sep);
  const camel = () => [draw_review(LOWER, 2), ...Array.from({ length: 3 }, () => { const word = draw_review(LOWER, 6); return word[0]!.toUpperCase() + word.slice(1); })].join('');
  // [shape, build]: build returns the value and, when 3.1.3 already exempted a word-like draw, the part 3.1.3 judged; such
  // draws are not part of the bar (3.1.3 missed them too). Every sample must be reported on 3.1.4.
  const shapes: Array<[string, () => [string, string?]]> = [
    ['link, random query', () => [`[docs](https://x.io/?k=${draw_review(BASE62, 32)})`]],
    ['link, random path', () => [`[docs](https://x.io/${draw_review(BASE62, 32)})`]],
    ['link, random fragment', () => [`[docs](https://x.io/#${draw_review(BASE62, 32)})`]],
    ['link, random relative path', () => [`[docs](./${draw_review(BASE62, 32)})`]],
    ['link, random lowercase target', () => [`[docs](${draw_review(LOWER, 32)})`]],
    ['link, random lowercase text', () => [`[${draw_review(LOWER, 24)}](https://x.io)`]],
    ['snake chain of random parts', () => { const part = parts(LOWER, 4, '_'); return [`api.${part}`, part]; }],
    ['UPPER_SNAKE chain of random parts', () => { const part = parts(UPPER, 4, '_'); return [`cfg.${part}`, part]; }],
    ['one random UPPER run', () => { const part = draw_review(UPPER, 22); return [`cfg.${part}`, part]; }],
    ['16 random lowercase, member', () => { const part = draw_review(LOWER, 16); return [`cfg.${part}`, part]; }],
    ['16 random lowercase, call', () => { const part = draw_review(LOWER, 16); return [`get(${part})`, part]; }],
    ['random camel humps, member', () => { const part = camel(); return [`cfg.${part}`, part]; }],
    ['css var of random lowercase parts', () => { const part = parts(LOWER, 3, '-'); return [`var(--${part})`, part]; }],
    ['css hsl of random lowercase', () => { const part = draw_review(LOWER, 24); return [`hsl(${part})`, part]; }],
    ['three-part snake chain', () => { const part = parts(LOWER, 3, '_'); return [`api.${part}`, part]; }],
    ['three-part UPPER_SNAKE chain', () => { const part = parts(UPPER, 3, '_'); return [`cfg.${part}`, part]; }],
    ['short random callee', () => [`client.${draw_review(LOWER, 4)}${draw_review('0123456789', 2)}${draw_review(LOWER, 4)}(${draw_review(BASE62, 20)})`]],
    ['index chain of 4-char random', () => [`x${Array.from({ length: 5 }, () => `[${draw_review(BASE62, 4)}]`).join('')}`]],
  ];
  it.each(shapes)('%s', (_name, build) => {
    const values: string[] = [];
    while (values.length < 200) { const [value, judged] = build(); if (value.length >= 16 && compute_entropy(value) >= 3.5 && !(judged && is_word_like(judged))) values.push(value); }
    const missed = values.filter((value) => !rules(`API_KEY = ${value}`).includes('generic-secret'));
    expect(missed.length, missed.slice(0, 3).join(' ')).toBeLessThanOrEqual(2);
  });
});
