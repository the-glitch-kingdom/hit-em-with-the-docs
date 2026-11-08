/**
 * Lifecycle enforcement — the decision function behind the PreToolUse hook.
 *
 * hewtd's lifecycle policy has always been enforced at the CLI boundary (the
 * archive link guard, `auto: false`, the frontmatter schema). None of that
 * binds an *agent*, which will happily `rm` a doc, hand-edit a generated
 * INDEX.md, or invent its own `docs/` folder. This is the part the model
 * cannot reason its way past: the harness runs it, and a `deny` is final.
 *
 * Two rules deny, because they destroy work or corrupt a generated artifact.
 * Everything else at most warns. Anything unrecognized is allowed — this runs
 * in every session the plugin is installed in, including repos that have
 * nothing to do with hewtd, so the cost of a false positive is far higher
 * than the cost of a miss.
 */

import { basename } from 'path';

/** Basenames hewtd uses for the files it generates. NOT sufficient on its own — see
 *  `isGeneratedIndex`, which also has to decide whether hewtd writes THIS one. */
const GENERATED_FILES = new Set(['INDEX.md', 'REGISTRY.md']);

export type GuardDecision =
  | { action: 'allow' }
  | { action: 'warn'; context: string }
  | { action: 'deny'; reason: string };

export interface GuardInput {
  toolName: string;
  /** `file_path` for Write/Edit. */
  filePath?: string;
  /** `command` for Bash. */
  command?: string;
  /** `content` (Write) or `new_string` (Edit) — used to spot lifecycle changes. */
  text?: string;
  /** Docs root relative to the project, e.g. `.documentation`. */
  docsDir: string;
  /**
   * Active domain ids (`getAllDomains()`), supplied by the hook because reading
   * them is I/O and this function is pure.
   *
   * Optional: when absent the rule falls back to "one path segment below the docs
   * root", which is correct for every single-segment domain id — i.e. all of the
   * built-ins. Passing the real list additionally handles a custom domain whose id
   * contains a slash.
   */
  domains?: readonly string[];
}

/** Which enforcement rules are active. Both default on; users can opt out. */
export interface EnforcementPolicy {
  blockIndexEdits: boolean;
  blockDocDeletion: boolean;
}

export const DEFAULT_ENFORCEMENT: EnforcementPolicy = {
  blockIndexEdits: true,
  blockDocDeletion: true,
};

/** Posix-normalized, leading-`./`-stripped path for matching. */
function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Is this path inside an `archive/` folder, at any depth?
 *
 * Archived docs are **referenceable but never concrete** — history you may cite,
 * never evidence of what is true now. Nothing under an `archive/` folder is
 * indexed, audited, link-checked, or validated.
 */
export function is_archived(path: string): boolean {
  return normalize(path)
    .split('/')
    .some((segment) => segment === 'archive');
}

/** Is this path inside the documentation tree? */
function in_docs_tree(path: string, docs_dir: string): boolean {
  const p = normalize(path);
  const d = normalize(docs_dir);
  return p === d || p.includes(`/${d}/`) || p.startsWith(`${d}/`);
}

/**
 * Commands that destroy a file. `mv` is deliberately absent: moving a doc is how
 * `archive` itself works (via `git mv`), and a hand-rolled move is a warn, not a
 * denial — it loses the frontmatter stamping, but loses nothing.
 */
const DESTRUCTIVE_WORDS = new Set(['rm', 'unlink', 'shred']);

/**
 * Top-level folders under the docs root that are NOT published documentation.
 *
 * Not a new policy — the auditor already exempts exactly these from domain-folder
 * validation (`core/audit/rules.ts`). `reports/` is hewtd's own generated output
 * and `drafts/` is scratch space; deleting either destroys nothing that `archive`
 * was built to preserve, so the deletion guard has no business refusing it.
 */
const UNPUBLISHED_DIRS = new Set(['drafts', 'reports']);

/** Markdown paths under the docs tree that a string names. */
function markdown_targets(text: string, docs_dir: string): string[] {
  const d = normalize(docs_dir);
  const re = new RegExp(`[^\\s'"\`;&|]*${d}/[^\\s'"\`;&|]*\\.md`, 'g');
  return text.match(re) ?? [];
}

/** Is this docs path published documentation, rather than scratch or generated output? */
function is_published_doc(path: string, docs_dir: string): boolean {
  const rel = relative_to_docs(path, docs_dir);
  if (rel === null) return false;
  const top = rel.split('/')[0] ?? '';
  return !UNPUBLISHED_DIRS.has(top);
}

