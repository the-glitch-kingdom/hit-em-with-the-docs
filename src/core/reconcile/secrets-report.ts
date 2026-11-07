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
import { assertNoSecrets, findSecrets, fingerprint, mask, type SecretFinding } from './secrets.js';

export interface ReportEntry {
  rule: string; file: string; line?: number; masked: string; fingerprint: string;
  kind: 'secret' | 'personal'; status: 'pending' | 'moved'; inHistory?: boolean; env?: string;
}

/** Stream `git log --all -p` for one path and report which wanted values ever appeared. Nothing but the path is passed to git. */
export async function valuesInHistory(cwd: string, path: string, values: string[]): Promise<Set<string>> {
  const hit = new Set<string>();
  if (!values.length) return hit;
  const keep = Math.max(...values.map((v) => v.length));
  await new Promise<void>((done) => {
    const p = spawn('git', ['log', '--all', '-p', '-U0', '--format=', '--', path], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let tail = '';
    p.stdout.setEncoding('utf-8');
    p.stdout.on('data', (c: string) => {
      const s = tail + c;
      for (const v of values) if (s.includes(v)) hit.add(v);
      tail = s.slice(-keep);
    });
    p.on('error', () => done());
    p.on('close', () => done());
  });
  return hit;
}

async function readEnv(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    for (const l of (await readFile(join(root, '.env.hewtd'), 'utf-8')).split('\n')) {
      const m = /^([A-Za-z_]\w*)=(.*)$/.exec(l);
      if (!m) continue;
      let v = m[2] ?? "";
      if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { /* keep raw */ } }
      out.set(m[1]!, v);
    }
  } catch { /* no env file */ }
  return out;
}

const STEPS = [
  'Rotate or revoke it. If it was in git history (flag above), moving it does not un-leak it.',
  'Put the new value in your real secret store, then delete its line from `.env.hewtd`.',
  'Optionally purge history with `git filter-repo`; forks, clones and caches keep a copy.',
  'Reindex any search tool built from the docs.',
];

export async function buildSecretsReport(opts: {
  root: string; docsPath: string; findings: SecretFinding[]; ledger?: Ledger; cfg: SecretsConfig; date?: string;
}): Promise<{ entries: ReportEntry[]; text: string }> {
  const { root, docsPath, cfg } = opts;
  const entries: ReportEntry[] = [];
  const locate = (file: string): string | undefined => [join(docsPath, file), join(root, file)].find((p) => existsSync(p));
  const wanted = new Map<string, Map<string, ReportEntry>>(); // repo path -> value -> entry (values stay in memory)
  const want = (path: string, value: string, e: ReportEntry): void => {
    if (!wanted.has(path)) wanted.set(path, new Map());
    wanted.get(path)!.set(value, e);
  };
  const rel = (abs: string): string => abs.slice(root.length + 1);

  const byFile = new Map<string, SecretFinding[]>();
  for (const f of opts.findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  for (const [file, fs] of byFile) {
    const abs = locate(file);
    const raws = abs ? findSecrets(await readFile(abs, 'utf-8'), file, cfg) : [];
    for (const f of fs) {
      const e: ReportEntry = { rule: f.rule, file: f.file, line: f.line, masked: f.masked, fingerprint: f.fingerprint, kind: f.kind, status: 'pending' };
      entries.push(e);
      const raw = raws.find((r) => r.finding.fingerprint === f.fingerprint);
      if (raw && abs && f.kind === 'secret') want(rel(abs), raw.value, e);
    }
  }
  const env = await readEnv(root);
  for (const le of Object.values(opts.ledger?.entries ?? {})) {
    for (const name of le.env_names ?? []) {
      const v = env.get(name);
      const e: ReportEntry = { rule: 'moved', file: le.path, masked: v ? mask(v) : '(removed from .env.hewtd)', fingerprint: v ? fingerprint(v) : '', kind: 'secret', status: 'moved', env: name };
      entries.push(e);
      const abs = locate(le.path);
      if (v && abs) want(rel(abs), v, e);
    }
  }
  for (const [path, vals] of wanted) {
    const hit = await valuesInHistory(root, path, [...vals.keys()]);
    for (const [v, e] of vals) e.inHistory = hit.has(v);
  }

  const secrets = entries.filter((e) => e.kind === 'secret');
  const personal = entries.filter((e) => e.kind === 'personal');
  const L: string[] = [`# Secrets report ${opts.date ?? new Date().toISOString().slice(0, 10)}`, '', 'Values are never shown: masked as first 4 characters and length, plus a hash prefix.', ''];
  L.push(`## Secrets (${secrets.length})`, '');
  if (!secrets.length) L.push('None found.', '');
  for (const e of secrets) {
    const hist = e.inHistory === undefined ? 'unknown' : e.inHistory ? 'yes' : 'no';
    L.push(`- \`${e.rule}\` ${e.file}${e.line ? `:${e.line}` : ''} ${e.masked} (${e.fingerprint.slice(0, 12)}) - in git history: ${hist} - status: ${e.status}${e.env ? ` (${e.env})` : ''}`);
  }
  if (secrets.length) L.push('', '### Next steps, for each secret above', '', ...STEPS.map((s, i) => `${i + 1}. ${s}`), '');
  if (personal.length) {
    L.push(`## Personal data, review only (${personal.length})`, '', 'Never moved to `.env.hewtd`. Decide per item whether it belongs in the docs.', '');
    for (const e of personal) L.push(`- \`${e.rule}\` ${e.file}:${e.line} ${e.masked} (${e.fingerprint.slice(0, 12)})`);
    L.push('');
  }
  const text = L.join('\n');
  assertNoSecrets(text, 'the secrets report', cfg);
  return { entries, text };
}

export async function writeSecretsReport(root: string, text: string, date = new Date().toISOString().slice(0, 10)): Promise<string> {
  const file = join(root, '.hewtd/reconcile', `secrets-report-${date}.md`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}
