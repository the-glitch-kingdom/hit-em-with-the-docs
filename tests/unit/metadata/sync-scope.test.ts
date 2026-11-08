/**
 * `metadata-sync --fix` writes frontmatter into every markdown file it finds,
 * and `--path` accepts any directory. Aimed at a source tree it rewrote
 * unrelated markdown across a whole repo (#25) — infrastructure notes, test
 * fixtures, loose READMEs — stamping 16 lines of hewtd metadata onto files that
 * are not documentation.
 *
 * These tests pin the scope: writes require a documentation root, reads do not.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { sync_metadata } from '../../../src/core/metadata/sync.js';
import { reset_registry } from '../../../src/core/domains/registry.js';

const DOC = [
  '---',
  'title: A',
  'tier: guide',
  'domains: [api]',
  'status: active',
  'last_updated: 2026-01-01',
  'version: 1.0.0',
  '---',
  '# A',
  'body',
  '',
].join('\n');

const NON_DOC = '# Firewall setup\n\nrules here\n';

describe('metadata-sync scope (#25)', () => {
  let root: string;

  beforeEach(async () => {
    reset_registry();
    root = await mkdtemp(join(tmpdir(), 'hewtd-sync-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    reset_registry();
  });

  /** A source tree with markdown that is NOT documentation. */
  async function source_tree(): Promise<string> {
    await mkdir(join(root, 'infrastructure', 'vault'), { recursive: true });
    await mkdir(join(root, 'frontend', 'tests'), { recursive: true });
    await writeFile(join(root, 'infrastructure', 'vault', 'SETUP.md'), NON_DOC, 'utf-8');
    await writeFile(join(root, 'frontend', 'tests', 'notes.md'), NON_DOC, 'utf-8');
    await writeFile(join(root, 'LOOSE.md'), NON_DOC, 'utf-8');
    return root;
  }

  /** A scaffolded documentation root. */
  async function docs_tree(): Promise<string> {
    const docs = join(root, '.documentation');
    await mkdir(join(docs, 'api'), { recursive: true });
    await writeFile(join(docs, 'INDEX.md'), '# Index\n', 'utf-8');
    await writeFile(join(docs, 'api', 'a.md'), DOC, 'utf-8');
    return docs;
  }

  it('refuses to --fix a directory that is not a documentation root', async () => {
    const src = await source_tree();
    const result = await sync_metadata({ docs_path: src, fix: true, silent: true });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain("outside this project's documentation root");
    expect(result.fixed_files).toBe(0);
  });

  it('leaves every non-documentation file byte-identical', async () => {
    const src = await source_tree();
    const before = await Promise.all(
      ['infrastructure/vault/SETUP.md', 'frontend/tests/notes.md', 'LOOSE.md'].map((p) =>
        readFile(join(src, p), 'utf-8')
      )
    );

    await sync_metadata({ docs_path: src, fix: true, silent: true });

    const after = await Promise.all(
      ['infrastructure/vault/SETUP.md', 'frontend/tests/notes.md', 'LOOSE.md'].map((p) =>
        readFile(join(src, p), 'utf-8')
      )
    );
    expect(after).toEqual(before);
    for (const content of after) {
      expect(content).not.toContain('estimated_read_time');
    }
  });

  it('still scans a non-documentation directory read-only', async () => {
    // Reads write nothing, and inspecting an unmanaged directory is useful.
    const src = await source_tree();
    const result = await sync_metadata({ docs_path: src, fix: false, silent: true });

    expect(result.total_files).toBe(3);
    expect(result.errors.every((e) => !e.error.includes('documentation root'))).toBe(true);
  });

  it('allows --dry-run anywhere, so the preview of --fix still works', async () => {
    const src = await source_tree();
    const before = await readFile(join(src, 'LOOSE.md'), 'utf-8');

    const result = await sync_metadata({ docs_path: src, fix: true, dry_run: true, silent: true });

    expect(result.errors).toHaveLength(0);
    expect(await readFile(join(src, 'LOOSE.md'), 'utf-8')).toBe(before);
  });

  it('fixes normally inside a scaffolded documentation root', async () => {
    const docs = await docs_tree();
    const result = await sync_metadata({ docs_path: docs, fix: true, silent: true });

    expect(result.errors).toHaveLength(0);
    expect(result.fixed_files).toBeGreaterThan(0);
  });

  it('accepts the declared docs root even with no INDEX.md yet', async () => {
    // `maintain` syncs at Step 1 and regenerates indexes at Step 1.5, so
    // demanding INDEX.md would fire on a legitimate first run.
    const docs = join(root, '.documentation');
    await mkdir(join(docs, 'api'), { recursive: true });
    await writeFile(join(docs, 'api', 'a.md'), DOC, 'utf-8');

    // `root` is the project; `.documentation` is its DECLARED docs root, so this
    // is allowed on its declaration alone — no INDEX.md and no content sniffing.
    const result = await sync_metadata({
      docs_path: docs,
      project_root: root,
      fix: true,
      silent: true,
    });
    expect(result.errors).toHaveLength(0);
  });

  it('refuses a repo root that merely CONTAINS domain-named folders', async () => {
    // The hole in the first cut of this fix. Deciding by content sniff — "does
    // this look like a docs tree?" — any repository with a top-level `api/` or
    // `testing/` satisfied by accident. Deciding by declaration does not.
    await mkdir(join(root, 'api'), { recursive: true });
    await mkdir(join(root, 'testing'), { recursive: true });
    await writeFile(join(root, 'api', 'spec.md'), NON_DOC, 'utf-8');
    await writeFile(join(root, 'LOOSE.md'), NON_DOC, 'utf-8');

    const result = await sync_metadata({
      docs_path: root,
      project_root: root,
      fix: true,
      silent: true,
    });

    expect(result.errors[0]!.error).toContain("outside this project's documentation root");
    expect(await readFile(join(root, 'LOOSE.md'), 'utf-8')).toBe(NON_DOC);
    expect(await readFile(join(root, 'api', 'spec.md'), 'utf-8')).toBe(NON_DOC);
  });

  it('honors a docs_root declared in config', async () => {
    await mkdir(join(root, '.claude'), { recursive: true });
    await writeFile(
      join(root, '.claude', 'hit-em-with-the-docs.json'),
      JSON.stringify({ docs_root: 'mydocs' }),
      'utf-8'
    );
    await mkdir(join(root, 'mydocs', 'api'), { recursive: true });
    await writeFile(join(root, 'mydocs', 'api', 'a.md'), DOC, 'utf-8');

    const result = await sync_metadata({
      docs_path: join(root, 'mydocs'),
      project_root: root,
      fix: true,
      silent: true,
    });
    expect(result.errors).toHaveLength(0);
  });

  it('allows a subdirectory of the declared root', async () => {
    const docs = join(root, '.documentation');
    await mkdir(join(docs, 'api'), { recursive: true });
    await writeFile(join(docs, 'api', 'a.md'), DOC, 'utf-8');

    const result = await sync_metadata({
      docs_path: join(docs, 'api'),
      project_root: root,
      fix: true,
      silent: true,
    });
    expect(result.errors).toHaveLength(0);
  });

  it('does not treat a sibling with the same prefix as inside the root', async () => {
    // `.documentation-backup` must not pass as `.documentation`.
    const sibling = join(root, '.documentation-backup');
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, 'a.md'), NON_DOC, 'utf-8');

    const result = await sync_metadata({
      docs_path: sibling,
      project_root: root,
      fix: true,
      silent: true,
    });
    expect(result.errors[0]!.error).toContain("outside this project's documentation root");
    expect(await readFile(join(sibling, 'a.md'), 'utf-8')).toBe(NON_DOC);
  });

  it('refuses an empty directory outside the declared root', async () => {
    const empty = join(root, 'empty');
    await mkdir(empty, { recursive: true });

    const result = await sync_metadata({ docs_path: empty, fix: true, silent: true });
    expect(result.errors[0]!.error).toContain("outside this project's documentation root");
  });
});
