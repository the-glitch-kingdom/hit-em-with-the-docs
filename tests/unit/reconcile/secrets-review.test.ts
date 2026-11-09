import { describe, it, expect } from 'vitest';
import { scan_text, compute_entropy } from '../../../src/core/reconcile/secrets';

// Secret-shaped strings are built at runtime from a seeded generator so the repo never holds a scannable literal.
const make_rng = (seed: number) => (kind: 'alnum' | 'lower') => (n: number) => {
  const chars = kind === 'alnum' ? 'abcdefghijklmnopqrstuvwyzABCDEFGHIJKLMNOPQRSTUVWYZ0123456789' : 'abcdefghijklmnopqrstuvwyz0123456789';
  let out = '';
  for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out += chars[(seed >> 8) % chars.length]; }
  return out;
};
const draw = make_rng(42)('alnum');
// Long draws are redrawn when flat (entropy < 3.6): the rule only sees strong values, and a flat sample is not the attack shape.
const rnd = (n: number) => { let out = draw(n); while (n >= 12 && compute_entropy(out) < 3.6) out = draw(n); return out; };
const rnd_lower = make_rng(43)('lower');
// An all-letter label is word-made by the WORDY test (a documented limit), so the 8-char label has a digit before a letter.
const digit_label = () => { let label = rnd_lower(8); while (!/\d[a-z]/.test(label)) label = rnd_lower(8); return label; };
const cfg = { allow: [], disabled_rules: [] } as Parameters<typeof scan_text>[2];
const rules = (text: string) => scan_text(text, 'doc.md', cfg).map((f) => f.rule);
const misses = (build: () => string, rule: string) => Array.from({ length: 200 }, build).filter((text) => !rules(text).includes(rule)).length;
const between = (low: number, high: number) => low + (rnd(1).charCodeAt(0) % (high - low + 1));

describe('review findings (#74)', () => {
  it('random tokens around member access are still values', () => {
    for (const op of ['.', '(', '[', '?.']) expect(misses(() => `API_KEY = ${rnd(between(2, 7))}${op}${rnd(between(2, 9))}${'/+=-$.'[between(0, 5)]}${rnd(24)}`, 'generic-secret')).toBe(0);
  });
  it.each([
    'const t = req.headers.authorization?.split(" ")[1];', 'token = hashlib.sha256(password.encode()).hexdigest()', 'token = this.token',
    'API_KEY = settings.API_KEY', 'token = request.form.get(', 'secret = self.vault_token_for_service_accounts',
    'code = [code-from-the-authenticator-app]', 'token = ${{ secrets.GITHUB_TOKEN }}', 'password = {{ vault_db_password }}', 'API_KEY = abc123xyz',
  ])('keeps %s exempt', (text) => expect(rules(text)).not.toContain('generic-secret'));

  it('wrapped or prefixed strong values are found', () => {
    expect(misses(() => `API_KEY = [${rnd(28)}]`, 'generic-secret')).toBe(0);
    for (const prefix of ['abc123', '123456', 'qwerty']) expect(misses(() => `API_KEY = ${prefix}${rnd(30)}`, 'generic-secret')).toBe(0);
    expect(misses(() => `postgres://app:[${rnd(14)}]@db`, 'url-password')).toBe(0);
    expect(misses(() => `vault kv put secret/x k=123456${rnd(20)}`, 'vault-kv-value')).toBe(0);
    expect(misses(() => `aws_secret_access_key=123456${rnd(34)}`, 'aws-secret-key')).toBe(0);
    expect(misses(() => `AccountKey=abc123${rnd(40)}`, 'azure-connection-string')).toBe(0);
    const uuid = (head: string) => `${head}${rnd_lower(2).replace(/[g-z]/g, '7')}-9c1d-4e8a-9c1d-5a6b7c8d9e0f`;
    expect(rules(`vault login role id ${uuid('123456')}`)).toContain('approle-id');
  });

  it('random emails stay secrets, human emails stay personal', () => {
    const shapes = [() => `${rnd(10)}@corp.com`, () => `${rnd(9)}@${rnd(9)}.com`, () => `bob1@${digit_label()}.com`, () => `${rnd(11)}@${rnd(11)}.io`];
    // generic-secret needs a strong value (entropy >= 3.5), so a rare flat sample is redrawn.
    const strong = (shape: () => string) => () => { let mail = shape(); while (compute_entropy(mail) < 3.5) mail = shape(); return `API_KEY = ${mail}`; };
    for (const shape of shapes) expect(misses(strong(shape), 'generic-secret')).toBe(0);
    for (const mail of ['j.smith2@corp-01.io', 'ops-team@acme2go.com', 'JaneDoe1987@gmail.com', 'firstname.lastname@company.co.uk', 'no-reply-alerts@mail.example42.com', 'oncall+pager@company.io'])
      expect(rules(`API_KEY = ${mail}`)).not.toContain('generic-secret'); // the email rule itself skips no-reply addresses
  });
});
