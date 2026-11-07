/**
 * Deterministic secret detector for reconcile (#59). Pure: no I/O except scanFile.
 * A finding never carries the value: only a 4-char mask, the length and a sha256 fingerprint.
 * `findSecrets` also returns raw values for apply; they must stay in process memory
 * (never logged, written, or passed through argv).
 */
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { globToRe } from './references.js';
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
export function isPlaceholder(v: string, weak: boolean): boolean {
  const l = v.toLowerCase();
  if (/^your[_-]|<[^>]*>|\$\{|^\$[a-z_]|x{3,}|\*{3,}|\.{3}|…|example|changeme|change_me|dummy|placeholder|redacted/.test(l)) return true;
  if (new Set(l).size <= 2) return true;
  return weak && /password|passwd|secret|(^|[^a-z])test([^a-z]|$)/.test(l);
}

interface Rule { id: string; re: RegExp; group?: number; weak?: boolean; accept?: (v: string, m: RegExpMatchArray) => boolean }
const jwtOk = (v: string): boolean => {
  try { return typeof JSON.parse(Buffer.from(v.split('.')[0]!, 'base64url').toString()).alg === 'string'; } catch { return false; }
};
const NAME = 'SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SECRET_?ID|ROLE_?ID|CLIENT_?SECRET';
const NAME_RE = new RegExp(`(?:${NAME})`, 'i');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const looksLikePathOrUrl = (v: string) => /^(\/|\.{1,2}\/|~)/.test(v) || /^[a-z][a-z0-9+.-]*:\/\/[^@]*$/i.test(v);

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
  { id: 'vault-token', re: /\bhv[sb]\.[A-Za-z0-9_-]{20,}/g },
  { id: 'vault-token-legacy', re: /(?<![\w.])s\.[A-Za-z0-9]{24}\b/g, accept: (v) => /\d/.test(v) && entropy(v) >= 3.5 },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, accept: jwtOk },
  // Bounded quantifiers keep every rule linear on long single-line files (minified/base64 markdown).
  { id: 'url-password', re: /\b[a-z][a-z0-9+.-]{0,30}:\/\/([^\s:@/]{1,256}):([^\s@/]{1,256})@/gi, group: 2, weak: true, accept: (v, m) => v !== m[1] }, // user:user is a local-dev default
  // Key matched as one bounded token starting at a token boundary, then checked for a secret-ish name in code:
  // the old `[\w.-]*(?:NAME)[\w.-]*` form backtracked quadratically on long lines.
  { id: 'generic-secret', re: /(?<![\w.-])["'`]?([A-Za-z_][\w.-]{0,80})["'`]?[ \t]{0,8}[:=][ \t]{0,8}["'`]?([^\s"'`,;]{1,512})/g, group: 2, weak: true,
    accept: (v, m) => NAME_RE.test(m[1]!) && !looksLikePathOrUrl(v) &&
      // AppRole role/secret ids are uuids, which often fall under the entropy bar: a non-trivial uuid always counts.
      ((UUID.test(v) && new Set(v.replace(/-/g, '')).size > 4) || (v.length >= 16 && entropy(v) >= 3.5)) },
];
// Start only at a token boundary and bound each part (RFC limits), so long runs without '@' stay linear.
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g;

const allowed = (cfg: SecretsConfig, file: string, value: string, fp: string): boolean =>
  cfg.allow.some((a) => {
    if (a.file && a.file !== file && !globToRe(a.file).test(file)) return false;
    // The report and text output show a 12-char prefix; accept any prefix that long, or the full hash.
    if (a.fingerprint && a.fingerprint.length >= 12 && fp.startsWith(a.fingerprint.toLowerCase())) return true;
    if (a.pattern) { try { return new RegExp(a.pattern).test(value); } catch { return false; } }
    return false;
  });

/** Raw detection for apply: values stay in memory, never log or persist `value`. */
export function findSecrets(text: string, file: string, cfg: SecretsConfig): RawSecret[] {
  const out: RawSecret[] = [];
  const spans: Array<[number, number]> = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const locate = (idx: number) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid]! <= idx) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: idx - lineStarts[lo]! + 1 };
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
      const v = m[r.group ?? 0];
      if (!v || (r.accept && !r.accept(v, m)) || isPlaceholder(v, !!r.weak)) continue;
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

export const scanText = (text: string, file: string, cfg: SecretsConfig): SecretFinding[] =>
  findSecrets(text, file, cfg).map((r) => r.finding);

/** Unreadable (missing, binary-ish) files yield no findings. */
export async function scanFile(abs: string, file: string, cfg: SecretsConfig): Promise<SecretFinding[]> {
  try { return scanText(await readFile(abs, 'utf-8'), file, cfg); } catch { return []; }
}

const NO_CFG: SecretsConfig = { allow: [], disabled_rules: [] };

/** Write guard: throws (masked findings only) if `text` holds a secret, so the caller refuses that write. */
export function assertNoSecrets(text: string, where: string, cfg: SecretsConfig = NO_CFG): void {
  const hits = scanText(text, where, cfg).filter((f) => f.kind === 'secret');
  if (!hits.length) return;
  throw new Error(`would write a secret to ${where}: ${hits.slice(0, 5).map((f) => `${f.rule} line ${f.line} ${f.masked}`).join(', ')}${hits.length > 5 ? ` (+${hits.length - 5} more)` : ''}`);
}
