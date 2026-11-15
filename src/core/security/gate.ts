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
const NETWORK_NAME = /\b(?:bind|binds|listen|listener|socket|proxy|upstream|relay|gateway|dns|smtp|imap|redis|postgres|mysql|mongo|server|grpc|https?|collector|exporter|broker|sink|agent|otlp|statsd|syslog|prometheus|telemetry|metrics)\b/i;
const MEASURE_NAME = /\b(?:timeouts?|ttl|interval|delay|size|bytes|max|min|limit|count|retries|retry|attempts|ms|seconds?|minutes?|hours?|days?|batch|pool|workers?|threads?|concurrency|buffer|capacity|depth|length|duration|backoff|window|rate|quota)\b/i;
const WELL_KNOWN_PORTS = new Set([22, 25, 53, 80, 110, 143, 443, 465, 587, 993, 995, 1433, 1521, 2049, 2379, 3000, 3306, 3389, 5000, 5432, 5672, 5900, 6379, 6443, 8000, 8080, 8081, 8443, 8888, 9000, 9090, 9092, 9200, 9300, 11211, 15672, 27017]);
/** A constant a draft may state (#115): a constant value, under a name that is not a value name, and not a port in disguise. */
export function is_stateable_constant(name: string, value: string): boolean {
  if (!is_constant_value(value) || is_value_name(name)) return false;
  if (/^\d+$/.test(value.trim()) && WELL_KNOWN_PORTS.has(Number(value.trim()))) return false; // a port, whatever the name measures
  const words = split_words(name);
  // a bare integer that could be a port (1024..65535) is stated only under a name that says what it measures
  if (/^\d[\d_]*$/.test(value.trim()) && Number(value.trim().replace(/_/g, '')) >= 1024 && Number(value.trim().replace(/_/g, '')) <= 65535) return MEASURE_NAME.test(words);
  return MEASURE_NAME.test(words) || !NETWORK_NAME.test(words);
}

