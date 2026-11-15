/**
 * The security gate (#113): one check before anything generated from code is written. Shared by
 * `reconcile --gaps` and, later, `hewtd coverage`.
 *
 * Rules: values never (credentials, connection strings, env/config values and defaults, hostnames, IPs, ports,
 * account/tenant/project IDs, key/cert contents). Env and config NAMES are fine. Topics that are security
 * internals (auth, permission checks and bypasses, vulnerability details, IAM, firewall and network rules) are
 * not drafted at all: they are listed for a human. Findings carry file:line and a length, never the value.
 */
import type { SecretsConfig } from '../../utils/config.js';
import { scan_text } from '../reconcile/secrets.js';

export interface GateFinding { rule: string; file: string; line: number; masked: string }

const UNIT = '(?:ms|s|m|h|d|[KMG]i?B|[kmg]b)';
const NUMBER = `(?:0x[0-9a-fA-F]+|\\d[\\d_]*(?:\\.\\d+)?(?:e\\d+)?[lLuUfF]{0,2}(?:${UNIT})?)\\b`;
const UNIT_NAME = '(?:[KMGT]i?B|SECONDS?|MINUTES?|HOURS?|DAYS?|MS)\\b';
const TERM = `(?:${NUMBER}|${UNIT_NAME}|(?:time\\.)?(?:Nano|Micro|Milli)?(?:second|Second|Minute|Hour)s?\\b|Duration\\.of(?:Millis|Seconds|Minutes|Hours|Days)\\(\\s*${NUMBER}\\s*\\)|timedelta\\(\\s*(?:days|hours|minutes|seconds|milliseconds)\\s*=\\s*${NUMBER}\\s*\\))`;
const OPERATOR = '(?:<<|\\*\\*|[*+\\-/])';
const CONSTANT_VALUE = new RegExp(`^\\(*\\s*${TERM}(?:\\s*${OPERATOR}\\s*\\(*\\s*${TERM}\\s*\\)*)*\\s*\\)*$`);
/** A number, arithmetic of numbers, or a duration or size literal: a code constant (#115), never a host, port, id or default. A bare run of 9+ digits is an id, card or account number shape, not a constant. */
export const is_constant_value = (value: string): boolean => CONSTANT_VALUE.test(value.trim()) && !/^\d{9,}$/.test(value.trim().replace(/_/g, ''));
const VALUE_NAME = /\b(?:ports?|hosts?|hostnames?|ips?|addr|address|ids?|urls?|uris?|endpoints?|domains?|accounts?|tenants?|keys?|secrets?|tokens?|passwords?|passwd|pass|passes|passcodes?|pwd|pins?|seeds?|ssn|cards?|cvv|cvc|iban|routing|otp|totp|hotp|mfa|nonces?|private|priv|credentials?|creds?|auth|cookies?|sessions?|signatures?|sig|hmac|licen[cs]es?|serials?|phones?|dob|certs?|salts?)\b/i;
/** A name that holds a host, port, id, url or credential: what it is set to is a value, not a constant to state. */
export const is_value_name = (name: string): boolean => VALUE_NAME.test(split_words(name));
// a network name (BIND, RELAY, UPSTREAM) or a well-known port number holds a port unless the name says what it measures
const NETWORK_NAME = /\b(?:bind|binds|listen|listener|socket|proxy|upstream|relay|gateway|dns|smtp|imap|redis|postgres|mysql|mongo|server|grpc|https?)\b/i;
const MEASURE_NAME = /\b(?:timeouts?|ttl|interval|delay|size|bytes|max|min|limit|count|retries|retry|attempts|ms|seconds?|minutes?|hours?|days?|batch|pool|workers?|threads?|concurrency|buffer|capacity|depth|length|duration|backoff|window|rate|quota)\b/i;
const WELL_KNOWN_PORTS = new Set([22, 25, 53, 80, 110, 143, 443, 465, 587, 993, 995, 1433, 1521, 2049, 2379, 3000, 3306, 3389, 5000, 5432, 5672, 5900, 6379, 6443, 8000, 8080, 8081, 8443, 8888, 9000, 9090, 9092, 9200, 9300, 11211, 15672, 27017]);
/** A constant a draft may state (#115): a constant value, under a name that is not a value name, and not a port in disguise. */
export function is_stateable_constant(name: string, value: string): boolean {
  if (!is_constant_value(value) || is_value_name(name)) return false;
  const words = split_words(name);
  if (MEASURE_NAME.test(words)) return true;
  return !NETWORK_NAME.test(words) && !(/^\d+$/.test(value.trim()) && WELL_KNOWN_PORTS.has(Number(value.trim())));
}

