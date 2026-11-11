/**
 * Masked secrets report (#59): per finding, whether the value is in git history, its status and what to do next.
 * Values are read only in memory (current file or .env.hewtd) to test history; the report holds masks and hashes.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { SecretsConfig } from '../../utils/config.js';
import type { Ledger } from './ledger.js';
import { resolve_review_dir } from './review.js';
import { validate_no_secrets, find_secrets, compute_fingerprint, format_masked, type SecretFinding } from './secrets.js';

export interface ReportEntry {
  rule: string; file: string; line?: number; masked: string; fingerprint: string;
  // eslint-disable-next-line id-denylist -- serialized key (review JSON, secrets report)
  kind: 'secret' | 'personal'; status: 'pending' | 'moved'; in_history?: boolean; env?: string;
}

/** Stream `git log --all -p` for one path and report which wanted values ever appeared. Nothing but the path is passed to git. */
export async function find_values_in_history(working_dir: string, path: string, values: string[]): Promise<Set<string>> {
  const found_values = new Set<string>();
  if (!values.length) return found_values;
  const keep = Math.max(...values.map((value) => value.length));
  await new Promise<void>((done) => {
    // eslint-disable-next-line id-denylist -- child_process option name
    const git_log = spawn('git', ['log', '--all', '--follow', '-p', '-U0', '--format=', '--', path], { cwd: working_dir, stdio: ['ignore', 'pipe', 'ignore'] });
    let tail = '';
    git_log.stdout.setEncoding('utf-8');
    git_log.stdout.on('data', (chunk: string) => {
      const window = tail + chunk;
      for (const value of values) if (window.includes(value)) found_values.add(value);
      tail = window.slice(-keep);
    });
    git_log.on('error', () => done());
    git_log.on('close', () => done());
  });
  return found_values;
}

async function load_environment(repo_root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  try {
    for (const line of (await readFile(join(repo_root, '.env.hewtd'), 'utf-8')).split('\n')) {
      const match = /^([A-Za-z_]\w*)=(.*)$/.exec(line);
      if (!match) continue;
      let value = match[2] ?? "";
      if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { /* keep raw */ } }
      found.set(match[1]!, value);
    }
  } catch { /* no env file */ }
  return found;
}

const STEPS = [
  'Rotate or revoke it. If it was in git history (flag above), moving it does not un-leak it.',
  'Put the new value in your real secret store, then delete its line from `.env.hewtd`.',
  'Optionally purge history with `git filter-repo`; forks, clones and caches keep a copy.',
  'Reindex any search tool built from the docs.',
];

export async function build_secrets_report(options: {
  root: string; docs_root: string; findings: SecretFinding[]; ledger?: Ledger; secrets_config: SecretsConfig; date?: string;
}): Promise<{ entries: ReportEntry[]; text: string }> {
  const { root: repo_root, docs_root: docs_root, secrets_config: config } = options;
  const entries: ReportEntry[] = [];
  const find_file = (file: string): string | undefined => [join(docs_root, file), join(repo_root, file)].find((candidate) => existsSync(candidate));
  const wanted = new Map<string, Map<string, ReportEntry>>(); // repo path -> value -> entry (values stay in memory)
  const add_wanted_entry = (path: string, value: string, entry: ReportEntry): void => {
    if (!wanted.has(path)) wanted.set(path, new Map());
    wanted.get(path)!.set(value, entry);
  };
  const resolve_repo_path = (abs_path: string): string => abs_path.slice(repo_root.length + 1);

  const by_file = new Map<string, SecretFinding[]>();
  for (const file of options.findings) by_file.set(file.file, [...(by_file.get(file.file) ?? []), file]);
  for (const [file, file_findings] of by_file) {
    const abs_path = find_file(file);
    const raws = abs_path ? find_secrets(await readFile(abs_path, 'utf-8'), file, config) : [];
    for (const finding of file_findings) {
      const entry: ReportEntry = { rule: finding.rule, file: finding.file, line: finding.line, masked: finding.masked, fingerprint: finding.fingerprint, kind: finding.kind, status: 'pending' };
      entries.push(entry);
      const raw_secret = raws.find((result) => result.finding.fingerprint === finding.fingerprint);
      if (raw_secret && abs_path && finding.kind === 'secret') add_wanted_entry(resolve_repo_path(abs_path), raw_secret.value, entry);
    }
  }
  const environment = await load_environment(repo_root);
  for (const ledger_entry of Object.values(options.ledger?.entries ?? {})) {
    for (const name of ledger_entry.env_names ?? []) {
      const value = environment.get(name);
      // eslint-disable-next-line id-denylist -- serialized key (review JSON, secrets report)
      const entry: ReportEntry = { rule: 'moved', file: ledger_entry.path, masked: value ? format_masked(value) : '(removed from .env.hewtd)', fingerprint: value ? compute_fingerprint(value) : '', kind: 'secret', status: 'moved', env: name };
      entries.push(entry);
      const abs_path = find_file(ledger_entry.path);
      if (value && abs_path) add_wanted_entry(resolve_repo_path(abs_path), value, entry);
    }
  }
  for (const [path, values_to_entries] of wanted) {
    const history_values = await find_values_in_history(repo_root, path, [...values_to_entries.keys()]);
    for (const [value, entry] of values_to_entries) entry.in_history = history_values.has(value);
  }

  const secrets = entries.filter((entry) => entry.kind === 'secret');
  const personal = entries.filter((entry) => entry.kind === 'personal');
  const lines: string[] = [`# Secrets report ${options.date ?? new Date().toISOString().slice(0, 10)}`, '', 'Values are never shown: masked as first 4 characters and length, plus a hash prefix.', ''];
  lines.push(`## Secrets (${secrets.length})`, '');
  if (!secrets.length) lines.push('None found.', '');
  for (const entry of secrets) {
    const hist = entry.in_history === undefined ? 'unknown' : entry.in_history ? 'yes' : 'no';
    lines.push(`- \`${entry.rule}\` ${entry.file}${entry.line ? `:${entry.line}` : ''} ${entry.masked} (${entry.fingerprint.slice(0, 12)}) - in git history: ${hist} - status: ${entry.status}${entry.env ? ` (${entry.env})` : ''}`);
  }
  if (secrets.length) lines.push('', '### Next steps, for each secret above', '', ...STEPS.map((step, i) => `${i + 1}. ${step}`), '');
  if (personal.length) {
    lines.push(`## Personal data, review only (${personal.length})`, '', 'Never moved to `.env.hewtd`. Decide per item whether it belongs in the docs.', '');
    for (const entry of personal) lines.push(`- \`${entry.rule}\` ${entry.file}:${entry.line} ${entry.masked} (${entry.fingerprint.slice(0, 12)})`);
    lines.push('');
  }
  const text = lines.join('\n');
  validate_no_secrets(text, 'the secrets report', config);
  return { entries, text };
}

export async function write_secrets_report(repo_root: string, text: string, date = new Date().toISOString().slice(0, 10)): Promise<string> {
  const file = join(resolve_review_dir(repo_root), `secrets-report-${date}.md`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}
