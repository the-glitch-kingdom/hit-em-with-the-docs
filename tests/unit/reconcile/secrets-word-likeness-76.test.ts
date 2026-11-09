import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { scan_text, is_word_like, compute_entropy } from '../../../src/core/reconcile/secrets';
import { load_plugin_config } from '../../../src/utils/config';
import { triage_docs } from '../../../src/core/reconcile/triage';

// Secret-shaped strings are built at runtime from a seeded generator so the repo never holds a scannable literal.
const make_draw = (seed: number) => (n: number) => { let out = ''; for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out += 'abcdefghijklmnopqrstuvwyzABCDEFGHIJKLMNOPQRSTUVWYZ0123456789'[(seed >> 8) % 62]; } return out; };
const draw = make_draw(76);
const config = { allow: [], disabled_rules: [] } as Parameters<typeof scan_text>[2];
const rules = (text: string) => scan_text(text, 'doc.md', config).map((finding) => finding.rule);

describe('is_word_like (#76)', () => {
  it.each(['openAIApiKey', 'OpenAIKey', 'anthropicAPIKey', 'getAPIKey', 'LLMProviderKey', 'minLengthRequirement12', 'root-token-from-init', 'root-token-v1.15',
    'QATeam', 'DevOps-Oncall2', 'HTTPServer', 'VAULT_TOKEN_FROM_ENVIRONMENT', 'Http2Response', 'x'])('%s is word-like', (token) => expect(is_word_like(token)).toBe(true));
  it.each(['', '1234567890', 'ypap7nhi', 'J0VkswoAbfuDzi', 'bQzK', 'a1b2c3d4'])('%s is not', (token) => expect(is_word_like(token)).toBe(false));
  it('judges consonant runs per hump, never across camel humps', () => {
    expect(is_word_like('minLengthRequirement12')).toBe(true);
    expect(is_word_like('bcdfgh')).toBe(false);
  });
});

describe('real identifiers are not generic-secret (#76)', () => {
  it.each([
    'api_key = settings.openAIApiKey', 'api_key = settings.OpenAIKey', 'apiKey = settings.anthropicAPIKey', 'api_key = settings.getAPIKey("anthropic")',
    'self.anthropic_api_key = manager.getAPIKey(provider)', 'api_key=settings.LLMProviderKey', 'password_policy: minLengthRequirement12',
    'api_key = settings.get_secret("x")', 'token = <root-token-from-init>', 'token = <root-token-v1.15>', 'api_key = settings.x',
  ])('ignores %s', (text) => expect(rules(text)).not.toContain('generic-secret'));

  it('still finds random values in the same positions', () => {
    for (const build of [() => `api_key = settings.${draw(24)}`, () => `token = <${draw(24)}>`, () => `api_key = ${draw(8)}.${draw(24)}`, () => `password_policy: ${draw(22)}`]) {
      const misses = Array.from({ length: 100 }, () => { let text = build(); while (compute_entropy(text.slice(-20)) < 3.5) text = build(); return text; }).filter((text) => !rules(text).includes('generic-secret')).length;
      expect(misses).toBeLessThanOrEqual(1);
    }
  });
});

describe('identifier corpus (#76)', () => {
  // Names harvested from installed type declarations and this repo's own source (tests/fixtures/identifier-corpus.txt, no secrets).
  const corpus = readFileSync(join(__dirname, '../../fixtures/identifier-corpus.txt'), 'utf-8').split('\n').filter(Boolean);
  it('holds about 3000 distinct names', () => {
    expect(corpus.length).toBeGreaterThan(2900);
    expect(new Set(corpus).size).toBe(corpus.length);
  });
  it('at least 99% are word-like', () => {
    const rejected = corpus.filter((name) => !is_word_like(name));
    expect(rejected.length / corpus.length, rejected.slice(0, 20).join(' ')).toBeLessThanOrEqual(0.01);
  });
});

