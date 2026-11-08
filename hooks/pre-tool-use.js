#!/usr/bin/env node
// hit-em-with-the-docs PreToolUse hook — lifecycle enforcement.
//
// Denies the two irreversible policy violations (hand-editing a generated
// INDEX.md/REGISTRY.md, deleting a doc) and warns on the off-policy ones.
//
// This runs in EVERY session the plugin is installed in, including repos that
// have nothing to do with hewtd. Two invariants follow, and they matter more
// than any rule this file enforces:
//
//   1. No `.documentation/` tree (or whatever `docsDir` resolves to) → allow,
//      immediately and silently.
//   2. ANY error → allow. A guard that blocks a user's unrelated work because
//      it threw is far worse than no guard at all. Every path fails open.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Allow the call and exit. Never throws, never blocks. */
function allow() {
  process.exit(0);
}

function respond(payload) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', ...payload },
    })
  );
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Resolve the docs root and the enforcement policy for this project.
 * `.claude/hit-em-with-the-docs.json` may carry an `enforcement` block; a
 * missing or malformed config just means defaults.
 */
function loadProject(cwd) {
  let policy = { blockIndexEdits: true, blockDocDeletion: true };
  try {
    const raw = readFileSync(join(cwd, '.claude', 'hit-em-with-the-docs.json'), 'utf-8');
    const cfg = JSON.parse(raw);
    const e = cfg?.enforcement;
    if (e && typeof e === 'object') {
      if (e.block_index_edits === false) policy.blockIndexEdits = false;
      if (e.block_doc_deletion === false) policy.blockDocDeletion = false;
    }
  } catch {
    // No config, or unreadable — defaults apply.
  }
  return { docsDir: '.documentation', policy };
}

async function main() {
  const input = await readStdin();
  if (!input.trim()) allow();

  const payload = JSON.parse(input);
  const cwd = payload.cwd || process.cwd();

  // Invariant 1: not a hewtd project → this hook has no opinion.
  if (!existsSync(resolve(cwd, '.documentation'))) allow();

  const { docsDir, policy } = loadProject(cwd);

  // The decision function ships compiled in dist/, so the hook stays a thin
  // I/O shell and the rules themselves are unit-testable.
  const { evaluate } = await import('../dist/core/enforce/guard.js');

  // The active domain ids decide which INDEX.md files hewtd actually generates.
  // Reading them is I/O (the registry merges built-ins with this project's config),
  // which is why the guard takes them as input rather than importing the registry:
  // guard.ts stays pure and unit-testable. If this fails for any reason the guard
  // falls back to "one segment below the docs root", which is right for every
  // single-segment domain id.
  let domains;
  try {
    const registry = await import('../dist/core/domains/registry.js');
    // Seed the lazy registry with THIS project's root: the hook's cwd comes from the
    // payload and is not necessarily process.cwd(), which is what get_registry()
    // defaults to. Getting that wrong would read another project's custom domains.
    registry.get_registry(cwd);
    domains = registry.get_all_domains();
  } catch {
    domains = undefined;
  }

  const toolInput = payload.tool_input ?? {};
  const decision = evaluate(
    {
      toolName: payload.tool_name,
      filePath: toolInput.file_path,
      command: toolInput.command,
      text: toolInput.content ?? toolInput.new_string,
      docsDir,
      domains,
    },
    policy
  );

  if (decision.action === 'deny') {
    respond({ permissionDecision: 'deny', permissionDecisionReason: decision.reason });
  }
  if (decision.action === 'warn') {
    respond({ permissionDecision: 'allow', additionalContext: decision.context });
  }
  allow();
}

// Invariant 2: fail open, unconditionally.
main().catch(() => allow());
