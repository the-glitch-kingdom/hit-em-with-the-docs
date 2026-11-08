/**
 * Deterministic secret detector for reconcile (#59). Pure: no I/O except scanFile.
 * A finding never carries the value: only a 4-char mask, the length and a sha256 fingerprint.
 * `findSecrets` also returns raw values for apply; they must stay in process memory
 * (never logged, written, or passed through argv).
 */
import { createHash } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { glob_to_re } from './references.js';
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

export const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex');
export const mask = (value: string): string => `${value.slice(0, 4)}…${value.length}`;

export const entropy = (s: string): number => {
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const c of n.values()) h -= (c / s.length) * Math.log2(c / s.length);
  return h;
};

// Placeholder filter. `weak` words (test, password, secret) only apply to generic/url rules,
// where the value is free text; known-shape keys like sk_test_ are real credentials.
export function is_placeholder(v: string, weak: boolean): boolean {
  const l = v.toLowerCase();
  if (/^your[_-]|<[^>]*>|\$\{|^\$[a-z_]|x{3,}|\*{3,}|\.{3}|…|example|changeme|change_me|dummy|placeholder|redacted/.test(l)) return true;
  if (new Set(l).size <= 2) return true;
  return weak && /password|passwd|secret|(^|[^a-z])test([^a-z]|$)/.test(l);
}

interface Rule { id: string; re: RegExp; group?: number; weak?: boolean; accept?: (v: string, m: RegExpMatchArray) => boolean;
  /** one match yields several values: [value, offset in m[0]] */ expand?: (m: RegExpMatchArray) => Array<[string, number]> }
const jwt_ok = (v: string): boolean => {
  try { return typeof JSON.parse(Buffer.from(v.split('.')[0]!, 'base64url').toString()).alg === 'string'; } catch { return false; }
};
const NAME = 'SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SECRET_?ID|ROLE_?ID|CLIENT_?SECRET';
const NAME_RE = new RegExp(`(?:${NAME})`, 'i');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Exemptions apply only to names made of words (snake, kebab, camel, UPPER; digits only as a separate short part),
// never to random characters, so a real credential containing a '.', '(', '{x}', '<' or '@' is still found.
// shortcut: a letters-only random run in clean camel humps would pass; upgrade to a word list if one shows up.
const WORD = '(?:[a-z]+|[A-Z]+|[A-Z]?[a-z]{2,}(?:[A-Z][a-z]{2,})+|[A-Z][a-z]+)';
const WORDY = new RegExp(`^_?${WORD}(?:[_-]{1,2}(?:${WORD}|\\d{1,3}))*\\d{0,2}_?$`);
const wordy_chain = (v: string, sep = '.') => v.length > 0 && v.split(sep).every((p) => WORDY.test(p));
const strong = (v: string) => (UUID.test(v) && new Set(v.replace(/-/g, '')).size > 4) || (v.length >= 16 && entropy(v) >= 3.5);
// Code, not a credential: a word-made dotted chain (self.x, settings.X), a call of one, or only {name} template slots around weak text.
const looks_like_code = (v: string) => {
  if (wordy_chain(v)) return true;
  const call = /^([A-Za-z_][\w.]*)\(/.exec(v);
  if (call && wordy_chain(call[1]!)) return true;
  const rest = v.replace(/\{([A-Za-z_][\w.]*)\}/g, (all, n: string) => (wordy_chain(n) ? '' : all));
  return rest !== v && !strong(rest);
};
const looks_like_email = (v: string) => {
  const m = /^([^@\s]{1,64})@([^@\s]{1,255}\.[A-Za-z]{2,})$/.exec(v);
  return !!m && m[1]!.split(/[._+-]/).every((p) => WORDY.test(p) || /^\d{1,4}$/.test(p)) && wordy_chain(m[2]!.replace(/-/g, '.'));
};
/** `<NAME from Vault: ...>`: a word-made name after '<' with a closing '>' later on the same line. */
const pointer_record = (v: string, m: RegExpMatchArray) => {
  if (!v.startsWith('<') || !WORDY.test(v.slice(1).replace(/>.*$/, ''))) return false;
  const at = m.index! + m[0].lastIndexOf(v), end = m.input!.indexOf('\n', at);
  return m.input!.slice(at, end < 0 ? undefined : end).includes('>');
};
const looks_like_path_or_url = (v: string) => /^(\/|\.{1,2}\/|~)/.test(v) || /^[a-z][a-z0-9+.-]*:\/\/[^@]*$/i.test(v);

// Order matters: specific shapes first, so the generic rule skips what they already found.
const RULES: Rule[] = [
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    accept: (v) => v.replace(/-----[^-]+-----/g, '').replace(/\s/g, '').length >= 20 }, // header alone in a doc is prose
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
  { id: 'vault-token', re: /\bhv[sb]\.[A-Za-z0-9_-]{16,}/g, accept: (v) => v.length >= 24 || entropy(v.slice(4)) >= 3.5 },
  { id: 'vault-token-legacy', re: /(?<![\w.])s\.[A-Za-z0-9]{24}\b/g, accept: (v) => /\d/.test(v) && entropy(v) >= 3.5 },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, accept: jwt_ok },
  // Bounded quantifiers keep every rule linear on long single-line files (minified/base64 markdown).
  { id: 'url-password', re: /\b[a-z][a-z0-9+.-]{0,30}:\/\/([^\s:@/]{1,256}):([^\s@/]{1,256})@/gi, group: 2, weak: true, accept: (v, m) => v !== m[1] }, // user:user is a local-dev default
  // Key matched as one bounded token starting at a token boundary, then checked for a secret-ish name in code:
  // the old `[\w.-]*(?:NAME)[\w.-]*` form backtracked quadratically on long lines.
  { id: 'generic-secret', re: /(?<![\w.-])["'`]?([A-Za-z_][\w.-]{0,80})["'`]?[ \t]{0,8}[:=][ \t]{0,8}["'`]?([^\s"'`,;]{1,512})/g, group: 2, weak: true,
    // AppRole role/secret ids are uuids, which often fall under the entropy bar: `strong` counts a non-trivial uuid.
    accept: (v, m) => NAME_RE.test(m[1]!) && !looks_like_path_or_url(v) && !looks_like_code(v) && !looks_like_email(v) && !pointer_record(v, m) && strong(v) },
  // After generic-secret, so a secret-named key keeps that rule; this one also catches ids under plain keys.
  { id: 'approle-id', re: /(?:--role-id|--secret-id|role_id|secret_id|role id|secret id)(?:[ \t]{0,3}[:=][ \t]{0,3}|[ \t]{1,3})["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi, group: 1,
    accept: (v) => new Set(v.replace(/-/g, '')).size > 4 },
  // `vault kv put path k=v ...` / `vault write path k=v ...`: every long high-entropy value.
  { id: 'vault-kv-value', re: /\bvault[ \t]{1,4}(?:kv[ \t]{1,4}put|write)\b[^\n]{0,1000}/g,
    expand: (m) => [...m[0].matchAll(/(?<![\w-])[\w.-]{1,64}=["']?([^\s"']{16,512})/g)]
      .map((p): [string, number] => [p[1]!, p.index! + p[0].length - p[1]!.length])
      .filter(([v]) => entropy(v) >= 3.5 && !v.startsWith('@') && !looks_like_path_or_url(v) && !looks_like_code(v)) },
];
// Start only at a token boundary and bound each part (RFC limits), so long runs without '@' stay linear.
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g;

const allowed = (cfg: SecretsConfig, file: string, value: string, fp: string): boolean =>
  cfg.allow.some((a) => {
    if (a.file && a.file !== file && !glob_to_re(a.file).test(file)) return false;
    // The report and text output show a 12-char prefix; accept any prefix that long, or the full hash.
    if (a.fingerprint && a.fingerprint.length >= 12 && fp.startsWith(a.fingerprint.toLowerCase())) return true;
    if (a.pattern) { try { return new RegExp(a.pattern).test(value); } catch { return false; } }
    return false;
  });

/** Raw detection for apply: values stay in memory, never log or persist `value`. */
export function find_secrets(text: string, file: string, cfg: SecretsConfig): RawSecret[] {
  const out: RawSecret[] = [];
  const spans: Array<[number, number]> = [];
  const line_starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') line_starts.push(i + 1);
  const locate = (idx: number) => {
    let lo = 0, hi = line_starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (line_starts[mid]! <= idx) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: idx - line_starts[lo]! + 1 };
  };
  const push = (rule: string, kind: SecretFinding['kind'], value: string, start: number) => {
    const end = start + value.length;
    if (spans.some(([s, e]) => start < e && end > s)) return;
    const fp = fingerprint(value);
    if (allowed(cfg, file, value, fp)) return;
    spans.push([start, end]);
    out.push({ value, finding: { rule, file, ...locate(start), masked: mask(value), length: value.length, fingerprint: fp, kind } });
  };
  for (const r of RULES) {
    if (cfg.disabled_rules.includes(r.id)) continue;
    for (const m of text.matchAll(r.re)) {
      if (r.expand) {
        for (const [v, off] of r.expand(m)) if (!is_placeholder(v, true)) push(r.id, 'secret', v, m.index! + off);
        continue;
      }
      const v = m[r.group ?? 0];
      if (!v || (r.accept && !r.accept(v, m)) || is_placeholder(v, !!r.weak)) continue;
      push(r.id, 'secret', v, m.index! + (r.group ? m[0].lastIndexOf(v) : 0));
    }
  }
  if (!cfg.disabled_rules.includes('email')) {
    for (const m of text.matchAll(EMAIL)) {
      if (/@example\.(com|org)$|noreply|no-reply/i.test(m[0])) continue;
      push('email', 'personal', m[0], m.index!);
    }
  }
  return out.sort((a, b) => a.finding.line - b.finding.line || a.finding.col - b.finding.col);
}

export const scan_text = (text: string, file: string, cfg: SecretsConfig): SecretFinding[] =>
  find_secrets(text, file, cfg).map((r) => r.finding);

/** Unreadable (missing, binary-ish) files yield no findings. */
export async function scan_file(abs: string, file: string, cfg: SecretsConfig): Promise<SecretFinding[]> {
  try { return scan_text(await readFile(abs, 'utf-8'), file, cfg); } catch { return []; }
}

const NO_CFG: SecretsConfig = { allow: [], disabled_rules: [] };

/** Write guard: throws (masked findings only) if `text` holds a secret, so the caller refuses that write. */
export function assert_no_secrets(text: string, where: string, cfg: SecretsConfig = NO_CFG): void {
  const hits = scan_text(text, where, cfg).filter((f) => f.kind === 'secret');
  if (!hits.length) return;
  throw new Error(`would write a secret to ${where}: ${hits.slice(0, 5).map((f) => `${f.rule} line ${f.line} ${f.masked}`).join(', ')}${hits.length > 5 ? ` (+${hits.length - 5} more)` : ''}`);
}

// Baseline (#61): committed known false positives. Fingerprints and masked context only, never a value.
export interface BaselineEntry { fingerprint: string; rule: string; file: string; masked: string; reason: string }
export const BASELINE_PATH = '.hewtd/secrets-baseline.json';

export async function load_baseline(root: string): Promise<BaselineEntry[]> {
  try {
    const j = JSON.parse(await readFile(join(root, BASELINE_PATH), 'utf-8'));
    if (!Array.isArray(j?.entries)) return [];
    const ok = j.entries.filter((e: BaselineEntry) => typeof e?.fingerprint === 'string' && e.fingerprint.length >= 12 && typeof e.reason === 'string' && e.reason.trim() !== '');
    if (ok.length < j.entries.length) console.warn(`hewtd: ignoring ${j.entries.length - ok.length} ${BASELINE_PATH} entr${j.entries.length - ok.length === 1 ? 'y' : 'ies'} without a fingerprint and a reason`);
    return ok;
  } catch { return []; }
}

export async function save_baseline(root: string, entries: BaselineEntry[]): Promise<void> {
  const text = JSON.stringify({ version: 1, entries }, null, 2) + '\n';
  assert_no_secrets(text, BASELINE_PATH);
  await mkdir(dirname(join(root, BASELINE_PATH)), { recursive: true });
  await writeFile(join(root, BASELINE_PATH), text);
}

/** Baseline entries as allowlist entries. Fingerprint-only: the same value is the same false positive wherever it appears. */
export const baseline_allow = (entries: BaselineEntry[]): SecretsConfig['allow'] => entries.map((e) => ({ fingerprint: e.fingerprint, reason: e.reason }));

/** Baseline the findings on one line of `text`. Returns what was added; refuses without a reason or a finding. */
export async function add_baseline(root: string, file: string, text: string, line: number, reason: string, cfg: SecretsConfig): Promise<BaselineEntry[]> {
  if (!reason.trim()) throw new Error('--reason is required');
  const hits = scan_text(text, file, cfg).filter((f) => f.line === line);
  if (!hits.length) throw new Error(`no finding at ${file}:${line}`);
  const entries = await load_baseline(root);
  const added = hits.filter((h) => !entries.some((e) => e.fingerprint === h.fingerprint))
    .map((h) => ({ fingerprint: h.fingerprint, rule: h.rule, file, masked: h.masked, reason: reason.trim() }));
  await save_baseline(root, [...entries, ...added]);
  return added;
}