describe('email-only docs never reach the secret lane (#76)', () => {
  const people = 'j.smith2@corp-01.io, QATeam@corp.io, DevOps-Oncall2@corp.io, openAI.Team@corp.io, ops-team@acme2go.com, JaneDoe1987@gmail.com';
  const docs_by_name: Record<string, string> = {
    prose: `Ask ${people} when the nightly job fails twice.`,
    table: `| who | mail |\n|---|---|\n| qa | QATeam@corp.io |\n| ops | DevOps-Oncall2@corp.io |`,
    mailto: `Write to [the team](mailto:QATeam@corp.io) or <DevOps-Oncall2@corp.io>.`,
    angle: `Contact: Jane Doe <JaneDoe1987@gmail.com>, Ops <ops-team@acme2go.com>`,
    fence: '```\nnotify: QATeam@corp.io\ncc: DevOps-Oncall2@corp.io\n```',
    secret_keys: `API_KEY = QATeam@corp.io\nADMIN_PASSWORD = DevOps-Oncall2@corp.io\nSECRET_CONTACT: ops-team@acme2go.com\ntoken = openAI.Team@corp.io`,
    cited_code: 'See `src/mail.ts`, which holds the on-call addresses.',
    cited_doc: 'See [the contacts](./contacts.md).',
  };
  it('no doc made only of emails is in the secret lane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail76-'));
    try {
      const docs = join(dir, '.documentation');
      mkdirSync(join(docs, 'ops'), { recursive: true });
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src/mail.ts'), `export const on_call = ['QATeam@corp.io', 'DevOps-Oncall2@corp.io', 'j.smith2@corp-01.io'];\nconst api_key = 'ops-team@acme2go.com';\n`);
      writeFileSync(join(docs, 'ops/contacts.md'), `---\ntitle: Contacts\npurpose: Lists who to contact when the nightly job fails twice\nsources: [src/mail.ts]\nlast_verified: 2026-01-01\n---\n${people}\n`);
      const rels = ['ops/contacts.md'];
      for (const [name, body] of Object.entries(docs_by_name)) {
        writeFileSync(join(docs, `ops/${name}.md`), `---\ntitle: ${name}\npurpose: Lists who to contact when the nightly job fails twice\nsources: [src/mail.ts]\nlast_verified: 2026-01-01\n---\n${body}\n`);
        rels.push(`ops/${name}.md`);
      }
      writeFileSync(join(docs, 'ops/front.md'), `---\ntitle: front\npurpose: Lists who to contact when the nightly job fails twice\nowner: QATeam@corp.io\napi_key: DevOps-Oncall2@corp.io\nsources: [src/mail.ts]\nlast_verified: 2026-01-01\n---\nBody without addresses.\n`);
      rels.push('ops/front.md');
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: dir });
      const result = await triage_docs({ root: dir, docs_root: docs, rels, config: await load_plugin_config(dir) });
      expect(result.docs.map((doc) => [doc.path, doc.lane]).filter(([, lane]) => lane === 'secret')).toEqual([]);
      expect(result.docs).toHaveLength(rels.length);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('review fix (#76): a bare value is code only when shaped like an identifier', () => {
  let seed = 11;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8;
  const pick = (chars: string) => chars[next() % chars.length]!;
  const syllable = () => pick('bdfgklmnprstvz') + pick('aeiou') + (next() % 2 ? pick('lmnrs') : '');
  const lower = (n: number) => Array.from({ length: n }, () => pick('abcdefghijklmnopqrstuvwxyz')).join('');
  const strong = (build: () => string) => { let value = build(); while (value.length < 16 || compute_entropy(value) < 3.5) value = build(); return value; };
  const misses = (build: () => string) => Array.from({ length: 200 }, () => strong(build)).filter((value) => !scan_text(`api_key = ${value}`, 'x', { allow: [], disabled_rules: [] }).some((finding) => finding.rule === 'generic-secret')).length;
  it.each([
    ['pronounceable syllables plus digits', () => Array.from({ length: 5 }, syllable).join('') + String(next() % 10000)],
    ['capitalized syllable humps with digits between', () => Array.from({ length: 4 }, () => { const word = syllable() + syllable(); return word[0]!.toUpperCase() + word.slice(1) + String(next() % 99); }).join('')],
    ['snake parts with digits', () => Array.from({ length: 4 }, () => syllable() + syllable() + String(next() % 10)).join('_')],
    ['one long lowercase run', () => lower(16 + (next() % 17))],
  ])('%s are values', (_name, build) => expect(misses(build as () => string)).toBe(0));
  it.each(['password_policy: minLengthRequirement12', 'VAULT_TOKEN=VAULT_TOKEN_FROM_ENVIRONMENT', 'api_key = settings.openAIApiKey'])('keeps %s exempt', (line) =>
    expect(scan_text(line, 'x', { allow: [], disabled_rules: [] }).map((finding) => finding.rule)).not.toContain('generic-secret'));
});
