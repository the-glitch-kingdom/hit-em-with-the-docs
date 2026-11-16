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
const NUMBER = `(?:0x[0-9a-fA-F]{1,6}|\\d[\\d_]*(?:\\.\\d+)?(?:e\\d+)?[lLuUfF]{0,2}(?:${UNIT})?)\\b`;
const UNIT_NAME = '(?:[KMGT]i?B|SECONDS?|MINUTES?|HOURS?|DAYS?|MS)\\b';
const TERM = `(?:${NUMBER}|${UNIT_NAME}|(?:time\\.)?(?:Nano|Micro|Milli)?(?:second|Second|Minute|Hour)s?\\b|Duration\\.of(?:Millis|Seconds|Minutes|Hours|Days)\\(\\s*${NUMBER}\\s*\\)|timedelta\\(\\s*(?:days|hours|minutes|seconds|milliseconds)\\s*=\\s*${NUMBER}\\s*\\))`;
const OPERATOR = '(?:<<|\\*\\*|[*+\\-/])';
const CONSTANT_VALUE = new RegExp(`^\\(*\\s*${TERM}(?:\\s*${OPERATOR}\\s*\\(*\\s*${TERM}\\s*\\)*)*\\s*\\)*$`);
/** A number, arithmetic of numbers, or a duration or size literal: a code constant (#115), never a host, port, id or default. A bare run of 9+ digits is an id, card or account number shape, a hex literal over 6 digits is a key, hash or hex IP; the key-token and value rules run on every value. */
export const is_constant_value = (value: string): boolean => CONSTANT_VALUE.test(value.trim()) && !/^\d{9,}$/.test(value.trim().replace(/_/g, '')) && !has_key_token(value) && !find_value_findings(value, 'value', false).length;
const VALUE_NAME = /\b(?:ports?|hosts?|hostnames?|ips?|addr|address|ids?|urls?|uris?|endpoints?|domains?|accounts?|tenants?|keys?|secrets?|tokens?|passwords?|passwd|pass|passes|passcodes?|pwd|pw|passphrases?|apikeys?|pins?|seeds?|ssn|cards?|cvv|cvc|iban|routing|otp|totp|hotp|mfa|(?:access|invite|unlock|verification|door|admin|reset|recovery) codes?|nonces?|private|priv|credentials?|creds?|auth|cookies?|sessions?|signatures?|sig|hmac|licen[cs]es?|serials?|phones?|dob|certs?|salts?)\b/i;
/** A name that holds a host, port, id, url or credential: what it is set to is a value, not a constant to state. */
export const is_value_name = (name: string): boolean => VALUE_NAME.test(split_words(name));
// a network name (BIND, RELAY, UPSTREAM) or a well-known port number holds a port unless the name says what it measures
const NETWORK_NAME = /\b(?:bind|binds|listen|listener|socket|proxy|upstream|relay|gateway|dns|smtp|imap|redis|postgres|mysql|mongo|server|grpc|https?|collector|exporter|broker|sink|agent|otlp|statsd|syslog|prometheus|telemetry|metrics)\b/i;
const MEASURE_NAME = /\b(?:timeouts?|ttl|interval|delay|size|bytes|max|min|limit|count|retries|retry|attempts|ms|seconds?|minutes?|hours?|days?|batch|pool|workers?|threads?|concurrency|buffer|capacity|depth|length|duration|backoff|window|rate|quota|status|digits|decimals|places|precision|ratio|factor|cap|threshold|percent|percentage|priority|weight|score|version)\b/i;
// `code` measures only as a status, response, exit, error, return or reason code; any other code (access, invite, door) is a secret
const MEASURED_CODE = /\b(?:status|response|http|exit|error|return|reason) codes?\b/i;
// a bare integer in the dynamic port range under a name that points at a service is a port, whatever else the name says
const SERVICE_NAME = /\b(?:db|database|redis|cache|queue|host|server)\b/i;
// a unit-bearing measure (timeout, ttl, size, bytes) is not a port even under a service name
const UNIT_MEASURE = /\b(?:timeouts?|ttl|interval|delay|ms|seconds?|minutes?|hours?|days?|bytes|size|duration|backoff|window|retries|retry|attempts)\b/i;
const WELL_KNOWN_PORTS = new Set([21, 22, 23, 25, 53, 67, 69, 80, 88, 110, 111, 123, 135, 139, 143, 161, 389, 443, 445, 465, 514, 587, 636, 873, 993, 995, 1433, 1521, 2049, 2379, 3000, 3306, 3389, 5000, 5432, 5672, 5900, 6379, 6443, 8000, 8080, 8081, 8443, 8888, 9000, 9090, 9092, 9200, 9300, 11211, 15672, 27017]);
// #120: a number under a name that points at a person, an account or an OS identity is an id (ADMIN_UID = 90210), singular whole tokens only; USER_LIMIT is refused, MAX_USERS (plural) may be stated
const PERSON_NAME = /\b(?:uid|pid|gid|user|owner|customer|admin|email|name|root|support|billing)\b/i;
/** A constant a draft may state (#115): a constant value, under a name that is not a value name, and not a port in disguise. */
export function is_stateable_constant(name: string, value: string): boolean {
  if (!is_constant_value(value) || is_value_name(name) || PERSON_NAME.test(split_words(name))) return false;
  const text = value.trim().replace(/(?<=\d)_(?=\d)/g, '');
  const operands = (text.match(/(?<![\d.])\d+(?![\d.])/g) ?? []).map(Number);
  // simple integer arithmetic is evaluated (digits, operators and parentheses only, so the expression cannot run code)
  const result = /^[\d\s+\-*/()<]+$/.test(text) && !/^\d+$/.test(text) ? Number(new Function(`return (${text})`)()) : undefined;
  if ([...operands, result].some((number) => number !== undefined && WELL_KNOWN_PORTS.has(number))) return false; // a port, whatever the name measures
  const words = split_words(name);
  // a bare integer that could be a port (1..65535) is stated only under a name that says what it measures
  const bare = /^\d+$/.test(text) ? Number(text) : result;
  const measures = MEASURE_NAME.test(words) || MEASURED_CODE.test(words);
  if (/^\d+$/.test(text) && bare! >= 1024 && bare! <= 65535 && SERVICE_NAME.test(words) && !UNIT_MEASURE.test(words)) return false;
  if (bare !== undefined && bare >= 1 && bare <= 65535) return measures;
  return measures || !NETWORK_NAME.test(words);
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
  { rule: 'ip-address', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b|\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b|(?<![A-Za-z0-9:])(?:[0-9a-f]{1,4}:){0,7}[0-9a-f]{0,4}::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?![A-Za-z0-9:])/gi, keep: (match) => /\d/.test(match[0]) },
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
export function find_value_in_name(name: string, secrets_config: SecretsConfig = { allow: [], disabled_rules: [] }, ignore_rules: string[] = []): GateFinding | undefined {
  // repeated separators collapse, and digit groups lose their leading zeros, so `010_000__005` reads as `10.0.5`
  const collapsed = name.replace(/([_-])[_-]+/g, '$1');
  const spaced = collapsed.replace(/(?<!\d)(\d{1,3})[._-](\d{1,3})[._-](\d{1,3})[._-](\d{1,3})(?!\d)/g, (_all, ...octets: string[]) => octets.slice(0, 4).map(Number).join('.')).replace(/[_-]+/g, ' ');
  const split = spaced.replace(/([a-z])(?=[A-Z\d])|([A-Z])(?=[a-z\d])|(\d)(?=[A-Za-z])/g, (all) => `${all} `);
  // `_` read as `-` too, so `notify_db_prod_01` is the environment resource `notify-db-prod-01`
  for (const form of [name, collapsed, spaced, split, name.replace(/_/g, '-')]) {
    const finding = check_security_gate(form, 'name', secrets_config).find((found) => !ignore_rules.includes(found.rule));
    if (finding) return finding;
  }
  // a run of 8+ digits (a decimal IP, an id) or 8 hex digits (a hex IP) in a name is an id
  if (/\d{8,}/.test(name) || name.split(/[^A-Za-z0-9]+/).some((token) => /^[0-9a-f]{8}$/i.test(token) && /\d/.test(token))) return { rule: 'id-run', file: 'name', line: 1, masked: mask(name.length) };
  return has_key_token(name) ? { rule: 'key-token', file: 'name', line: 1, masked: mask(name.length) } : undefined;
}

