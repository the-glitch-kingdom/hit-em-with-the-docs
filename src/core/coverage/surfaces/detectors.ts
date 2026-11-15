/**
 * Surface detectors (#117): what the code declares, in any repo and language. Each detector reads one file's
 * lines and returns surfaces; only names leave a detector, never a value. A constant carries its literal only when
 * is_stateable_constant says it may be stated. Add a detector by adding an entry to SURFACE_DETECTORS.
 */
import { is_constant_value, is_stateable_constant } from '../../security/gate.js';

export type SurfaceKind = 'scheduled-job' | 'alert-rule' | 'http-route' | 'cli-command' | 'cli-flag' | 'ci-workflow' | 'ci-job' | 'background-task' | 'constant' | 'config-key';
export interface Surface { kind: SurfaceKind; name: string; file: string; line: number; source_kind: string; /** Constants only, and only when stateable. */ value?: string }
export interface SurfaceDetector { id: string; applies: (file: string) => boolean; detect: (file: string, lines: string[]) => Surface[] }

const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|php|sh)$/;
const YAML = /\.ya?ml$/;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
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
function list_block_keys(lines: string[], from: number): { name: string; line: number }[] {
  const keys: { name: string; line: number }[] = [];
  let indent: number | undefined;
  for (let i = from + 1; i < lines.length; i++) {
    const text = lines[i]!;
    if (!text.trim() || /^\s*#/.test(text)) continue;
    const depth = text.length - text.trimStart().length;
    if (indent === undefined) indent = depth;
    if (depth < indent) break;
    const key = depth === indent ? /^\s*['"]?([\w.:-]+)['"]?\s*:\s*(?:\{|#.*)?$/.exec(text) : null;
    if (key) keys.push({ name: key[1]!, line: i + 1 });
  }
  return keys;
}

const CRON_LINE = /^\s*[\d*/,-]+\s+[\d*/,-]+\s+[\d*?/,-]+\s+[\w*/,-]+\s+[\w*?/,-]+\s+(\S+)(?:\s+(\S+))?/;

export const SURFACE_DETECTORS: SurfaceDetector[] = [
  // scheduled jobs
  by_pattern('crontab', 'scheduled-job', (file) => /(^|\/)(crontab|cron\.d\/[^/]+|[^/]*\.cron)$/.test(file), CRON_LINE, (match) => base(match[2]?.includes('/') && !match[1]!.includes('/') ? match[2] : match[1]!)),
  { id: 'github-schedule', applies: (file) => WORKFLOW.test(file), detect: (file, lines) => { const at = lines.findIndex((text) => /^\s*-\s*cron:/.test(text)); return at < 0 ? [] : [{ kind: 'scheduled-job', name: stem(file), file, line: at + 1, source_kind: 'github-schedule' }]; } },
  { id: 'k8s-cronjob', applies: (file) => YAML.test(file), detect: (file, lines) => lines.flatMap((text, i) => {
    if (!/^kind:\s*CronJob\b/.test(text)) return [];
    const found = lines.slice(i + 1, i + 12).map((next, j) => ({ match: /^\s+name:\s*['"]?([\w.-]+)/.exec(next), line: i + j + 2 })).find((item) => item.match);
    return found ? [{ kind: 'scheduled-job' as const, name: found.match![1]!, file, line: found.line, source_kind: 'k8s-cronjob' }] : [];
  }) },
  { id: 'celery-beat', applies: (file) => /\.py$/.test(file), detect: (file, lines) => lines.flatMap((text, i) => (/\bbeat_schedule\b.*[={:]\s*\{?\s*$/.test(text) ? list_block_keys(lines, i).map((key) => ({ kind: 'scheduled-job' as const, name: key.name, file, line: key.line, source_kind: 'celery-beat' })) : [])) },
  by_pattern('apscheduler', 'scheduled-job', (file) => /\.py$/.test(file), /\badd_job\(\s*([\w.]+)([^\n]*)/, (match) => /\bid\s*=\s*['"]([\w.-]+)['"]/.exec(match[2]!)?.[1] ?? match[1]!.split('.').pop()),
  // alert rules
  by_pattern('prometheus', 'alert-rule', (file) => YAML.test(file), /^\s*-?\s*alert:\s*['"]?([\w.:-]+)/),
  { id: 'grafana', applies: (file) => /(alert|grafana)/i.test(file) && /\.(json|ya?ml)$/.test(file), detect: (file, lines) => (lines.some((text) => /\bcondition\b/.test(text)) ? lines.flatMap((text, i) => { const found = /^\s*(?:[{[,]\s*)*"?title"?\s*:\s*"?([^",\n]+?)"?\s*(?:,|$)/.exec(text) ?? /[{,]\s*"title"\s*:\s*"([^"]+)"/.exec(text); return found ? [{ kind: 'alert-rule' as const, name: found[1]!.trim(), file, line: i + 1, source_kind: 'grafana' }] : []; }) : []) },
  // HTTP routes
  by_pattern('express-route', 'http-route', (file) => CODE.test(file), /\b(?:app|router|server|api)\.(?:get|post|put|patch|delete)\s*\(\s*['"`](\/[^'"`]*)/g),
  by_pattern('decorator-route', 'http-route', (file) => /\.(?:py|java|kt|ts)$/.test(file), /@(?:\w+\.)?(?:route|get|post|put|patch|delete|Get|Post|Put|Patch|Delete)\(\s*['"`](\/[^'"`]+)/),
  // CLI commands and flags
  by_pattern('argparse', 'cli-flag', (file) => /\.py$/.test(file), /add_argument\(\s*['"](--[\w-]+)/),
  by_pattern('argparse-command', 'cli-command', (file) => /\.py$/.test(file), /\badd_parser\(\s*['"]([\w:-]+)/),
  by_pattern('click', 'cli-flag', (file) => /\.py$/.test(file), /@click\.option\(.*?['"](--[\w-]+)['"]/),
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
