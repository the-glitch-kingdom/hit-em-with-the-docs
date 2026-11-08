/**
 * Stale-fact detection + verify-command execution (2.3.0 PR3).
 *
 * `auditFacts()` is the writer side of `hewtd audit-facts` — pure-data,
 * easy to unit-test with date injection. `runFactVerify()` actually
 * shells out and updates `last_verified` on success.
 *
 * Working-dir resolution (locked in during planning):
 *   - Default: `<vault-root>/facts/`
 *   - Override: a fact's optional `working_dir:` frontmatter field
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { resolve } from 'path';
import matter from 'gray-matter';
import type { FactRef, CiterIndex } from './citers.js';

export interface StaleFact {
  id: string;
  path: string;
  relPath: string;
  title: string;
  confidence: string | undefined;
  lastVerified: string;
  daysSinceVerified: number;
}

export interface AuditFactsOptions {
  index: CiterIndex;
  /** Reference date for "now". Defaults to today. Tests inject a fixed date. */
  now?: Date;
  /** Stale threshold in days. Defaults to 90. */
  audit_window_days?: number;
}

export interface AuditFactsResult {
  stale: StaleFact[];
  /** Facts whose last_verified is malformed or absent. Reported but not "stale". */
  unverifiable: FactRef[];
}

export function audit_facts(options: AuditFactsOptions): AuditFactsResult {
  const { index, now = new Date(), audit_window_days = 90 } = options;
  const cutoff_ms = now.getTime() - audit_window_days * 24 * 60 * 60 * 1000;

  const stale: StaleFact[] = [];
  const unverifiable: FactRef[] = [];

  for (const fact of index.facts.values()) {
    if (!fact.lastVerified) {
      unverifiable.push(fact);
      continue;
    }
    const verified_ms = new Date(`${fact.lastVerified}T00:00:00Z`).getTime();
    if (Number.isNaN(verified_ms)) {
      unverifiable.push(fact);
      continue;
    }
    if (verified_ms < cutoff_ms) {
      const days_since_verified = Math.floor(
        (now.getTime() - verified_ms) / (24 * 60 * 60 * 1000)
      );
      stale.push({
        id: fact.id,
        path: fact.path,
        relPath: fact.relPath,
        title: fact.title,
        confidence: fact.confidence,
        lastVerified: fact.lastVerified,
        daysSinceVerified: days_since_verified,
      });
    }
  }

  // Deterministic order: by daysSinceVerified desc (oldest first), id asc.
  stale.sort((a, b) => {
    if (a.daysSinceVerified !== b.daysSinceVerified) {
      return b.daysSinceVerified - a.daysSinceVerified;
    }
    return a.id.localeCompare(b.id);
  });
  unverifiable.sort((a, b) => a.id.localeCompare(b.id));

  return { stale, unverifiable };
}

export interface RunVerifyOptions {
  fact: FactRef;
  /** Absolute vault root (used to compute default CWD). */
  vault_root: string;
  /** Override CWD (test seam). */
  cwd_override?: string;
  /** Inject a fake date for the `last_verified` rewrite. */
  now?: Date;
  /** Skip the actual shell-out (test seam). Returns success without running. */
  skip_exec?: boolean;
}

export interface RunVerifyResult {
  factId: string;
  executed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True iff the fact's `last_verified` was updated. */
  updated: boolean;
  /** YYYY-MM-DD that was written. */
  newLastVerified: string | undefined;
}

/**
 * Execute a fact's `verify_command` and update `last_verified` on success.
 * Returns a typed result describing what happened.
 *
 * The verify command runs in a child shell (bash via `-c`). CWD resolution:
 *   1. `cwdOverride` (test seam)
 *   2. Fact's frontmatter `working_dir:` field, resolved relative to vaultRoot
 *   3. `<vaultRoot>/facts/` default
 */
export async function run_fact_verify(
  options: RunVerifyOptions
): Promise<RunVerifyResult> {
  const { fact, vault_root, cwd_override, now = new Date(), skip_exec = false } = options;

  // Read the fact file fresh — we need the full frontmatter (verify_command,
  // working_dir) which isn't in the lightweight CiterIndex FactRef.
  const fact_content = await readFile(fact.path, 'utf-8');
  const parsed = matter(fact_content);
  const verify_command = parsed.data.verify_command;
  const working_dir = parsed.data.working_dir;

  if (typeof verify_command !== 'string' || verify_command.trim().length === 0) {
    return {
      factId: fact.id,
      executed: false,
      exitCode: null,
      stdout: '',
      stderr: 'no verify_command defined',
      updated: false,
      newLastVerified: undefined,
    };
  }

  const cwd =
    cwd_override ??
    (typeof working_dir === 'string'
      ? resolve(vault_root, working_dir)
      : resolve(vault_root, 'facts'));

  if (skip_exec) {
    return finalize({
      success: true,
      exit_code: 0,
      stdout: '[skipExec=true]',
      stderr: '',
    });
  }

  const result = await exec_shell(verify_command, cwd);
  return finalize(result);

  async function finalize(r: {
    success: boolean;
    exit_code: number;
    stdout: string;
    stderr: string;
  }): Promise<RunVerifyResult> {
    if (!r.success) {
      return {
        factId: fact.id,
        executed: true,
        exitCode: r.exit_code,
        stdout: r.stdout,
        stderr: r.stderr,
        updated: false,
        newLastVerified: undefined,
      };
    }
    const new_date = now.toISOString().slice(0, 10);
    parsed.data.last_verified = new_date;
    const rewritten = matter.stringify(parsed.content, parsed.data);
    await writeFile(fact.path, rewritten, 'utf-8');
    return {
      factId: fact.id,
      executed: true,
      exitCode: r.exit_code,
      stdout: r.stdout,
      stderr: r.stderr,
      updated: true,
      newLastVerified: new_date,
    };
  }
}

interface ShellResult {
  success: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
}

function exec_shell(command: string, cwd: string): Promise<ShellResult> {
  return new Promise((resolve_promise) => {
    if (!existsSync(cwd)) {
      resolve_promise({
        success: false,
        exit_code: -1,
        stdout: '',
        stderr: `working dir does not exist: ${cwd}`,
      });
      return;
    }

    const child = spawn('bash', ['-c', command], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('close', (code) => {
      resolve_promise({
        success: code === 0,
        exit_code: code ?? -1,
        stdout,
        stderr,
      });
    });
    child.on('error', (err) => {
      resolve_promise({
        success: false,
        exit_code: -1,
        stdout: '',
        stderr: err.message,
      });
    });
  });
}