interface ValueRule { rule: string; pattern: RegExp; credential?: boolean; /** Drop a match that is not a value (a code constant). */ keep?: (match: RegExpMatchArray) => boolean }
// NAME = <rest of line>: a constant (number, arithmetic, duration or size) is a fact a doc may state, unless the name says host, port, id, url or credential
const keep_config_value = (match: RegExpMatchArray): boolean => {
  const [, name, value] = match;
  if (!name) return true;
  return !is_stateable_constant(name, value!.replace(/\s*(?:\/\/|#).*$/, '').replace(/[;,]\s*$/, ''));
};
const VALUE_RULES: ValueRule[] = [
  { rule: 'key-material', pattern: /-----BEGIN [A-Z ]+-----|[A-Za-z0-9+/]{80,}={0,2}/g, credential: true },
  { rule: 'connection-string', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>]+/gi, credential: true },
  { rule: 'ip-address', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b|\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi },
  { rule: 'hostname', pattern: /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|internal|local|cloud|aws|app|co|us|eu|gov|mil|edu|ai|xyz|corp|lan|svc)\b/gi },
  { rule: 'port', pattern: /\bports?\b\W{0,4}\d{2,5}\b/gi },
  { rule: 'host-port', pattern: /\b[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*:\d{2,5}\b/gi },
  { rule: 'environment-resource', pattern: /\b(?:[a-z0-9]+-)+(?:prod|production|staging|stage|stg|uat|preprod)(?:-[a-z0-9]+)*\b|\b(?:prod|production|staging|stg|uat|preprod)(?:-[a-z0-9]+)+\b/gi },
  { rule: 'account-id', pattern: /\b(?:account|tenant|project|subscription|org(?:anization)?)[ _-]?id\b\W{0,8}(?:is\s+)?[\w-]{6,}|\b\d{12}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\barn:aws[\w-]*:\S+/gi },
  { rule: 'config-value', pattern: /\b([A-Z][A-Z0-9_]{2,})\s*[=:]\s*(\S[^\n]*)|process\.env\.\w+\s*(?:\?\?|\|\|)\s*\S+|os\.environ\.get\([^,)\n]+,\s*[^)\n]+\)|getenv\([^,)\n]+,\s*[^)\n]+\)|\$\{\w+:-[^}\n]*\}|\bdefaults?\s+(?:to|is|of|value)\b\s*\S+|\bdefault\s*[:=]\s*\S+/g, keep: keep_config_value },
];

const mask = (length: number): string => `[${length} chars]`;
const find_line = (text: string, index: number): number => text.slice(0, index).split('\n').length;

function find_value_findings(text: string, where: string, credential_only: boolean): GateFinding[] {
  const found: GateFinding[] = [];
  for (const { rule, pattern, credential, keep } of VALUE_RULES) {
    if (credential_only && !credential) continue;
    for (const match of text.matchAll(pattern)) if (!keep || keep(match)) found.push({ rule, file: where, line: find_line(text, match.index!), masked: mask(match[0].length) });
  }
  return found;
}

/** Everything the gate refuses in text that is about to be written: the secrets scan plus every value rule. */
export function check_security_gate(text: string, where: string, secrets_config: SecretsConfig): GateFinding[] {
  const secrets = scan_text(text, where, secrets_config).filter((finding) => finding.kind === 'secret').map((finding) => ({ rule: finding.rule, file: where, line: finding.line, masked: mask(finding.length) }));
  return [...secrets, ...find_value_findings(text, where, false)].sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** A source line a draft would cite: only credential-class content blocks it (a host or port in code is not copied, a credential is not even cited). */
export function check_credential_text(text: string, where: string, secrets_config: SecretsConfig): GateFinding[] {
  const secrets = scan_text(text, where, secrets_config).filter((finding) => finding.kind === 'secret').map((finding) => ({ rule: finding.rule, file: where, line: finding.line, masked: mask(finding.length) }));
  return [...secrets, ...find_value_findings(text, where, true)];
}

const SENSITIVE = /\b(?:auth(?:n|z|s|entic\w*|ori[sz]\w*)?|oauth|saml|sso|jwts?|login|logout|passwords?|passwd|credentials?|tokens?|secrets?|sessions?|cookies?|permissions?|privileges?|privileged|rbac|acl|iam|admins?|bypass(?:es|ed)?|vulnerabilit(?:y|ies)|vulnerable|cve|exploit\w*|firewall|security groups?|network (?:polic\w+|rules?|acl)|ingress|egress|allow ?lists?|csrf|xss|ssrf|cors|tls|ssl|certs?|certificates?|encrypt\w*|decrypt\w*|signing keys?|encryption keys?)\b|(?:^|\/)(?:auth|iam|security|permissions?|login)\//i;

/** Identifiers split into words, so `check_auth_token`, `isAuthorized` and `\bauth\b` read as the words they hold. */
const split_words = (text: string): string => text.replace(/\\[bBdDsSwW]/g, ' ').replace(/\\(.)/g, '$1').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/[_-]+/g, ' ');

/** Auth internals, permission checks and bypasses, vulnerability details, IAM/firewall/network rules: a human writes these. */
export const is_security_sensitive = (text: string): boolean => SENSITIVE.test(split_words(text));
/** The word or path folder that made `text` security-sensitive (for a reason line), lower-cased; undefined when none. */
export const find_sensitive_word = (text: string): string | undefined => SENSITIVE.exec(split_words(text))?.[0].replace(/\//g, '').toLowerCase();
