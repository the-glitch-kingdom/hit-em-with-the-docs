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
const REGEX_SYNTAX = /\[[^\]]+\](?:[*+?]|\{\d+(?:,\d*)?\}?)|\\[dwsDWS.]|\.[*+?]|[\^$()|]|\{\d+(?:,\d*)?\}?/g;
// Regex metacharacters making up a quarter of the value also mark a pattern (.*/AKIA[0-9A-Z]{16}/.*).
const is_meta_heavy = (value: string) => (value.match(/[\][{}()*+?.\\^$|]/g)?.length ?? 0) * 4 >= value.length;
const is_regex_pattern = (value: string) => (is_meta_heavy(value) && !is_random_inner(value.replace(REGEX_SYNTAX, '').replace(/[^A-Za-z0-9_-]/g, ''))) || /\[[^\]]+\](?:[*+?]|\{\d)|\\[dwsDWS]|\.[*+]|^\^.*\$$/.test(value) && !is_strong(value.replace(REGEX_SYNTAX, ''));

// One word test for every exemption (#76): is the token made of words, acronyms and short numbers? Split on non-alphanumerics,
// then into humps (OpenAIKey -> Open, AI, Key) and judge each hump, never across humps (minLengthRequirement12 is fine).
// Words need a vowel (y counts), no five consonants in a row and no consonant pair English lacks; random letters fail these far
// more often than names do. Digits are short and follow a word; short humps (1-2 letters) never make up most of a token.
// shortcut: letters in clean humps that look like a word pass (no word list); upgrade to one if random values start slipping through.
// Common vowel-less abbreviations in names (Http, Css, Rtp).
const VOWELLESS = /^(?:http|https|css|jsx|tsx|cls|rtp|rgb|rgba|tcp|udp|dns|ssl|tls|ssh|src|dst|ctx|cfg|btn|msg|pwd|svg|xml|html|sql|npm|dll|llm|url|rtc|jwt|cidr|ipv|nlp|gpu|cpu|ssr|csrf|xss|grpc|wsl|php|cgi|mvc|rpc|dto|orm|ascii|utf|fn|db|fs|fd|cb|ms|ns|px|pc|cwd|abs|nth|bpm|rsa|pkcs|hmr|ts|js|khr|sync|cmd|ttl|tty|cjs|mjs|cve|cdp|ksuid|bg|fg|vm|nan|tf|gpg|fds|argv|str)$/i;
// Two consonants in a row that occur in at least 20 English words; a pair outside this list (vk, dz, bz) marks random letters.
const CONSONANT_PAIRS = new Set('vt kg gv tv bb bc bd bg bh bj bk bl bm bn bp br bs bt cc ch ck cl cm cq cr cs ct db dc dd df dg dh dj dl dm dn dp dr ds dt dv dw ff fl fr fs ft gb gg gh gl gm gn gr gs gt gw hb hd hf hh hl hm hn hp hr hs ht hw js jv kb kd kf kh kl km kn kp kr ks kt kw lb lc ld lf lg lh lk ll lm ln lp lr ls lt lv lw mb md mf mg ml mm mn mp mr ms nb nc nd nf ng nh nj nk nl nm nn np nq nr ns nt nv nw nx nz pb pc pd pf pg ph pl pm pn pp pr ps pt pw rb rc rd rf rg rh rj rk rl rm rn rp rq rr rs rt rv rw sb sc sd sf sg sh sk sl sm sn sp sq sr ss st sw tc td tf tg th tl tm tn tp tr ts tt tw tz wb wd wf wh wk wl wm wn wp wr ws wt xc xh xp xt xx zl zz'.split(' '));
const HUMP = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g;
export function is_word_like(raw_token: string): boolean {
  const token = raw_token.replace(/(?<=[A-Z])v(?=\d)/g, ''); // IPv6, CIDRv4: a version after an acronym
  const pieces = token.split(/[^A-Za-z0-9]+/).filter(Boolean).map((piece) => piece.match(HUMP) ?? []);
  const humps = pieces.flat();
  const is_digits = (hump?: string) => !!hump && /^\d/.test(hump);
  const is_upper = (hump: string) => /^[A-Z]+$/.test(hump);
  // A word has a vowel (y counts) or is a known abbreviation, no five consonants in a row, and (up to 8 letters, past that
  // compounds like webhooks or upgraded are common) no consonant pair that English lacks.
  const is_word = (hump: string, whole_piece: boolean) => {
    if (VOWELLESS.test(hump)) return true;
    const lower = hump.toLowerCase(), upper = is_upper(hump);
    if (upper && whole_piece && pieces.length > 1 && !/[a-z]/.test(token) && hump.length <= 4) return true; // a short abbreviation inside a CONSTANT_NAME
    if (!/[aeiouy]/.test(lower) || /[bcdfghjklmnpqrstvwxz]{5,}/.test(lower)) return false;
    if (upper && hump.length < 6 && !/[AEIOU]/.test(hump)) return false; // YTD: a lone Y is no vowel in an acronym
    if (hump.length >= 3 && !/[bcdfghjklmnpqrstvwxz]/.test(lower)) return false; // all vowels
    if (hump.length > 2 && !/[aeiou]/.test(lower) && !/^(?:sky|fly|try|cry|dry|gym|spy|shy|sys|sync|lynx|myth|crypt)$/.test(lower)) return false; // y alone is a vowel in few words
    if (!upper && /[aeiou]{3}/.test(lower.replace(/ueue|eei|eau|iou|eou|uou|ooi|ioi|uoi|oau/g, ''))) return false;
    if (!upper && hump.length <= 8 && ![...lower.matchAll(/(?=([bcdfghjklmnpqrstvwxz]{2}))/g)].every((pair) => CONSONANT_PAIRS.has(pair[1]!))) return false;
    return !upper || hump.length < 5 || whole_piece; // a 5+ letter acronym only as a whole piece (ENVIRONMENT), never glued to words
  };
  const is_valid = (hump: string, index: number, piece: string[], piece_index: number) => {
    const [previous, next] = [piece[index - 1], piece[index + 1]];
    // Digits before letters (Http2Response, acme2go) follow a word and lead into a capitalized word or a 1-2 letter lowercase one;
    // at the start of a later piece (10x6) they lead into one letter. Anything else (ypap7nhi, 709jequq) reads as random.
    if (is_digits(hump)) {
      const next_is_word = !next || is_digits(next) || (/^[A-Z]/.test(next) ? next.length >= 3 || !is_upper(next) : hump.length === 1 && next.length <= 2 && /[aeiouy]/.test(next) && !piece[index + 2]);
      return hump.length <= 4 && (!next || is_digits(next) || (previous ? previous.length >= 2 && !is_digits(previous) && next_is_word : piece_index > 0 && next.length === 1));
    }
    if (hump.length === 1) return piece.length === 1 || (is_upper(hump) && (previous?.length ?? 0) >= 3 && (next?.length ?? 0) >= 3) || is_digits(next) || is_digits(previous) || (index === 0 && (next?.length ?? 0) >= 3); // x, v1, xCoord
    return (is_upper(hump) && hump.length <= 2) || is_word(hump, piece.length === 1) || piece.length === 1 && hump.length <= 2;
  };
  // Noise: short letter humps and digits that follow no word, counted in pieces cut into several humps (separators like '_' are deliberate).
  const chopped = pieces.filter((piece) => piece.length > 1).flat();
  const noise = pieces.filter((piece) => piece.length > 1).flatMap((piece) => piece.filter((hump, index) => (is_digits(hump) ? !piece[index - 1] || is_digits(piece[index - 1]) : hump.length <= 2 && !is_upper(hump)))).length;
  const letters = token.replace(/[^A-Za-z]/g, '').length, letter_humps = humps.filter((hump) => !is_digits(hump)).length;
  if (!humps.length || (token.length >= 6 && noise * 2 > chopped.length && (chopped.length > 3 || noise === chopped.length)) || (token.length >= 8 && letters * 2 < letter_humps * 5)) return false;
  return pieces.every((piece, piece_index) => piece.every((hump, index) => is_valid(hump, index, piece, piece_index)));
}
// Contents that look like a value: 8+ characters, no spaces, neither word-like nor made of ascending runs. No entropy
// bar: short random strings often fall under one, and an excuse must never cover random characters.
const is_random_inner = (inner: string) => inner.length >= 8 && /^\S+$/.test(inner) && !is_word_like(inner) && !has_ascending_run(inner.toLowerCase());

// Placeholder filter. `weak` words (test, password, secret) only apply to generic/url rules,
// where the value is free text; known-shape keys like sk_test_ are real credentials.
export function is_placeholder(value: string, weak: boolean): boolean {
  const line = value.toLowerCase();
  if (/^your[_-]|\$\{|^\$[a-z_]|x{3,}|\*{3,}|\.{3}|…|example|changeme|change_me|dummy|placeholder|redacted/.test(line)) return true;
  // Wrapped values and fake-key prefixes only excuse free text, and only when what is inside is not itself a strong value.
  if (weak) {
    const wrapped = /^(?:\[(.*)\]|<(.*)>|\$\{(.*)\}|\{\{(.*)\}\}|\$\((.*)\)|%\((.*)\)s)$/.exec(value);
    if (wrapped && !is_random_inner(wrapped.slice(1).find((group) => group !== undefined)!)) return true;
    const inline = /<([^>]*)>/.exec(value);
    if (inline && !is_random_inner(inline[1]!)) return true;
    const prefix = /^(?:abc123|123456|abcdef|qwerty)/i.exec(value);
    // ...followed by nothing, a short tail, more runs (abc123def456) or a separated word (_your_key); glued letters are a value.
    const tail = prefix ? value.slice(prefix[0].length) : '';
    if (prefix && (tail.length < 4 || has_ascending_run(tail.toLowerCase()) || (/^[_-]/.test(tail) && is_word_like(tail.slice(1))))) return true;
  }
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
const is_word_chain = (value: string, sep = '.') => value.length > 0 && value.split(sep).every((segment) => /^[\w-]+$/.test(segment) && is_word_like(segment));
const is_strong = (value: string) => (UUID.test(value) && new Set(value.replace(/-/g, '')).size > 4) || (value.length >= 16 && compute_entropy(value) >= 3.5);
// Code, not a credential: a word-made dotted chain (self.x, settings.X), a call of one, or only {name} template slots around weak text.
// A bare value (no '.', '(' or '[') is code only when shaped like an identifier: two or more word humps (camelCase,
// snake_case, UPPER_SNAKE) with digits only as one trailing group of up to 3. One run of letters, or digits between
// humps, is how generated passwords look (pronounceable syllables plus digits).
const is_bare_identifier = (value: string) => {
  const core = value.replace(/\d{1,3}$/, '');
  if (!/^[A-Za-z_]+$/.test(core)) return false;
  const humps = core.split('_').filter(Boolean).flatMap((piece) => piece.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+/g) ?? []);
  return humps.length >= 2 && humps.every((hump) => hump.length >= 2 && is_word_like(hump));
};
// Structured values (member access, call, index) are vouched for by their structure; what must be ruled out is a random token,
// and random tokens have scattered digits and short mixed-case humps. Code identifiers are often not English (utcnow, qdrant,
// hsl), so no word test here: snake/lower, UPPER_SNAKE or camel/Pascal, digits in one group, humps mostly 3+ letters.
// shortcut: a long lowercase run needs a word test; a short random lowercase token (up to 16 letters) still passes, upgrade if one shows up.
export function is_identifier_shaped(raw_token: string): boolean {
  const token = raw_token.replace(/^_+|_+$/g, '');
  const digit_groups = token.split('_').map((piece) => piece.match(/\d+/g) ?? []);
  if (token.length > 64 || digit_groups.some((groups) => groups.length > 1 || groups.some((digits) => digits.length > 4)) || digit_groups.flat().length > 2 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(token)) return false;
  // Mixed case is where random letters hide: at most one acronym (ToJSContext) and no short humps; real words (3+ letters,
  // not all capitals) make up 60% of the letters. snake_case and UPPER_SNAKE are separated on purpose and skip this.
  if (/[a-z]/.test(token) && /[A-Z]/.test(token)) {
    const humps = token.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+/g) ?? [];
    const acronyms = humps.filter((hump) => hump.length >= 2 && !/[a-z]/.test(hump)).length;
    const words = humps.filter((hump) => hump.length >= 3 && /[a-z]/.test(hump)).join('').length;
    if (acronyms > 1 || humps.filter((hump) => hump.length <= 2 && !/^[A-Z]{2}$/.test(hump)).length * 2 > humps.length || (words + (acronyms ? 3 : 0)) * 5 < token.replace(/[^A-Za-z]/g, '').length * 3 || !humps.every((hump) => hump.length < 4 || is_word_like(hump))) return false;
  }
  return !(/^[a-z][a-z0-9]*$/.test(token) && token.length > 16) || is_word_like(token);
}
// Code names are rarely all English (utcnow, qdrant, hsl, kv), but random values are made of non-words. Each token (split at
// punctuation, '_' kept) is word-like as a whole, with at most one exception in the value: a short lowercase name that is called
// or accessed (utcnow(), hsl(, b64decode(), or one short part of a name beside at most two common config words (qdrant_api_key, vault_kv).
// A long single-case run is random even when it passes the word test.
const CONFIG_WORDS = new Set('api key keys id url uri host port token secret secrets client user username password pass name version path endpoint base region index collection db kv vault auth app env model org project bucket account access cluster server service'.split(' '));
const is_word_token = (token: string) => is_word_like(token) && !(/^(?:[a-z]{13,}|[A-Z]{13,})$/.test(token) && (token.length >= 20 || compute_entropy(token) >= 3.3));
const is_code_words = (text: string) => {
  const odd = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z0-9_]+/g)) {
    const token = match[0];
    if (/^\d{1,4}$/.test(token) || is_word_token(token)) continue;
    const parts = token.split('_').filter(Boolean), words = parts.filter(is_word_token), [part = ''] = parts.filter((piece) => !is_word_token(piece));
    const is_called = /^[.(]/.test(text.slice(match.index + token.length));
    const allowed = parts.length - words.length === 1 && (parts.length === 1
      ? is_called && /^[a-z][a-z0-9]{1,9}$/.test(part)
      : /^(?:[a-z]{2,6}|[A-Z]{2,6})$/.test(part) && (part.length <= 2 || /[aeiou]/i.test(part)) && words.length <= 2 && words.every((word) => CONFIG_WORDS.has(word.toLowerCase())));
    if (!allowed) return false;
    odd.add(part.toLowerCase());
  }
  return odd.size <= 1;
};
// `[text](target)`: no userinfo in the target, and the text and target together pass is_code_words.
const is_markdown_link = (value: string) => {
  const link = /^\[([^\]]+)\]\(([^)\s@]+)\)$/.exec(value);
  return !!link && is_code_words(`${link[1]} ${link[2]}`);
};
// `$NAME` / `${NAME}` references: code when nothing random is left once the references and regex syntax are removed.
const is_variable_reference = (value: string) => {
  if (!/\$\{?[A-Za-z_]/.test(value)) return false;
  const left = value.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (whole_match, name: string) => (is_identifier_shaped(name) ? '' : whole_match)).replace(REGEX_SYNTAX, '').replace(/[^A-Za-z0-9_-]/g, '');
  return !is_random_inner(left);
};
const is_code = (value: string) => {
  if (value.includes('.') ? is_word_chain(value) : is_bare_identifier(value)) return true;
  if (is_markdown_link(value) || is_variable_reference(value)) return true;
  // member access, optional chain, call or index: every token is identifier-shaped or a short number, at least one is 4+ letters,
  // and the word parts pass is_code_words.
  const tokens = value.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  if (/^[A-Za-z_]\w*(?:\?\.|\.|\(|\[)/.test(value) && tokens.some((token) => token.length >= 4 && is_identifier_shaped(token)) && tokens.every((token) => is_identifier_shaped(token) || /^\d{1,4}$/.test(token)) && is_code_words(value)) return true;
  const rest = value.replace(/\{([A-Za-z_][\w.]*)\}/g, (whole_match, slot: string) => (is_word_chain(slot) ? '' : whole_match));
  return rest !== value && !is_strong(rest);
};
// Any well-formed address is an email unless a part looks random: 12+ characters with entropy >= 3.3, or 6+ characters
// that are neither word-like nor all digits.
const is_random_part = (part: string) => (part.length >= 12 && compute_entropy(part) >= 3.3) || (part.length >= 6 && !/^\d+$/.test(part) && !is_word_like(part));
const is_email = (value: string) => {
  const match = /^([^@\s]{1,64})@([^@\s]{1,255}\.[A-Za-z]{2,})$/.exec(value);
  return !!match && ![...match[1]!.split(/[._+-]/), ...match[2]!.split(/[.-]/)].some(is_random_part);
};
/** `<NAME from Vault: ...>`: a word-made name after '<' with a closing '>' later on the same line. */
const build_pointer_record = (value: string, match: RegExpMatchArray) => {
  if (!value.startsWith('<') || !is_word_like(value.slice(1).replace(/>.*$/, ''))) return false;
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
