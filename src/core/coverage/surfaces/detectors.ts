/**
 * Surface detectors (#117): what the code declares, in any repo and language. Each detector reads one file's
 * lines and returns surfaces; only names leave a detector, never a value. A constant carries its literal only when
 * is_stateable_constant says it may be stated. Add a detector by adding an entry to SURFACE_DETECTORS.
 */
import { is_constant_value, is_stateable_constant } from '../../security/gate.js';

export type SurfaceKind = 'scheduled-job' | 'alert-rule' | 'http-route' | 'cli-command' | 'cli-flag' | 'ci-workflow' | 'ci-job' | 'background-task' | 'constant' | 'config-key';
export interface Surface { kind: SurfaceKind; name: string; file: string; line: number; source_kind: string; /** Constants only, and only when stateable. */ value?: string; /** The name was withheld (it held a value): it is `<kind label> at file:line` and the surface is matched by position. */ placeholder?: boolean; /** The file path held a value: `file` is WITHHELD_PATH and the surface is only listed for a human. */ path_withheld?: boolean }
export interface SurfaceDetector { id: string; applies: (file: string) => boolean; detect: (file: string, lines: string[]) => Surface[] }

const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|php|sh)$/;
const YAML = /\.ya?ml$/;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
export const KIND_LABEL: Record<SurfaceKind, string> = {
  'scheduled-job': 'scheduled job', 'alert-rule': 'alert rule', 'http-route': 'route', 'cli-command': 'command', 'cli-flag': 'flag', 'ci-workflow': 'CI workflow',
  'ci-job': 'CI job', 'background-task': 'background task', constant: 'constant', 'config-key': 'config key',
};
/** What a file path that held a value is shown as, everywhere. */
export const WITHHELD_PATH = '[withheld path]';
/** The neutral name of a surface whose real name held a value. */
export const placeholder_name = (kind: SurfaceKind, file: string, line: number): string => `${KIND_LABEL[kind]} at ${file}:${line}`;
const base = (path: string): string => path.split('/').pop() ?? path;
const stem = (path: string): string => base(path).replace(/\.[^.]+$/, '');

type Namer = (match: RegExpMatchArray) => string | undefined;
/** One surface per regex match: name from group 1 unless `name_of` says otherwise. */
function by_pattern(id: string, kind: SurfaceKind, applies: (file: string) => boolean, pattern: RegExp, name_of: Namer = (match) => match[1]): SurfaceDetector {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return {
    id, applies,
    detect: (file, lines) => lines.flatMap((text, i) => [...text.matchAll(global)].flatMap((match) => { const name = name_of(match); return name ? [{ kind, name, file, line: i + 1, source_kind: id }] : []; })),
  };
}