/** A source line that holds a value, not a name: a credential, a config or env default, or a value-named variable set to a non-constant. */
export function is_value_line(line: string, secrets_config: SecretsConfig): boolean {
  if (check_credential_text(line, 'line', secrets_config).length || find_value_findings(line, 'line', false).some((finding) => finding.rule === 'config-value')) return true;
  const assigned = /^\s*(?:export\s+)?(?:(?:const|let|var|final|static|readonly|public|private)\s+)*([A-Za-z_]\w*)\s*(?::[^=]+)?[:=]\s*(.+?)\s*;?$/.exec(line);
  return !!assigned && is_value_name(assigned[1]!) && !is_constant_value(assigned[2]!);
}

// a literal that is a name, not a value: an import path, an env var name, a route path or a flag
const NAME_LITERAL_PREFIX = /(?:\b(?:import|from|require|getenv|environ(?:\.get)?|ENV(?:\.fetch)?|process\.env)\s*[[(]?\s*|\bimport\s+[\w*{}, ]+\s+from\s*)$/;
// #120: main's rule is the base. Inside a literal a matched facet is a value unless it starts with `--` (a long flag) or `/` (a route or path). Only four additions are names:
// a one-letter flag, a file name, a command phrase with a long flag, and a name a surface detector found on the same line. Every name must also pass find_value_in_name and has_key_token.
const FILE_EXTENSION = /\.(?:json|ya?ml|toml|md|txt|csv|sql|py|tsx?|jsx?|rb|go|java|kt|cs|rs|php|sh|html|css|xml|ini|cfg|lock|env\.example)$/i;
// a file name is shown only under a project folder (#120): a bare name.ext or any other folder (data/, customers/) can name a person or a customer
const FILE_DIRS = new Set(['fixtures', 'fixture', '__fixtures__', 'tests', 'test', '__tests__', 'spec', 'specs', 'docs', 'doc', 'config', 'configs', 'scripts', 'src', 'lib', 'examples', 'templates', 'migrations', 'schemas', 'public', 'assets', '.github']);
// the only values an option may carry and stay a name (#120): an allowlist, anything else after a flag is a value
const HARMLESS_OPTION_VALUE = new Set(['dev', 'optional', 'peer', 'true', 'false', 'none', 'all', 'json', 'text', 'yaml', 'patch', 'minor', 'major', 'latest', 'debug', 'info', 'warn', 'error', 'silent', 'verbose']);
const LONG_FLAG = /^--([a-z][a-z0-9-]*)(?:=([a-z]+(?:-[a-z]+)*))?$/;
const BARE_FLAG = /^--([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
const SHORT_FLAG = /^-[A-Za-z]$/;
// a command phrase is a name only when its first word is a known tool (#120): a positional word after any other command can be a password or a person
const subcommands = (words: string): Set<string> => new Set(words.split(' '));
const BUILD_WORDS = 'build test clean install check run lint fmt format all deploy';
// a known tool and the subcommand words it may be followed by, as a name (#120); any other word in a command phrase makes the whole phrase a value
const KNOWN_TOOLS = new Map<string, Set<string>>([
  ['npm', subcommands('install ci audit fix run test publish pack ls outdated update prune dedupe init version exec cache clean rebuild build login adduser owner user role set add')],
  ['npx', subcommands('')], ['yarn', subcommands('install add remove run test build upgrade audit cache init publish')], ['pnpm', subcommands('install add remove run test build update audit publish init')],
  ['pip', subcommands('install uninstall list freeze show check download')], ['pipx', subcommands('install uninstall list run upgrade')], ['poetry', subcommands('install add remove run build publish update lock check')], ['uv', subcommands('sync run add remove lock pip venv build publish')],
  ['git', subcommands('push pull fetch commit add rm mv checkout switch branch merge rebase reset status log diff tag stash clone init remote show restore cherry-pick')],
  ['docker', subcommands('build run compose up down ps exec pull push logs images rm rmi start stop restart network volume')],
  ['kubectl', subcommands('get apply delete describe logs exec rollout scale create edit patch port-forward top config set pods deployments services nodes')],
  ['helm', subcommands('install upgrade uninstall list template lint package repo search status rollback')], ['terraform', subcommands('init plan apply destroy fmt validate output state workspace')],
  ['make', subcommands(BUILD_WORDS)], ['cargo', subcommands('build run test check clippy fmt doc clean publish update')], ['go', subcommands('build run test vet fmt mod get install generate')],
  ['node', subcommands('')], ['deno', subcommands('run test fmt lint check task')], ['bun', subcommands('install add remove run test build')],
  ['python', subcommands('')], ['python3', subcommands('')], ['ruby', subcommands('')], ['bundle', subcommands('install exec update add')], ['rake', subcommands(BUILD_WORDS)], ['rails', subcommands('server console generate new routes test')], ['gem', subcommands('install uninstall list build push')],
  ['mvn', subcommands(BUILD_WORDS + ' package verify compile')], ['gradle', subcommands(BUILD_WORDS + ' assemble')], ['dotnet', subcommands('build run test restore publish new add pack clean')],
  ['hewtd', subcommands('reconcile coverage status init policy update relink domain archive')], ['gh', subcommands('pr issue repo run workflow list view create merge checkout status release')],
]);
// a flag that takes or names a person or an account, whatever the value looks like; any word of the flag counts (`--customer-acme`)
const PERSON_FLAG_WORD = /\b(?:users?|usernames?|logins?|as|customers?|owners?|emails?|names?|admins?|authors?|assignees?|reviewers?|principals?|identity|impersonate|members?|clients?|orgs?|uid|gid|root|support|billing)\b/i;
const is_person_flag = (flag: string): boolean => PERSON_FLAG_WORD.test(split_words(flag));
const AUTH_KEY = /\b(?:bearer|authori[sz]ation|basic)\b/i;
const is_key_like_segment = (segment: string): boolean => has_key_token(segment) || (/[a-z]/.test(segment) && /[A-Z]/.test(segment) && /\d/.test(segment));
const is_plain = (text: string): boolean => !find_value_in_name(text) && !has_key_token(text);
/** The shapes that are names inside a literal; any other shape is a value (#120). `surface_names` are the names a surface detector found on the same line (already screened). */
const is_name_shaped = (content: string, surface_names: string[] = []): boolean => {
  if (!is_plain(content)) return false;
  const flag = LONG_FLAG.exec(content);
  if (flag) return !is_value_name(flag[1]!) && !is_person_flag(flag[1]!) && (flag[2] === undefined || HARMLESS_OPTION_VALUE.has(flag[2])); // a long flag, bare or with a harmless value
  if (content.startsWith('/')) return true; // a route or an absolute path, as on main
  if (SHORT_FLAG.test(content)) return true; // `-v`, never with attached characters (`-psecret`)
  if (surface_names.includes(content)) return true; // a scheduled-job key, route, flag, queue or task name, alert name or CI job
  // a file name or path with a known extension, every segment plain
  if (FILE_EXTENSION.test(content) && /^[\w./-]+$/.test(content)) return FILE_DIRS.has(content.split('/')[0]!) && content.includes('/') && content.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && is_plain(segment) && !is_key_like_segment(segment)); // `..`, `.` or `//` could leave the folder
  // a command phrase (#120, allowlist): a known tool, then only bare --long-flags, --flag=<harmless value>, and that tool's subcommand words; anything else makes it a value
  const tokens = content.split(/\s+/);
  const subs = KNOWN_TOOLS.get(tokens[0]!);
  if (tokens.length < 2 || !subs || !tokens.some((token) => /^--[a-z]/.test(token)) || AUTH_KEY.test(content)) return false;
  return tokens.slice(1).every((token) => {
    const long = LONG_FLAG.exec(token);
    if (long) return !is_value_name(long[1]!) && !is_person_flag(long[1]!) && (long[2] === undefined ? BARE_FLAG.test(token) : HARMLESS_OPTION_VALUE.has(long[2]));
    return subs.has(token) && !is_value_name(token);
  });
};
const KEY_BEFORE = /([\w-]+)["'`]?\s*(?:=>|[:=,(])\s*$/;
const HEAD_KEY = /^\s*(?:(?:export|const|let|var|final|static|readonly|public|private)\s+)*([\w.$-]+)["'`]?\s*(?::[^=]+)?(?:=>|[:=])/;
// a literal set under a value name (`"password": ".."`, `PASSWORDS = [".."]`, `Authorization: ..`) is a value whatever its shape
const is_value_key = (key: string | undefined): boolean => !!key && (is_value_name(key) || AUTH_KEY.test(split_words(key)));
const is_value_literal = (before: string, content: string, surface_names: string[]): boolean => !is_name_shaped(content, surface_names) || has_key_token(content) || !!find_value_in_name(content) || is_value_key(KEY_BEFORE.exec(before)?.[1]) || is_value_key(HEAD_KEY.exec(before)?.[1]);
/** Where the comment of a line starts (0 for a comment line), outside any quote; -1 when it has none. */
function find_comment_start(line: string): number {
  if (/^\s*(?:\/\/|#|\*|\/\*|--)/.test(line)) return 0;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote) { if (char === '\\') i++; else if (char === quote) quote = ''; } else if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '/' && line[i + 1] === '/' && line[i - 1] !== ':' || char === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return i;
  }
  return -1;
}
/**
 * The option arguments of a shell line. `refined` (#120) keeps a word from HARMLESS_OPTION_VALUE after a long flag a name (`--omit=dev`, `--omit dev`); any other argument is a value; unrefined is the 3.7.0 set, every argument, kept so a facet wholly inside one stays withheld. `-pX` is always a value.
 */
export function find_option_spans(line: string, refined: boolean): [number, number][] {
  const spans: [number, number][] = [];
  const is_value_argument = (flag: string, written: string): boolean => {
    const value = written.replace(/[)\]}"'`,;]+$/, ''); // closing punctuation of the call is not part of the value
    return !refined || is_value_name(flag) || is_person_flag(flag) || !HARMLESS_OPTION_VALUE.has(value);
  };
  for (const token of line.matchAll(/\S+/g)) {
    const [text, at] = [token[0], token.index!];
    const short = /^-[A-Za-z]\S/.test(text) ? 2 : 0;
    const long = /^--([\w-]+)=/.exec(text);
    if (short) spans.push([at + short, at + text.length]);
    else if (long) { if (is_value_argument(long[1]!, text.slice(long[0].length))) spans.push([at + long[0].length, at + text.length]); }
    else if (/^--?[A-Za-z][\w-]*$/.test(text)) {
      const next = /^\s+(?!-)(\S+)/.exec(line.slice(at + text.length));
      if (next && (text.startsWith('--') ? is_value_argument(text.slice(2), next[1]!) : true)) spans.push([at + text.length + next[0].length - next[1]!.length, at + text.length + next[0].length]);
    }
  }
  return spans;
}
/**
 * Where a source line holds values by CONTEXT, not by shape (#118): the spans inside a string literal ('..', "..", `..`),
 * inside an option argument of a shell line (`-p<x>`, `--password=x`, `--token x`) and inside URL or DSN userinfo
 * (`user:pw@host`). A literal that is an import path, an env var name, a route path, a long flag or a name a surface detector found on the line (`surface_names`) is a name, not a value.
 */
export function find_value_spans(line: string, surface_names: string[] = []): [number, number][] {
  const spans: [number, number][] = [];
  for (let i = 0; i < line.length; i++) {
    const quote = line[i]!;
    if (quote !== '"' && quote !== "'" && quote !== '`') continue;
    let end = i + 1;
    while (end < line.length && line[end] !== quote) end += line[end] === '\\' ? 2 : 1;
    if (end >= line.length) break; // unterminated: an apostrophe in prose, not a literal
    const content = line.slice(i + 1, end);
    if (!NAME_LITERAL_PREFIX.test(line.slice(0, i)) && is_value_literal(line.slice(0, i), content, surface_names)) spans.push([i + 1, end]);
    i = end;
  }
  // an unquoted `key = value` under a value name, or a bearer/basic credential, in a comment
  const comment_at = find_comment_start(line);
  if (comment_at >= 0) for (const found of line.slice(comment_at).matchAll(/([\w-]+)\s*[:=]\s*([^\s"'`,;)]+)|\b(?:bearer|basic)\s+([^\s"'`,;)]+)/gi)) {
    if (found[3] || is_value_key(found[1])) { const value = found[3] ?? found[2]!; spans.push([comment_at + found.index! + found[0].length - value.length, comment_at + found.index! + found[0].length]); }
  }
  spans.push(...find_option_spans(line, true));
  for (const found of line.matchAll(/[^\s'"`/@:]+:[^\s'"`@/]*@|:\/\/[^\s/@]*@/g)) spans.push([found.index!, found.index! + found[0].length]);
  return spans;
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
export const find_security_check = (line: string): string | undefined => CHECK_KINDS.find(({ patterns }) => patterns.some((pattern) => pattern.test(line)))?.kind ?? find_operand_check(line);

// General rule: a security operand word and a check form on one line, however the language spells it. Crypto APIs and authorization verbs count alone.
const OPERAND = /^(?:auth(?:n|z|enticat\w*|oriz\w*)?|tokens?|secrets?|pass(?:word|wd)?s?|pwd|keys?|apikeys?|cred(?:ential)?s?|signatures?|sig|hmac|digests?|hash(?:es|ed)?|ciphers?|\w*crypt\w*|jwts?|bearer|sessions?|cookies?|roles?|admins?|permissions?|perms?|acl|polic(?:y|ies)|owners?|grants?|scopes?|claims?|certs?|tls|otp|totp|pin|nonce|secure|stored|expected)$/;
const PERMISSION_OPERAND = /^(?:roles?|admins?|permissions?|perms?|acl|polic(?:y|ies)|owners?|grants?|scopes?|authz|authorize\w*)$/;
const FORM_WORD = /^(?:valid|ok|eql|match|allowed|allows|permitted|member|members|matches|ne|enforce|equals?|eq|compare|cmp|isequal|in|verify|validate|check|evaluate|authorize|authenticate|can|cannot|guard|middleware|decorator|attribute|\w*(?:cmp|compare|equals?))$/;
// a constant-time or equality helper is an operand of its own; a call that allows, permits or tests group membership is a permission check
const CONSTANT_TIME_WORDS = /\b(?:safe equal|constant time|timing safe|ct eq)\b/;
const PERMISSION_CALL = /\b(?:allowed|allows|permitted|in group|member of)\b/;
// a negated request or session user is an authentication check
const NEGATED_USER = /!\s*(?:req|request|ctx|session)\.(?:user|session)\b(?!\.)|\bnot\s+(?:req|request)\.user\b(?!\.)|\b(?:req|request)\.user\.is_anonymous\b|\bcurrent_user\.nil\?/;
const CRYPTO_API = /\bopenssl_\w+|\bcrypto\.subtle\b|\bCipher\.\w+|\b(?:hashlib|bcrypt|argon2|scrypt|pbkdf2)\b|\b(?:can|cannot)\?|\.(?:enforce|authorize)(?:ex)?\s*\(|\b(?:can|cannot)\s*\(\s*[:'"]/i;
// a decorator, attribute or middleware is a check by its NAME (last segment); words inside its string arguments never count
const AUTH_NAME_WORD = /^(?:auth|authn|authz|authenticat\w*|authoriz\w*|authentication|permissions?|roles?|login|admin|secured|guards?|jwt|acl)$/;
const MEMBERSHIP_OF_PERMISSIONS = /([\w$]+)\s*\.\s*(?:includes|has|contains|hasAny|some|indexOf|containsKey)\s*\(/g;
const BLANK_STRINGS = /(?<!\[)(["'`])(?:\\.|(?!\1).)*\1/g;
const words_of = (identifier: string): string[] => split_words(identifier).toLowerCase().split(/\s+/).filter(Boolean);
function find_operand_check(line: string): string | undefined {
  if (/^\s*(?:\/\/|#|\*|\/\*|--)/.test(line)) return undefined;
  const marker = /^\s*(?:@|\[\s*)([\w.]+)/.exec(line);
  if (marker) {
    const names = marker[1]!.split('.');
    if (words_of(names[names.length - 1]!).some((word) => AUTH_NAME_WORD.test(word))) return 'permission or role check';
    line = line.slice(0, marker.index) + line.slice(marker.index).replace(/^(\s*)(?:@|\[\s*)/, '$1');
  }
  // a constant set to a literal states a value, it checks nothing
  if (/^\s*(?:export\s+)?(?:(?:const|let|var|final|static|readonly|public|private)\s+)*[A-Za-z_]\w*\s*(?::[^=]+)?=\s*(?:-?\d[\w.]*|["'][^"']*["']|true|false|null)\s*;?\s*$/.test(line)) return undefined;
  // route paths and counts of an operand are not operands
  // "$VAR" is the variable; any other string is a value, its words are not operands; sigils and dashes join words
  const code = line.replace(/(["'])\$\{?(\w+)\}?\1/g, '$2').replace(BLANK_STRINGS, '""').replace(/[$@&](?=[A-Za-z_])/g, '').replace(/(?<=\w)-(?=[A-Za-z_])/g, '_').replace(/[\w$]+(?:\.[\w$]+)*\.(?:length|size|count)\b(?:\(\))?/g, ' ');
  if (NEGATED_USER.test(code)) return 'permission or role check';
  if (CRYPTO_API.test(code)) return /\b(?:can|cannot|enforce|authorize)/i.test(code) ? 'permission or role check' : 'crypto or credential check';
  const identifiers = code.match(/[A-Za-z_$][\w$]*/g) ?? [];
  const operands = new Set<string>();
  let predicate = false;
  for (const identifier of identifiers) {
    const parts = words_of(identifier);
    const COUNTED = /^(?:count|len|length|size|num|number|index|limit|max|min)$/;
    parts.forEach((part, i) => { if (OPERAND.test(part) && !COUNTED.test(parts[i + 1] ?? '') && !COUNTED.test(parts[i - 1] ?? '')) operands.add(part); });
    if (/^(?:is|has|can)$/.test(parts[0] ?? '') && parts.slice(1).some((part) => OPERAND.test(part))) predicate = true;
    const spaced_words = parts.join(' ');
    if (CONSTANT_TIME_WORDS.test(spaced_words)) { operands.add('ct'); predicate = true; }
    if (PERMISSION_CALL.test(spaced_words) && new RegExp(`${identifier.replace(/\$/g, '\\$')}\\s*\\(`).test(code)) { operands.add('permission'); predicate = true; }
    if (parts.includes('parse') && parts.some((part) => /^(?:jws|claims?|jwt)$/.test(part))) predicate = true;
  }
  for (const call of code.matchAll(/(?<![\w$])([\w$]+)\?(?=[\s(),;]|$)/g)) if (words_of(call[1]!).some((part) => OPERAND.test(part))) { predicate = true; operands.add(words_of(call[1]!).find((part) => OPERAND.test(part))!); }
  for (const call of code.matchAll(MEMBERSHIP_OF_PERMISSIONS)) { const found = words_of(call[1]!).find((part) => PERMISSION_OPERAND.test(part)); if (found) { predicate = true; operands.add(found); } }
  if (!operands.size) return undefined;
  const form = predicate || /[!=]==?(?!=)/.test(code) || (!marker && /^\s*\[/.test(code)) || /\.use\(/.test(code)
    || identifiers.some((identifier) => words_of(identifier).some((part) => FORM_WORD.test(part) && (part !== 'in' || !/\bfor\b/.test(code))))
    || /\bin\b/.test(code) && !/\bfor\b/.test(code);
  if (!form) return undefined;
  return [...operands].some((operand) => PERMISSION_OPERAND.test(operand)) ? 'permission or role check' : 'crypto or credential check';
}
export { find_block_lines } from './prose-lexer.js';
// a real check always has code syntax; a prose sentence in a docstring or comment does not (#120). `and`/`or`/`not` count only before a code-shaped operand, since prose says "and the"
const CODE_SYNTAX = /^\s*@\w|\w\s+:[A-Za-z_]\w*|\w!(?!\w)|^\s*[\w$"']+\s*:\s*\S.*,\s*$|^\s*[A-Za-z_$][\w$]*\s*:\s*(?:true|false|nil|null|None)\b|=|&&|\|\||[{};]|\w\(|\w\?(?=[\s,;)]|$)|^\s*(?:if|elif|elsif|unless|return|raise|throw|assert|require|deny)\b|\b(?:and|or|not)\s+(?:not\s+)?[\w$@]+(?:\.\w|[([]|\s*[:)]|\s*$)/;
/** True when a line has code syntax: a comparison or logical operator, an assignment, a call, a leading statement keyword, a brace or a semicolon, a decorator, a Ruby symbol argument, a bang call, an object-literal entry. A wrong block can then only cause a needless hold, never hide a check. */
export const has_code_syntax = (line: string): boolean => CODE_SYNTAX.test(line);
export const is_security_check_line = (line: string): boolean => find_security_check(line) !== undefined;

const SENSITIVE = /\b(?:auth(?:n|z|s|entic\w*|ori[sz]\w*)?|oauth|saml|sso|jwts?|login|logout|passwords?|passwd|credentials?|tokens?|secrets?|sessions?|cookies?|permissions?|privileges?|privileged|rbac|acl|iam|admins?|bypass(?:es|ed)?|vulnerabilit(?:y|ies)|vulnerable|cve|exploit\w*|firewall|security groups?|network (?:polic\w+|rules?|acl)|ingress|egress|allow ?lists?|csrf|xss|ssrf|cors|tls|ssl|certs?|certificates?|encrypt\w*|decrypt\w*|signing keys?|encryption keys?)\b|(?:^|\/)(?:auth|iam|security|permissions?|login)\//i;

/** Identifiers split into words, so `check_auth_token`, `isAuthorized` and `\bauth\b` read as the words they hold. */
const split_words = (text: string): string => text.replace(/\\[bBdDsSwW]/g, ' ').replace(/\\(.)/g, '$1').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/[_-]+/g, ' ');

/** Auth internals, permission checks and bypasses, vulnerability details, IAM/firewall/network rules: a human writes these. */
export const is_security_sensitive = (text: string): boolean => SENSITIVE.test(split_words(text));
/** The word or path folder that made `text` security-sensitive (for a reason line), lower-cased; undefined when none. */
export const find_sensitive_word = (text: string): string | undefined => SENSITIVE.exec(split_words(text))?.[0].replace(/\//g, '').toLowerCase();