// a key or token written inside a longer name (`backup_s3_AKIA...`, `token_sk-ant-...`): \b never sees it after an underscore or a letter
const KEY_PREFIX = /AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|(?<![A-Za-z])(?:github_pat_|sk_live_|sk_test_|glpat-|xox[abprs]-|AIza)[A-Za-z0-9_-]{12,}|(?<![A-Za-z])(?:gh[pousr]_|sk-|npm_)([A-Za-z0-9_-]{16,})/g;
/** True when `text` holds a key-shaped token: a known key prefix, a hex run, or a long random-looking mixed run. */
export function has_key_token(text: string): boolean {
  for (const match of text.matchAll(KEY_PREFIX)) if (!match[1] || /\d/.test(match[1])) return true;
  for (const run of text.match(/[A-Za-z0-9]{16,}/g) ?? []) {
    const digits = (run.match(/\d/g) ?? []).length;
    const letters = run.length - digits;
    if (/^[0-9a-f]+$/i.test(run) && digits && letters) return true;
    if (digits >= 3 && letters >= 3 && (run.match(/[a-z](?=[A-Z\d])|[A-Z](?=[a-z\d])|\d(?=[A-Za-z])/g) ?? []).length >= 5) return true;
  }
  return false;
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

/**
 * A surface or facet name that holds a value (#117): the gate rules and the secrets scan run on the name as written,
 * with `_` and `-` read as spaces (dashed or underscored digit runs rejoined to a dotted quad), and split at letter,
 * digit and case boundaries, because `sync_to_10.0.0.5` and `High5xxOn10.1.2.3` hide a value from `\b`. Then a key-token check.
 */
export function find_value_in_name(name: string, secrets_config: SecretsConfig = { allow: [], disabled_rules: [] }): GateFinding | undefined {
  const spaced = name.replace(/(?<!\d)(\d{1,3})[_-](\d{1,3})[_-](\d{1,3})[_-](\d{1,3})(?!\d)/g, '$1.$2.$3.$4').replace(/[_-]+/g, ' ');
  const split = spaced.replace(/([a-z])(?=[A-Z\d])|([A-Z])(?=[a-z\d])|(\d)(?=[A-Za-z])/g, (all) => `${all} `);
  for (const form of [name, spaced, split]) {
    const finding = check_security_gate(form, 'name', secrets_config)[0];
    if (finding) return finding;
  }
  return has_key_token(name) ? { rule: 'key-token', file: 'name', line: 1, masked: mask(name.length) } : undefined;
}

/** A source line that holds a value, not a name: a credential, a config or env default, or a value-named variable set to a non-constant. */
export function is_value_line(line: string, secrets_config: SecretsConfig): boolean {
  if (check_credential_text(line, 'line', secrets_config).length || find_value_findings(line, 'line', false).some((finding) => finding.rule === 'config-value')) return true;
  const assigned = /^\s*(?:export\s+)?(?:(?:const|let|var|final|static|readonly|public|private)\s+)*([A-Za-z_]\w*)\s*(?::[^=]+)?[:=]\s*(.+?)\s*;?$/.exec(line);
  return !!assigned && is_value_name(assigned[1]!) && !is_constant_value(assigned[2]!);
}

/** A source line a draft would cite: only credential-class content blocks it (a host or port in code is not copied, a credential is not even cited). */
export function check_credential_text(text: string, where: string, secrets_config: SecretsConfig): GateFinding[] {
  const secrets = scan_text(text, where, secrets_config).filter((finding) => finding.kind === 'secret').map((finding) => ({ rule: finding.rule, file: where, line: finding.line, masked: mask(finding.length) }));
  return [...secrets, ...find_value_findings(text, where, true)];
}

// What a located source line IS (#118): code-shape detection on the line, never topic words. Kind labels are the only thing reported.
// a token, secret, password, signature, hmac, digest or expected value on one side of an equality; not a count or size of them
const SECRET_WORD = '(?:token|secret|password|passwd|signature|hmac|digest|expected)(?!_?(?:count|len|length|size|num|number|index|limit|max|min)\\b)';
const CHECK_KINDS: { kind: string; patterns: RegExp[] }[] = [
  { kind: 'crypto or credential check', patterns: [
    /\b(?:timing_?safe_?equal|compare_digest|constant_time_(?:eq|compare)|createHmac|createHash|createSign|createVerify|createCipher(?:iv)?|createDecipher(?:iv)?|bcrypt|argon2|scrypt|pbkdf2|hashpw|checkpw|ConstantTimeCompare)\b|\bhmac\.(?:Equal|new|New)\b|\bhashlib\.\w+\s*\(|\b(?:sha(?:1|224|256|384|512)|md5|blake2[bs]?)\s*\(|\bverify\s*=\s*False\b|\b(?:rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|CERT_NONE)\b/i,
    /\b(?:jwt|jws|jose|hmac|rsa|ecdsa|signer|verifier)\w*\.(?:sign|verify|encode|decode|digest)\b/i,
    /\b(?:decrypt|encrypt|verify_(?:signature|token|password|hmac)|check_password|validate_(?:token|password|signature))\w*\s*\(/i,
    new RegExp(`\\b\\w*${SECRET_WORD}\\w*\\s*(?:===?|!==?)\\s*\\S|\\S\\s*(?:===?|!==?)\\s*[\\w.]*${SECRET_WORD}\\w*`, 'i'),
    /\b(?:password|passwd|secret|api_?key|digest|signature|hmac)\w*\s*(?:===?|!==?)\s*\S|\S\s*(?:===?|!==?)\s*[\w.]*(?:password|passwd|secret|api_?key|digest|signature)\w*/i,
  ] },
  { kind: 'permission or role check', patterns: [
    /\b(?:has|check|require[sd]?|assert|ensure|can|is|verify)_?(?:permission|role|scope|privilege|access|admin|authori[sz]ed?|superuser|staff)s?\b/i,
    /@(?:requires?_?(?:auth|role|permission|login)\w*|login_required|PreAuthorize|RolesAllowed|Secured)\b/i,
    /\brole\w*\s*(?:===?|!==?|\bin\b)\s*[[\w"']/i,
    /@\w*(?:permission|auth|role|login|admin)\w*\b|@UseGuards\b|^\s*\[\s*(?:Authorize|AllowAnonymous)\b|\bauthori[sz]e!|\b(?:before|skip_before|prepend_before)_(?:action|filter)\s+:\w*(?:auth|permission|role|login|admin)|\b(?:permission|authentication)_classes\b|\bIs(?:Authenticated|AdminUser)\b|\bis_?(?:authenticated|staff|superuser|anonymous)\b|\bauthenticate\w*!?\s*\(|\bDepends\(\s*\w*(?:current_user|auth|permission|role|login|admin|token|security)|\.(?:use|get|post|put|delete|patch|all)\([^)]*\b\w*(?:auth|permission|role|login|admin|guard)\w*\s*[,)(]/i,
    /\b(?:PermissionDenied|Forbidden|Unauthori[sz]ed)\b/,
  ] },
  { kind: 'access policy', patterns: [/"?\bEffect"?\s*[:=]\s*"?(?:Allow|Deny)\b|\bsts:AssumeRole|\bPrincipal"?\s*[:=]|\baws_iam_\w+|\bAssumeRolePolicy|\bpolicy_document\b/] },
  { kind: 'firewall or network rule', patterns: [/\baws_security_group\w*|\bcidr_blocks?\b|\b(?:iptables|nftables|ufw)\b|\b(?:ingress|egress)\s*[{:=]|\bsecurity_group_ids?\b|\bfirewall_rule/i] },
];
/** The kind of security check a source line is (a secret compared, hashed, signed or decrypted; a permission or role check; a policy document; a firewall rule), by code shape; undefined when it is not one. */
export const find_security_check = (line: string): string | undefined => CHECK_KINDS.find(({ patterns }) => patterns.some((pattern) => pattern.test(line)))?.kind;
export const is_security_check_line = (line: string): boolean => find_security_check(line) !== undefined;

const SENSITIVE = /\b(?:auth(?:n|z|s|entic\w*|ori[sz]\w*)?|oauth|saml|sso|jwts?|login|logout|passwords?|passwd|credentials?|tokens?|secrets?|sessions?|cookies?|permissions?|privileges?|privileged|rbac|acl|iam|admins?|bypass(?:es|ed)?|vulnerabilit(?:y|ies)|vulnerable|cve|exploit\w*|firewall|security groups?|network (?:polic\w+|rules?|acl)|ingress|egress|allow ?lists?|csrf|xss|ssrf|cors|tls|ssl|certs?|certificates?|encrypt\w*|decrypt\w*|signing keys?|encryption keys?)\b|(?:^|\/)(?:auth|iam|security|permissions?|login)\//i;

/** Identifiers split into words, so `check_auth_token`, `isAuthorized` and `\bauth\b` read as the words they hold. */
const split_words = (text: string): string => text.replace(/\\[bBdDsSwW]/g, ' ').replace(/\\(.)/g, '$1').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/[_-]+/g, ' ');

/** Auth internals, permission checks and bypasses, vulnerability details, IAM/firewall/network rules: a human writes these. */
export const is_security_sensitive = (text: string): boolean => SENSITIVE.test(split_words(text));
/** The word or path folder that made `text` security-sensitive (for a reason line), lower-cased; undefined when none. */
export const find_sensitive_word = (text: string): string | undefined => SENSITIVE.exec(split_words(text))?.[0].replace(/\//g, '').toLowerCase();