/** Names of the keys at the first indent below line `from`, until the block ends. */
function list_block_keys(lines: string[], from: number, entry: RegExp = /^\s*['"]?([\w.:-]+)['"]?\s*:\s*(?:\{|#.*)?$/): { name: string; line: number }[] {
  const keys: { name: string; line: number }[] = [];
  let indent: number | undefined;
  for (let i = from + 1; i < lines.length; i++) {
    const text = lines[i]!;
    if (!text.trim() || /^\s*#/.test(text)) continue;
    const depth = text.length - text.trimStart().length;
    if (indent === undefined) indent = depth;
    if (depth < indent) break;
    const key = depth === indent ? entry.exec(text) : null;
    if (key) keys.push({ name: key[1]!, line: i + 1 });
  }
  return keys;
}

const CRON_LINE = /^\s*(?:@(?:reboot|hourly|daily|midnight|weekly|monthly|yearly|annually)|[\d*/,-]+\s+[\d*/,-]+\s+[\d*?/,-]+\s+[\w*/,-]+\s+[\w*?/,-]+)\s+(\S.*)$/;
const WRAPPERS = new Set(['env', 'nice', 'ionice', 'nohup', 'time', 'sudo', 'flock', 'timeout', 'chronic', 'setsid', 'exec', 'command', 'bundle']);
// the user column of a cron line, when it is not a system file: a plain account word with a command after it
const USER_WORDS = new Set(['root', 'www-data', 'nobody', 'daemon', 'postgres', 'deploy', 'app', 'ubuntu']);
const INTERPRETERS = /^(?:python[\d.]*|node|nodejs|ruby|perl|php|bash|sh|zsh|dash)$/;
// runners whose first argument is the job: `manage.py clearsessions`, `rake db:cleanup`, `npm run sync`, `make purge`
const RUNNERS = new Set(['manage.py', 'django-admin', 'django-admin.py', 'rake', 'artisan', 'rails', 'npm', 'pnpm', 'yarn', 'make', 'flask', 'bin/console']);
const CONTAINER_RUNNERS = new Set(['docker', 'docker-compose', 'podman', 'kubectl']);
// a wrapper flag that takes a value: `nice -n 10`, `flock -w 5`, `sudo -u app`
const takes_value = (flag: string, value = ''): boolean => (/^-[ncwk]$/.test(flag) && /^\d+$/.test(value)) || (/^-[us]$/.test(flag) && /^\w+$/.test(value));
const NO_VALUE_FLAGS = /^(?:-[itdT]+|--(?:rm|interactive|tty|detach|privileged|silent|quiet|verbose))$/;
const unquote = (text: string): string => text.trim().replace(/^(['"])(.*)\1$/, '$2');
/** Skip options; an option's separate value is a bare word that is not the program (no slash, no extension) and is followed by more words. */
function skip_options(list: string[], value_flags: RegExp = /^$/): string[] {
  let rest = list;
  while (rest[0]?.startsWith('-')) {
    const [flag, next] = rest;
    const value = !NO_VALUE_FLAGS.test(flag!) && !flag!.includes('=') && next !== undefined && rest.length > 2 && (value_flags.test(flag!) || /^\d+$/.test(next) || (!next.startsWith('-') && !/[/.]/.test(next)));
    rest = rest.slice(value ? 2 : 1);
  }
  return rest;
}
/** The script or executable a cron command runs: wrappers, `cd X &&`, interpreters and `VAR=..` stripped; runners name their subcommand, container exec its inner command. Undefined when it is not a local program (a URL, curl, wget). `user_column`: the file is a system crontab whose line has a user after the schedule. */
export function name_cron_command(command: string, user_column = false): string | undefined {
  let words = command.trim().split(/\s+/);
  const has_user = words.length > 1 && (user_column ? !/^\w+=/.test(words[0]!) : USER_WORDS.has(words[0]!) && !/^(?:-|\w+=)/.test(words[1]!));
  if (has_user) words = words.slice(1);
  const segment = words.join(' ').split(/&&|\|\||;|\|/).map((part) => part.trim()).find((part) => part && !/^cd\b/.test(part));
  const tokens = (segment ?? '').replace(/\s+(?:>>?|2>>?|<)\s*\S*.*$/, '').split(/\s+/).filter(Boolean);
  const take = (list: string[]): string | undefined => {
    let rest = list.slice();
    // an unlisted user column: a bare word followed by a path, wrapper or interpreter
    if (rest.length > 1 && (/^[a-z_][\w-]*$/.test(rest[0]!) && !WRAPPERS.has(rest[0]!) && !CONTAINER_RUNNERS.has(rest[0]!) && !RUNNERS.has(rest[0]!) && !INTERPRETERS.test(rest[0]!) && (rest[1]!.includes('/') || WRAPPERS.has(rest[1]!) || INTERPRETERS.test(rest[1]!)))) rest = rest.slice(1);
    for (;;) {
      const head = rest[0];
      if (!head) return undefined;
      if (/^\w+=/.test(head)) { rest = rest.slice(1); continue; }
      if (/^(?:curl|wget)$/.test(base(head)) || /^[a-z][a-z0-9+.-]*:\/\//i.test(head)) return undefined;
      const word = base(head);
      if (CONTAINER_RUNNERS.has(word)) {
        const at = rest.findIndex((token) => token === 'exec' || token === 'run');
        if (at < 0) return undefined;
        const after = rest.slice(at + 1);
        const dash = after.indexOf('--');
        if (dash >= 0) return take(after.slice(dash + 1));
        const args = skip_options(after, /^(?:-u|-e|-w|--user|--env|--workdir|-n|--namespace|-c|--container)$/);
        return take(args.slice(1)); // the first positional is the container or pod
      }
      if (word === 'run-parts') {
        const dir = rest.slice(1).find((token) => !token.startsWith('-'));
        return dir?.split('/').filter(Boolean).pop(); // the directory as written: cron.hourly
      }
      if (WRAPPERS.has(word)) {
        rest = rest.slice(1);
        while (rest[0]?.startsWith('-') || /^\w+=/.test(rest[0] ?? '')) rest = rest.slice(takes_value(rest[0]!, rest[1]) ? 2 : 1);
        if (word === 'bundle' || word === 'exec') { if (rest[0] === 'exec') rest = rest.slice(1); continue; }
        if (word === 'flock' || word === 'timeout') {
          rest = rest.slice(1); // the lock file or the duration
          if (rest[0] === '-c') return take(unquote(rest.slice(1).join(' ')).split(/\s+/).filter(Boolean));
        }
        continue;
      }
      if (INTERPRETERS.test(word)) {
        rest = rest.slice(1);
        if (/^(?:ba|z|da)?sh$/.test(word) && /^-\w*c$/.test(rest[0] ?? '')) return take(unquote(rest.slice(1).join(' ')).split(/\s+/).filter(Boolean));
        if (rest[0] === '-m' && rest[1]) return rest[1].split('.').pop();
        if (/^-[ce]$/.test(rest[0] ?? '')) return undefined; // inline code has no name
        rest = skip_options(rest, /^(?:-W|-X|-r|-I|-C|--require|--import|--loader|--eval|-d)$/);
        continue;
      }
      if (RUNNERS.has(word) || RUNNERS.has(head)) {
        const runner_flags = /^(?:-C|-f|--prefix|--cwd|--app|-A)$/;
        let args = skip_options(rest.slice(1), runner_flags);
        if (word !== 'rails' && /^(?:run|run-script|exec)$/.test(args[0] ?? '')) args = skip_options(args.slice(1), runner_flags);
        const sub = word === 'rails' && args[0] === 'runner' ? /^[\w.:]+/.exec(unquote(args.slice(1).join(' ')))?.[0] : args[0];
        return sub && /^[\w.:@+-]+$/.test(sub) ? sub : undefined;
      }
      return word.replace(/\.(?:sh|py|rb|js|ts|php|pl|bash)$/, '') || undefined;
    }
  };
  const name = take(tokens);
  return name && /^[\w.@+:-]+$/.test(name) ? name : undefined;
}

/** Python decorators and calls span lines: the text from line `from` to the closing parenthesis (at most 8 lines). */
function read_call(lines: string[], from: number): string {
  let depth = 0;
  let text = '';
  for (let i = from; i < Math.min(lines.length, from + 8); i++) {
    text += `${lines[i]}\n`;
    for (const char of lines[i]!) depth += char === '(' ? 1 : char === ')' ? -1 : 0;
    if (depth <= 0) break;
  }
  return text;
}

export const SURFACE_DETECTORS: SurfaceDetector[] = [
  // scheduled jobs
  { id: 'crontab', applies: (file) => /(^|\/)(crontab|cron\.d\/[^/]+|[^/]*\.cron)$/.test(file), detect: (file, lines) => lines.flatMap((text, i) => {
    const match = CRON_LINE.exec(text);
    if (!match || /^\s*#/.test(text)) return [];
    const name = name_cron_command(match[1]!, /(^|\/)cron\.d\/|^etc\/crontab$/.test(file));
    return [{ kind: 'scheduled-job' as const, name: name ?? placeholder_name('scheduled-job', file, i + 1), file, line: i + 1, source_kind: 'crontab', ...(name === undefined && { placeholder: true }) }];
  }) },
  { id: 'github-schedule', applies: (file) => WORKFLOW.test(file), detect: (file, lines) => { const at = lines.findIndex((text) => /^\s*-\s*cron:/.test(text)); return at < 0 ? [] : [{ kind: 'scheduled-job', name: stem(file), file, line: at + 1, source_kind: 'github-schedule' }]; } },
  { id: 'k8s-cronjob', applies: (file) => YAML.test(file), detect: (file, lines) => lines.flatMap((text, i) => {
    if (!/^kind:\s*CronJob\b/.test(text)) return [];
    const found = lines.slice(i + 1, i + 12).map((next, j) => ({ match: /^\s+name:\s*['"]?([\w.-]+)/.exec(next), line: i + j + 2 })).find((item) => item.match);
    return found ? [{ kind: 'scheduled-job' as const, name: found.match![1]!, file, line: found.line, source_kind: 'k8s-cronjob' }] : [];
  }) },
  { id: 'celery-beat', applies: (file) => /\.py$/.test(file), detect: (file, lines) => lines.flatMap((text, i) => {
    if (!/beat_schedule\b/i.test(text)) return [];
    const entries = (found: { name: string; line: number }[]): Surface[] => found.map((key) => ({ kind: 'scheduled-job' as const, name: key.name, file, line: key.line, source_kind: 'celery-beat' }));
    const inline = /\{\s*\S/.exec(text);
    // the whole schedule on one line: `beat_schedule = {'a': {...}, 'b': {...}}`
    if (inline) return entries([...text.slice(inline.index).matchAll(/['"]([\w.:-]+)['"]\s*:\s*\{/g)].map((key) => ({ name: key[1]!, line: i + 1 })));
    return /[={:(]\s*\{?\s*$/.test(text) ? entries(list_block_keys(lines, i, /^\s*['"]([\w.:-]+)['"]\s*:\s*\{/)) : [];
  }) },
  by_pattern('apscheduler', 'scheduled-job', (file) => /\.py$/.test(file), /\badd_job\(\s*([\w.]+)([^\n]*)/, (match) => /\bid\s*=\s*['"]([\w.-]+)['"]/.exec(match[2]!)?.[1] ?? match[1]!.split('.').pop()),
  // alert rules
  by_pattern('prometheus', 'alert-rule', (file) => YAML.test(file), /^\s*-?\s*alert:\s*['"]?([\w.:-]+)/),
  { id: 'grafana', applies: (file) => /(alert|grafana)/i.test(file) && /\.(json|ya?ml)$/.test(file), detect: (file, lines) => (lines.some((text) => /\bcondition\b/.test(text)) ? lines.flatMap((text, i) => { const found = /^\s*(?:[{[,]\s*)*"?title"?\s*:\s*"?([^",\n]+?)"?\s*(?:,|$)/.exec(text); const titles = found ? [found[1]!] : [...text.matchAll(/[{,]\s*"title"\s*:\s*"([^"]+)"/g)].map((match) => match[1]!); return titles.map((title) => ({ kind: 'alert-rule' as const, name: title.trim(), file, line: i + 1, source_kind: 'grafana' })); }) : []) },
  // HTTP routes
  by_pattern('express-route', 'http-route', (file) => CODE.test(file), /\b(?:app|router|server|api)\.(?:get|post|put|patch|delete)\s*\(\s*['"`](\/[^'"`]*)/g),
  by_pattern('decorator-route', 'http-route', (file) => /\.(?:py|java|kt|ts)$/.test(file), /@(?:\w+\.)?(?:route|get|post|put|patch|delete|Get|Post|Put|Patch|Delete)\(\s*['"`](\/[^'"`]+)/),
  // CLI commands and flags
  by_pattern('argparse', 'cli-flag', (file) => /\.py$/.test(file), /add_argument\(\s*['"](--[\w-]+)/),
  by_pattern('argparse-command', 'cli-command', (file) => /\.py$/.test(file), /\badd_parser\(\s*['"]([\w:-]+)/),
  { id: 'click', applies: (file) => /\.py$/.test(file), detect: (file, lines) => lines.flatMap((text, i) => {
    if (!/^\s*@click\.option\(/.test(text)) return [];
    const flag = /['"](--[\w-]+)['"]/.exec(read_call(lines, i));
    return flag ? [{ kind: 'cli-flag' as const, name: flag[1]!, file, line: i + 1, source_kind: 'click' }] : [];
  }) },
  { id: 'click-command', applies: (file) => /\.py$/.test(file), detect: (file, lines) => lines.flatMap((text, i) => {
    const decorator = /^\s*@(?:\w+\.)+command\b/.exec(text);
    if (!decorator) return [];
    const explicit = /^\s*(?:name\s*=\s*)?['"]([\w:-]+)['"]/.exec(read_call(lines, i).slice(decorator[0].length).replace(/^\s*\(\s*/, ''));
    const definition = explicit ? undefined : lines.slice(i + 1, i + 9).map((next) => /^\s*(?:async\s+)?def\s+(\w+)/.exec(next)).find(Boolean);
    const name = explicit?.[1] ?? definition?.[1]?.replace(/_/g, '-');
    return name ? [{ kind: 'cli-command' as const, name, file, line: i + 1, source_kind: 'click-command' }] : [];
  }) },
  by_pattern('commander-flag', 'cli-flag', (file) => /\.(?:ts|js|mjs|cjs)$/.test(file), /\.option\(\s*['"][^'"]*?(--[\w-]+)/g),
  by_pattern('yargs-flag', 'cli-flag', (file) => /\.(?:ts|js|mjs|cjs)$/.test(file), /\.option\(\s*['"]([\w-]+)['"]\s*,\s*\{/g, (match) => `--${match[1]}`),
  by_pattern('cli-command', 'cli-command', (file) => /\.(?:ts|js|mjs|cjs)$/.test(file), /\.command\(\s*['"]([\w:-]+)/g),
  // CI workflows and jobs
  { id: 'github-workflow', applies: (file) => WORKFLOW.test(file), detect: (file) => [{ kind: 'ci-workflow', name: stem(file), file, line: 1, source_kind: 'github-workflow' }] },
  { id: 'github-job', applies: (file) => WORKFLOW.test(file), detect: (file, lines) => lines.flatMap((text, i) => (/^jobs:\s*$/.test(text) ? list_block_keys(lines, i).map((key) => ({ kind: 'ci-job' as const, name: key.name, file, line: key.line, source_kind: 'github-job' })) : [])) },
  { id: 'gitlab-job', applies: (file) => base(file) === '.gitlab-ci.yml', detect: (file, lines) => {
    const tops = lines.flatMap((text, i) => { const key = /^([A-Za-z][\w.-]*):\s*$/.exec(text); return key ? [{ name: key[1]!, at: i }] : []; });
    return tops.flatMap((top, i) => (lines.slice(top.at + 1, tops[i + 1]?.at ?? lines.length).some((text) => /^\s+script:/.test(text)) ? [{ kind: 'ci-job' as const, name: top.name, file, line: top.at + 1, source_kind: 'gitlab-job' }] : []));
  } },
  // background tasks and queues
  { id: 'celery-task', applies: (file) => /\.py$/.test(file), detect: (file, lines) => lines.flatMap((text, i) => {
    if (!/^\s*@(?:\w+\.)*(?:shared_task|task)\b/.test(text)) return [];
    const found = lines.slice(i + 1, i + 6).map((next, j) => ({ match: /^\s*(?:async\s+)?def\s+(\w+)/.exec(next), line: i + j + 2 })).find((item) => item.match);
    return found ? [{ kind: 'background-task' as const, name: found.match![1]!, file, line: found.line, source_kind: 'celery-task' }] : [];
  }) },
  by_pattern('bull-queue', 'background-task', (file) => /\.(?:ts|js|mjs|cjs)$/.test(file), /new\s+(?:Queue|Worker|QueueScheduler)\s*(?:<[^>]*>)?\(\s*['"`]([\w:.-]+)/g),
  { id: 'sidekiq', applies: (file) => /\.rb$/.test(file), detect: (file, lines) => (lines.some((text) => /include\s+Sidekiq::(?:Worker|Job)/.test(text)) ? lines.flatMap((text, i) => { const found = /^\s*class\s+(\w+)/.exec(text); return found && lines.slice(i + 1, i + 4).some((next) => /Sidekiq::(?:Worker|Job)/.test(next)) ? [{ kind: 'background-task' as const, name: found[1]!, file, line: i + 1, source_kind: 'sidekiq' }] : []; }) : []) },
  // module-level limit, TTL, size and threshold constants
  { id: 'code-constant', applies: (file) => CODE.test(file), detect: (file, lines) => lines.flatMap((text, i) => {
    const match = /^(?:export\s+)?(?:(?:pub\s+)?const\s+|static\s+)?([A-Z][A-Z0-9_]{2,})\s*(?::\s*[\w<>[\] ]+)?=\s*(.+?)\s*;?\s*(?:(?:\/\/|#).*)?$/.exec(text);
    if (!match || !is_constant_value(match[2]!)) return [];
    return [{ kind: 'constant' as const, name: match[1]!, file, line: i + 1, source_kind: 'code-constant', ...(is_stateable_constant(match[1]!, match[2]!) && { value: match[2]!.trim() }) }];
  }) },
  // config and env key NAMES: never a value or a default
  by_pattern('env-var', 'config-key', (file) => CODE.test(file), /(?:process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[\s*['"]([A-Z][A-Z0-9_]+)|os\.environ(?:\.get)?\s*[[(]\s*['"]([A-Z][A-Z0-9_]+)|\bgetenv\(\s*['"]([A-Z][A-Z0-9_]+)|\bENV(?:\.fetch\(|\[)\s*['"]([A-Z][A-Z0-9_]+))/g, (match) => match.slice(1).find(Boolean)),
  by_pattern('env-file', 'config-key', (file) => /(^|\/)\.env\.(?:example|sample|template|dist)$/.test(file), /^(?:export\s+)?([A-Z][A-Z0-9_]+)=/),
];
