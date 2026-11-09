/**
 * Deterministic secret detector for reconcile (#59). Pure: no I/O except scanFile.
 * A finding never carries the value: only a 4-char mask, the length and a sha256 fingerprint.
 * `findSecrets` also returns raw values for apply; they must stay in process memory
 * (never logged, written, or passed through argv).
 */
import { createHash } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { build_glob_regex } from './references.js';
import type { SecretsConfig } from '../../utils/config.js';

export interface SecretFinding {
  rule: string;
  file: string;
  line: number;
  col: number;
  masked: string;
  length: number;
  fingerprint: string;
  kind: 'secret' | 'personal';
}
export interface RawSecret { finding: SecretFinding; value: string }

export const compute_fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex');
export const format_masked = (value: string): string => `${value.slice(0, 4)}…${value.length}`;

export const compute_entropy = (text: string): number => {
  const character_counts = new Map<string, number>();
  for (const character of text) character_counts.set(character, (character_counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const frequency of character_counts.values()) entropy -= (frequency / text.length) * Math.log2(frequency / text.length);
  return entropy;
};

// Fake keys are made of ascending runs (abc123def456, ABCDEF...1234567890); a random key may hold one short run by
// chance but never mostly runs. Runs of 3+ must cover at least half of the letters and digits.
const has_ascending_run = (text: string): boolean => {
  const alnum = text.replace(/[^a-z0-9]/g, '');
  let run = 1, covered = 0;
  for (let i = 1; i <= alnum.length; i++) {
    if (i < alnum.length && alnum.charCodeAt(i) === alnum.charCodeAt(i - 1) + 1) { run++; continue; }
    if (run >= 3) covered += run;
    run = 1;
  }
  return alnum.length >= 6 && covered * 2 >= alnum.length;
};
const COMMON_PASSWORDS = new Set(['pass', 'password', 'changeme', 'secret', 'admin', 'root', 'postgres', 'user', 'test', 'dev', 'example']);
// A regex pattern, not a credential: regex syntax (a class with a quantifier, \d \w \s, .* .+, ^...$), and what is
// left once that syntax is stripped is not itself a strong value (a comma in {32,64} ends the captured value).
const REGEX_SYNTAX = /\[[^\]]+\](?:[*+?]|\{\d+(?:,\d*)?\}?)?|\\[dwsDWS.]|\.[*+?]|[\^$()|]|\{\d+(?:,\d*)?\}?/g;
const is_regex_pattern = (value: string) => /\[[^\]]+\](?:[*+?]|\{\d)|\\[dwsDWS]|\.[*+]|^\^.*\$$/.test(value) && !is_strong(value.replace(REGEX_SYNTAX, ''));

// Placeholder filter. `weak` words (test, password, secret) only apply to generic/url rules,
// where the value is free text; known-shape keys like sk_test_ are real credentials.
export function is_placeholder(value: string, weak: boolean): boolean {
  const line = value.toLowerCase();
  if (/^your[_-]|<[^>]*>|\$\{|^\$[a-z_]|x{3,}|\*{3,}|\.{3}|…|example|changeme|change_me|dummy|placeholder|redacted/.test(line)) return true;
  if (new Set(line).size <= 2) return true;
  if (has_ascending_run(line)) return true;
  return weak && /password|passwd|secret|(^|[^a-z])test([^a-z]|$)/.test(line);
}

interface Rule { id: string; re: RegExp; group?: number; weak?: boolean; accept?: (value: string, match: RegExpMatchArray) => boolean;
  /** one match yields several values: [value, offset in m[0]] */ expand?: (match: RegExpMatchArray) => Array<[string, number]> }
const is_valid_jwt = (value: string): boolean => {
  try { return typeof JSON.parse(Buffer.from(value.split('.')[0]!, 'base64url').toString()).alg === 'string'; } catch { return false; }
};
const NAME = 'SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SECRET_?ID|ROLE_?ID|CLIENT_?SECRET';
const NAME_RE = new RegExp(`(?:${NAME})`, 'i');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Exemptions apply only to names made of words (snake, kebab, camel, UPPER; digits only as a separate short part),
// never to random characters, so a real credential containing a '.', '(', '{x}', '<' or '@' is still found.
// shortcut: a letters-only random run in clean camel humps would pass; upgrade to a word list if one shows up.
const WORD = '(?:[a-z]+|[A-Z]+|[A-Z]?[a-z]{2,}(?:[A-Z][a-z]{2,})+|[A-Z][a-z]+)';
const WORDY = new RegExp(`^_?${WORD}(?:[_-]{1,2}(?:${WORD}|\\d{1,3}))*\\d{0,2}_?$`);
const is_word_chain = (value: string, sep = '.') => value.length > 0 && value.split(sep).every((segment) => WORDY.test(segment));
const is_strong = (value: string) => (UUID.test(value) && new Set(value.replace(/-/g, '')).size > 4) || (value.length >= 16 && compute_entropy(value) >= 3.5);
// Code, not a credential: a word-made dotted chain (self.x, settings.X), a call of one, or only {name} template slots around weak text.
const is_code = (value: string) => {
  if (is_word_chain(value)) return true;
  const call = /^([A-Za-z_][\w.]*)\(/.exec(value);
  if (call && is_word_chain(call[1]!)) return true;
  const rest = value.replace(/\{([A-Za-z_][\w.]*)\}/g, (whole_match, slot: string) => (is_word_chain(slot) ? '' : whole_match));
  return rest !== value && !is_strong(rest);
};
const is_email = (value: string) => {
  const match = /^([^@\s]{1,64})@([^@\s]{1,255}\.[A-Za-z]{2,})$/.exec(value);
  return !!match && match[1]!.split(/[._+-]/).every((segment) => WORDY.test(segment) || /^\d{1,4}$/.test(segment)) && is_word_chain(match[2]!.replace(/-/g, '.'));
};
/** `<NAME from Vault: ...>`: a word-made name after '<' with a closing '>' later on the same line. */
const build_pointer_record = (value: string, match: RegExpMatchArray) => {
  if (!value.startsWith('<') || !WORDY.test(value.slice(1).replace(/>.*$/, ''))) return false;
  const start_index = match.index! + match[0].lastIndexOf(value), end = match.input!.indexOf('\n', start_index);
  return match.input!.slice(start_index, end < 0 ? undefined : end).includes('>');
};
const is_path_or_url = (value: string) => /^(\/|\.{1,2}\/|~)/.test(value) || /^[a-z][a-z0-9+.-]*:\/\/[^@]*$/i.test(value);

// Order matters: specific shapes first, so the generic rule skips what they already found.
const RULES: Rule[] = [
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    accept: (value) => value.replace(/-----[^-]+-----/g, '').replace(/\s/g, '').length >= 20 }, // header alone in a doc is prose
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'aws-secret-key', re: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi, group: 1 },
  { id: 'azure-connection-string', re: /\b(?:AccountKey|SharedAccessKey)=([A-Za-z0-9+/]{30,}={0,2})/g, group: 1 },
  { id: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { id: 'stripe-webhook-secret', re: /\bwhsec_[A-Za-z0-9]{16,}/g },
  { id: 'github-token', re: /\b(?:gh[pos]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { id: 'slack-token', re: /\bxox[abpors]-[A-Za-z0-9-]{10,}/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { id: 'vault-token', re: /\bhv[sb]\.[A-Za-z0-9_-]{16,}/g, accept: (value) => value.length >= 24 || compute_entropy(value.slice(4)) >= 3.5 },
  { id: 'vault-token-legacy', re: /(?<![\w.])s\.[A-Za-z0-9]{24}\b/g, accept: (value) => /\d/.test(value) && compute_entropy(value) >= 3.5 },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, accept: is_valid_jwt },
  // Bounded quantifiers keep every rule linear on long single-line files (minified/base64 markdown).
  { id: 'url-password', re: /\b[a-z][a-z0-9+.-]{0,30}:\/\/([^\s:@/]{1,256}):([^\s@/]{1,256})@/gi, group: 2, weak: true, accept: (value, match) => value !== match[1] && value.length >= 8 && !COMMON_PASSWORDS.has(value.toLowerCase()) }, // user:user is a local-dev default
  // Key matched as one bounded token starting at a token boundary, then checked for a secret-ish name in code:
  // the old `[\w.-]*(?:NAME)[\w.-]*` form backtracked quadratically on long lines.
  { id: 'generic-secret', re: /(?<![\w.-])["'`]?([A-Za-z_][\w.-]{0,80})["'`]?[ \t]{0,8}[:=][ \t]{0,8}["'`]?([^\s"'`,;]{1,512})/g, group: 2, weak: true,
    // AppRole role/secret ids are uuids, which often fall under the entropy bar: `strong` counts a non-trivial uuid.
    accept: (value, match) => NAME_RE.test(match[1]!) && !is_regex_pattern(value) && !is_path_or_url(value) && !is_code(value) && !is_email(value) && !build_pointer_record(value, match) && is_strong(value) },
  // After generic-secret, so a secret-named key keeps that rule; this one also catches ids under plain keys.
  { id: 'approle-id', re: /(?:--role-id|--secret-id|role_id|secret_id|role id|secret id)(?:[ \t]{0,3}[:=][ \t]{0,3}|[ \t]{1,3})["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi, group: 1,
    accept: (value) => new Set(value.replace(/-/g, '')).size > 4 },
  // `vault kv put path k=v ...` / `vault write path k=v ...`: every long high-entropy value.
  { id: 'vault-kv-value', re: /\bvault[ \t]{1,4}(?:kv[ \t]{1,4}put|write)\b[^\n]{0,1000}/g,
    expand: (match) => [...match[0].matchAll(/(?<![\w-])[\w.-]{1,64}=["']?([^\s"']{16,512})/g)]
      .map((pair): [string, number] => [pair[1]!, pair.index! + pair[0].length - pair[1]!.length])
      .filter(([value]) => compute_entropy(value) >= 3.5 && !value.startsWith('@') && !is_path_or_url(value) && !is_code(value)) },
];
// Start only at a token boundary and bound each part (RFC limits), so long runs without '@' stay linear.
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g;

const is_allowed = (config: SecretsConfig, file: string, value: string, fingerprint: string): boolean =>
  config.allow.some((a) => {
    if (a.file && a.file !== file && !build_glob_regex(a.file).test(file)) return false;
    // The report and text output show a 12-char prefix; accept any prefix that long, or the full hash.
    if (a.fingerprint && a.fingerprint.length >= 12 && fingerprint.startsWith(a.fingerprint.toLowerCase())) return true;
    if (a.pattern) { try { return new RegExp(a.pattern).test(value); } catch { return false; } }
    return false;
  });

/** Raw detection for apply: values stay in memory, never log or persist `value`. */
export function find_secrets(text: string, file: string, config: SecretsConfig): RawSecret[] {
  const found: RawSecret[] = [];
  const spans: Array<[number, number]> = [];
  const line_starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') line_starts.push(i + 1);
  const find_line = (index: number) => {
    let low = 0, high = line_starts.length - 1;
    while (low < high) { const middle = (low + high + 1) >> 1; if (line_starts[middle]! <= index) low = middle; else high = middle - 1; }
    return { line: low + 1, col: index - line_starts[low]! + 1 };
  };
  const add_finding = (rule: string, kind: SecretFinding['kind'], value: string, start: number) => {
    const end = start + value.length;
    if (spans.some(([span_start, span_end]) => start < span_end && end > span_start)) return;
    const fingerprint = compute_fingerprint(value);
    if (is_allowed(config, file, value, fingerprint)) return;
    spans.push([start, end]);
    found.push({ value, finding: { rule, file, ...find_line(start), masked: format_masked(value), length: value.length, fingerprint, kind } });
  };
  for (const rule of RULES) {
    if (config.disabled_rules.includes(rule.id)) continue;
    for (const match of text.matchAll(rule.re)) {
      if (rule.expand) {
        for (const [value, off] of rule.expand(match)) if (!is_placeholder(value, true)) add_finding(rule.id, 'secret', value, match.index! + off);
        continue;
      }
      const value = match[rule.group ?? 0];
      if (!value || (rule.accept && !rule.accept(value, match)) || is_placeholder(value, !!rule.weak)) continue;
      add_finding(rule.id, 'secret', value, match.index! + (rule.group ? match[0].lastIndexOf(value) : 0));
    }
  }
  if (!config.disabled_rules.includes('email')) {
    for (const match of text.matchAll(EMAIL)) {
      if (/@example\.(com|org)$|noreply|no-reply/i.test(match[0])) continue;
      add_finding('email', 'personal', match[0], match.index!);
    }
  }
  return found.sort((a, b) => a.finding.line - b.finding.line || a.finding.col - b.finding.col);
}

export const scan_text = (text: string, file: string, config: SecretsConfig): SecretFinding[] =>
  find_secrets(text, file, config).map((raw_secret) => raw_secret.finding);

/** Unreadable (missing, binary-ish) files yield no findings. */
export async function scan_file(abs_path: string, file: string, config: SecretsConfig): Promise<SecretFinding[]> {
  try { return scan_text(await readFile(abs_path, 'utf-8'), file, config); } catch { return []; }
}

const NO_CONFIG: SecretsConfig = { allow: [], disabled_rules: [] };

/** Write guard: throws (masked findings only) if `text` holds a secret, so the caller refuses that write. */
export function validate_no_secrets(text: string, where: string, config: SecretsConfig = NO_CONFIG): void {
  const matches = scan_text(text, where, config).filter((finding) => finding.kind === 'secret');
  if (!matches.length) return;
  throw new Error(`would write a secret to ${where}: ${matches.slice(0, 5).map((match) => `${match.rule} line ${match.line} ${match.masked}`).join(', ')}${matches.length > 5 ? ` (+${matches.length - 5} more)` : ''}`);
}

// Baseline (#61): committed known false positives. Fingerprints and masked context only, never a value.
export interface BaselineEntry { fingerprint: string; rule: string; file: string; masked: string; reason: string }
export const BASELINE_PATH = '.hewtd/secrets-baseline.json';

export async function load_baseline(repo_root: string): Promise<BaselineEntry[]> {
  try {
    const baseline_json = JSON.parse(await readFile(join(repo_root, BASELINE_PATH), 'utf-8'));
    if (!Array.isArray(baseline_json?.entries)) return [];
    const valid_entries = baseline_json.entries.filter((entry: BaselineEntry) => typeof entry?.fingerprint === 'string' && entry.fingerprint.length >= 12 && typeof entry.reason === 'string' && entry.reason.trim() !== '');
    if (valid_entries.length < baseline_json.entries.length) console.warn(`hewtd: ignoring ${baseline_json.entries.length - valid_entries.length} ${BASELINE_PATH} entr${baseline_json.entries.length - valid_entries.length === 1 ? 'y' : 'ies'} without a fingerprint and a reason`);
    return valid_entries;
  } catch { return []; }
}

export async function write_baseline(repo_root: string, entries: BaselineEntry[]): Promise<void> {
  const text = JSON.stringify({ version: 1, entries }, null, 2) + '\n';
  validate_no_secrets(text, BASELINE_PATH);
  await mkdir(dirname(join(repo_root, BASELINE_PATH)), { recursive: true });
  await writeFile(join(repo_root, BASELINE_PATH), text);
}

/** Baseline entries as allowlist entries. Fingerprint-only: the same value is the same false positive wherever it appears. */
export const build_baseline_allow = (entries: BaselineEntry[]): SecretsConfig['allow'] => entries.map((entry) => ({ fingerprint: entry.fingerprint, reason: entry.reason }));

/** Baseline the findings on one line of `text`. Returns what was added; refuses without a reason or a finding. */
export async function add_baseline(repo_root: string, file: string, text: string, line: number, reason: string, config: SecretsConfig): Promise<BaselineEntry[]> {
  if (!reason.trim()) throw new Error('--reason is required');
  const matches = scan_text(text, file, config).filter((finding) => finding.line === line);
  if (!matches.length) throw new Error(`no finding at ${file}:${line}`);
  const entries = await load_baseline(repo_root);
  const added = matches.filter((match) => !entries.some((entry) => entry.fingerprint === match.fingerprint))
    .map((match) => ({ fingerprint: match.fingerprint, rule: match.rule, file, masked: match.masked, reason: reason.trim() }));
  await write_baseline(repo_root, [...entries, ...added]);
  return added;
}