/**
 * Remove heredoc bodies from a command.
 *
 * A heredoc body is *data* — the shell never executes it as a command. Scanning
 * it is what let a commit message, an issue body, or a PR description be denied
 * for quoting a deletion in prose (#21, #26). Filing a bug report about this
 * guard was itself blocked by this guard.
 *
 * Only the body is dropped; the command line that opens it is kept, so
 * `git commit -F - <<'MSG'` still reads as `git commit -F -`.
 */
function strip_heredoc_bodies(command: string): string {
  const lines = command.split('\n');
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    kept.push(line);

    const opener = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (!opener) continue;

    // Skip to the terminator line (and drop it too). An unterminated heredoc
    // swallows the rest, which is the correct reading — it is all body.
    const tag = opener[2];
    i++;
    while (i < lines.length && lines[i]!.trim() !== tag) i++;
  }

  return kept.join('\n');
}

/** Split a command line into segments the shell would run independently. */
function shell_segments(command: string): string[] {
  return command.split(/[;&|\n()]+/);
}

/**
 * Does this segment invoke a command that deletes files from disk, and if so
 * what are its operands?
 *
 * Requires the destructive word to be at *command position* — the first word of
 * a segment, past any `sudo` or `VAR=value` prefixes. "Contains `rm` somewhere"
 * was the old test, and it is why `rm /tmp/x.md && echo <docs path>` was denied:
 * an unrelated deletion and an unrelated docs path in one line read as a docs
 * deletion.
 *
 * Known ceiling: a deletion smuggled through another command's arguments —
 * `find <docs> -exec rm {} +`, `xargs rm` — is not matched. That is a deliberate
 * miss, per this module's header: a guard that fires on correct operations is
 * one people learn to route around, and a routed-around guard protects nothing.
 */
function file_deletion_operands(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);

  let i = 0;
  while (i < tokens.length && (tokens[i] === 'sudo' || /^\w+=/.test(tokens[i]!))) i++;
  const word = tokens[i];
  if (!word) return null;

  if (DESTRUCTIVE_WORDS.has(word)) {
    return tokens.slice(i + 1).join(' ');
  }

  if (word === 'git') {
    const rest = tokens.slice(i + 1);
    const sub = rest.find((t) => !t.startsWith('-'));
    if (sub !== 'rm') return null;

    // `git rm --cached` unstages and leaves every file on disk. It is the
    // documented way to untrack something you are keeping — an index operation,
    // not a deletion, and nothing `hewtd archive` can substitute for.
    if (rest.includes('--cached')) return null;

    return rest.slice(rest.indexOf('rm') + 1).join(' ');
  }

  return null;
}

/**
 * Published docs a command would actually delete from disk.
 *
 * Structural, not textual: the path must be an operand of a deletion at command
 * position, outside any heredoc body.
 */
function deletion_targets(command: string, docs_dir: string): string[] {
  const targets: string[] = [];

  for (const segment of shell_segments(strip_heredoc_bodies(command))) {
    const operands = file_deletion_operands(segment);
    if (operands === null) continue;
    for (const path of markdown_targets(operands, docs_dir)) {
      if (is_published_doc(path, docs_dir)) targets.push(path);
    }
  }

  return targets;
}

/**
 * Does this command open or merge a pull request (`gh pr create` / `gh pr merge`)?
 * Matched at command position outside heredoc bodies, like deletions, so a PR
 * body or commit message that mentions these commands does not count.
 */
function opens_or_merges_pr(command: string): boolean {
  return shell_segments(strip_heredoc_bodies(command)).some((segment) =>
    /^\s*(?:sudo\s+)?(?:\w+=\S*\s+)*gh\s+pr\s+(?:create|merge)\b/.test(segment)
  );
}

/** Does this text set `status: deprecated` in frontmatter? */
function sets_deprecated(text: string): boolean {
  return /^\s*status:\s*['"]?deprecated['"]?\s*$/m.test(text);
}

/**
 * The path of `filePath` relative to the docs root, or null if it is outside.
 * Mirrors `inDocsTree`, which accepts a repo-relative or an absolute path.
 */
function relative_to_docs(path: string, docs_dir: string): string | null {
  const p = normalize(path);
  const d = normalize(docs_dir);
  if (p.startsWith(`${d}/`)) return p.slice(d.length + 1);
  const marker = p.indexOf(`/${d}/`);
  if (marker !== -1) return p.slice(marker + d.length + 2);
  return null;
}

/**
 * Does hewtd actually generate this file?
 *
 * The name alone does NOT answer that, and assuming it did was a real defect: the
 * guard denied every `INDEX.md` under the docs tree, including the hand-written
 * sub-feature indexes hewtd has never written. Those pages became uneditable —
 * frozen with whatever staleness they carried, since the deny is final and the
 * "run `hewtd index`" advice it offered did nothing to them.
 *
 * hewtd writes exactly two shapes (`core/maintain/orchestrator.ts` builds every
 * path as `join(docsPath, domain)`):
 *
 *     <docs>/INDEX.md            <docs>/REGISTRY.md
 *     <docs>/<domain>/INDEX.md   <docs>/<domain>/REGISTRY.md
 *
 * Anything deeper — `<docs>/features/tiers/INDEX.md` — is prose that merely shares
 * the name, and is the author's to edit.
 */
function is_generated_index(
  file_path: string,
  docs_dir: string,
  domains?: readonly string[]
): boolean {
  const rel = relative_to_docs(file_path, docs_dir);
  return rel !== null && is_generated_index_rel(rel, domains);
}

/**
 * `isGeneratedIndex` for a path already relative to the docs root. Exported for
 * the archive link guard, whose link graph is docs-relative (#39).
 */
export function is_generated_index_rel(docs_rel_path: string, domains?: readonly string[]): boolean {
  const rel = normalize(docs_rel_path);
  if (!GENERATED_FILES.has(basename(rel))) return false;

  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  if (dir === '') return true; // <docs>/INDEX.md — the root index
  return domains ? domains.includes(dir) : !dir.includes('/');
}

/**
 * Decide what to do about one tool call. Pure — all I/O lives in the hook.
 */
export function evaluate(
  input: GuardInput,
  policy: EnforcementPolicy = DEFAULT_ENFORCEMENT
): GuardDecision {
  const { toolName: tool_name, filePath: file_path, command, text, docsDir: docs_dir, domains } = input;

  // ---- Write / Edit -------------------------------------------------------
  if ((tool_name === 'Write' || tool_name === 'Edit') && file_path) {
    const in_tree = in_docs_tree(file_path, docs_dir);

    // DENY: a generated index is not a document. Editing it by hand is either
    // pointless (the next `hewtd index` overwrites it) or actively harmful
    // (it is how people ended up hand-curating rows the indexer then deleted
    // — see issue #12).
    if (policy.blockIndexEdits && in_tree && is_generated_index(file_path, docs_dir, domains)) {
      return {
        action: 'deny',
        reason:
          `${basename(file_path)} is a generated artifact, rebuilt from the documents ` +
          `on disk. Hand-edits are overwritten by the next \`hewtd index\` or ` +
          `\`hewtd maintain\`. To change what it lists, change the documents — then ` +
          `run \`hewtd index\`.`,
      };
    }

    // WARN: a doc outside the tree is invisible to every hewtd scan. Scoped to
    // markdown that is plausibly *documentation* — a rival `docs/` folder, or a
    // loose doc at the repo root. Warning on every .md anywhere (a fixture, a
    // subpackage README, a website's own docs) would be noise, and a noisy
    // guard is one people switch off.
    if (!in_tree && looks_like_stray_doc(file_path)) {
      return {
        action: 'warn',
        context:
          `This project manages its documentation with hit-em-with-the-docs, under ` +
          `\`${docs_dir}/\`. A markdown file outside that tree is not indexed, ` +
          `link-checked, or metadata-validated. \`hewtd integrate <file>\` classifies ` +
          `a doc into a domain and registers it.`,
      };
    }

    // WARN: archived content is historical. Editing it is not destructive —
    // hence a warn, not a denial — but it is almost always a mistake: the edit
    // lands in a subtree that no scan reads and no index lists, so it changes
    // nothing anyone will see.
    if (in_tree && is_archived(file_path)) {
      return {
        action: 'warn',
        context:
          `This file is under an \`archive/\` folder. Archived documentation is ` +
          `historical: it is excluded from every hewtd scan — not indexed, not ` +
          `audited, not link-checked, not validated — and describes what the docs ` +
          `used to say, not what is true now. It can be referenced, but it is never ` +
          `evidence of current behavior. \`hewtd unarchive <file>\` restores it to ` +
          `its domain as an active document.`,
      };
    }

    // WARN: `status: deprecated` flags intent but leaves the doc live and
    // indexed. Archiving is the separate step that actually retires it.
    if (in_tree && text && sets_deprecated(text)) {
      return {
        action: 'warn',
        context:
          `\`status: deprecated\` marks intent but leaves the document in its domain ` +
          `folder, still indexed and still scanned. \`hewtd archive <file>\` retires ` +
          `it: the move is reversible (\`archived_from\` records the origin) and ` +
          `link-safe (it refuses if active docs still link to it).`,
      };
    }

    return { action: 'allow' };
  }

  // ---- Bash ---------------------------------------------------------------
  if (tool_name === 'Bash' && command) {
    const targets = deletion_targets(command, docs_dir);

    // DENY: deleting a doc is the one truly irreversible act, and hewtd has a
    // purpose-built, reversible, link-safe alternative. This is the whole
    // reason the plugin never calls rm/unlink anywhere in its own source.
    if (policy.blockDocDeletion && targets.length > 0) {
      return {
        action: 'deny',
        reason:
          `Deleting documentation is destructive and hewtd never does it. ` +
          `\`hewtd archive ${targets[0]}\` retires a doc instead: it moves the file ` +
          `under \`archive/\` (preserving git history), stamps \`archived_from\` so ` +
          `\`hewtd unarchive\` can restore it exactly, and refuses if active docs ` +
          `still link to it. Use \`--force\` there to override the link guard.`,
      };
    }

    // WARN: a hand-rolled move into archive/ skips the frontmatter stamping,
    // so `unarchive` has no `archived_from` to restore from.
    const executable = strip_heredoc_bodies(command);
    if (/(^|[\s;&|(])(mv|git\s+mv)\s/.test(executable) && /archive\//.test(executable)) {
      return {
        action: 'warn',
        context:
          `Moving a doc into \`archive/\` by hand skips the lifecycle stamping. ` +
          `\`hewtd archive <file>\` records \`archived_on\`, \`archived_from\`, and ` +
          `\`archived_reason\`, which is what makes \`hewtd unarchive\` lossless; a ` +
          `plain move leaves nothing to restore from.`,
      };
    }

    // WARN: the session brief says gotchas found during the work are recorded as
    // knowledge-base facts before merge. Read at session start, that is weakest at
    // the end of a long session — so it is repeated at the moment it applies.
    if (opens_or_merges_pr(command)) {
      return {
        action: 'warn',
        context:
          `Before a PR merges, gotchas found during the work belong in the knowledge ` +
          `base: a non-obvious failure with an observed fix is a fact under the vault's ` +
          `\`facts/\` folder (default \`${docs_dir}/knowledge-base/facts/\`, template ` +
          `\`fact.template.md\`), tagged \`gotcha\`, with an \`## Instead\` section. ` +
          `Typos and simple wrong paths are not gotchas.`,
      };
    }

    return { action: 'allow' };
  }

  return { action: 'allow' };
}

/** A repo's own top-level markdown — never documentation-tree content. */
const PROJECT_FILES = new Set([
  'README.MD',
  'CHANGELOG.MD',
  'CONTRIBUTING.MD',
  'LICENSE.MD',
  'CLAUDE.MD',
  'AGENTS.MD',
  'SECURITY.MD',
  'CODE_OF_CONDUCT.MD',
]);

/** Folder names that mean "somebody is starting a rival documentation tree". */
const RIVAL_DOC_DIRS = new Set(['docs', 'doc', 'documentation', 'wiki', 'guides']);

/**
 * Is this markdown a *stray document* — something that ought to have gone
 * through `integrate`?
 *
 * Deliberately narrow. It catches the real failure mode (an agent creating
 * `docs/how-it-works.md` in a repo that already has a managed tree, or dropping
 * a loose doc at the root) and stays silent on markdown that is obviously not
 * documentation: source fixtures, subpackage READMEs, a website's own content,
 * agent scaffolding. Anything it misses is merely un-nagged; anything it
 * over-claims is a papercut on every unrelated file the user writes.
 */
function looks_like_stray_doc(file_path: string): boolean {
  const p = normalize(file_path);
  if (!p.endsWith('.md')) return false;

  const segments = p.split('/');
  const name = basename(p).toUpperCase();

  // Agent/tooling scaffolding and dependencies are never docs.
  if (segments.some((s) => s === 'node_modules' || s === '.planning' || s === '.claude')) {
    return false;
  }

  // A rival docs folder anywhere in the path.
  if (segments.slice(0, -1).some((s) => RIVAL_DOC_DIRS.has(s.toLowerCase()))) {
    return true;
  }

  // A loose doc sitting at the repo root that isn't one of the standard
  // project files.
  if (segments.length === 1 && !PROJECT_FILES.has(name)) return true;

  return false;
}
