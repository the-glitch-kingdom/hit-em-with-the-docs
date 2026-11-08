import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { archive_doc, unarchive_doc } from '../../../src/core/archive/manage.js';
import { reset_registry } from '../../../src/core/domains/registry.js';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const FM = (extra = '') =>
  `---\ntitle: Doc\ntier: reference\ndomains: [api]\nstatus: active\nlast_updated: '2026-01-01'\nversion: '1.0.0'\n${extra}---\n# Doc\n`;

describe('archiveDoc / unarchiveDoc', () => {
  let tmp_dir: string;
  let docs_path: string;

  beforeEach(async () => {
    tmp_dir = await mkdtemp(join(tmpdir(), 'hewtd-archive-mng-'));
    docs_path = join(tmp_dir, '.documentation');
    await mkdir(join(docs_path, 'api'), { recursive: true });
    reset_registry();
  });
  afterEach(async () => {
    reset_registry();
    await rm(tmp_dir, { recursive: true, force: true });
  });

  async function write_doc(rel: string, body = FM()): Promise<void> {
    const abs = join(docs_path, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body, 'utf-8');
  }

  it('moves a doc into archive/<domain>/ and stamps lifecycle metadata (fs fallback)', async () => {
    await write_doc('api/old.md');
    const res = await archive_doc({
      project_root: tmp_dir,
      docs_path,
      file: 'api/old.md',
      reason: 'superseded',
      today: '2026-06-09',
    });
    expect(res.ok).toBe(true);
    expect(res.action).toBe('archived');
    expect(res.move_method).toBe('fs'); // tmpDir is not a git repo
    expect(await exists(join(docs_path, 'archive/api/old.md'))).toBe(true);
    expect(await exists(join(docs_path, 'api/old.md'))).toBe(false);

    const content = await readFile(join(docs_path, 'archive/api/old.md'), 'utf-8');
    expect(content).toMatch(/status: archived/);
    expect(content).toMatch(/archived_on: '?2026-06-09'?/);
    expect(content).toMatch(/archived_from: api\/old\.md/);
    expect(content).toMatch(/archived_reason: superseded/);
  });

  it('drops the doc from its domain INDEX after archiving', async () => {
    await write_doc('api/old.md');
    await archive_doc({ project_root: tmp_dir, docs_path, file: 'api/old.md', today: '2026-06-09' });
    const index = await readFile(join(docs_path, 'api/INDEX.md'), 'utf-8').catch(() => '');
    expect(index).not.toMatch(/old\.md/);
  });

  it('dry-run moves nothing', async () => {
    await write_doc('api/old.md');
    const res = await archive_doc({
      project_root: tmp_dir,
      docs_path,
      file: 'api/old.md',
      dry_run: true,
      today: '2026-06-09',
    });
    expect(res.action).toBe('dry_run');
    expect(await exists(join(docs_path, 'api/old.md'))).toBe(true);
    expect(await exists(join(docs_path, 'archive/api/old.md'))).toBe(false);
  });

  it('blocks when active docs link to the target, unless --force', async () => {
    await write_doc('api/old.md');
    await write_doc('api/live.md', FM().replace('# Doc\n', '# Live\nSee [old](old.md).\n'));

    const blocked = await archive_doc({
      project_root: tmp_dir,
      docs_path,
      file: 'api/old.md',
      today: '2026-06-09',
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.action).toBe('blocked');
    expect(blocked.inbound_links.length).toBeGreaterThan(0);
    expect(blocked.inbound_links[0]!.source).toBe('api/live.md');
    expect(await exists(join(docs_path, 'api/old.md'))).toBe(true); // not moved

    const forced = await archive_doc({
      project_root: tmp_dir,
      docs_path,
      file: 'api/old.md',
      force: true,
      today: '2026-06-09',
    });
    expect(forced.ok).toBe(true);
    expect(await exists(join(docs_path, 'archive/api/old.md'))).toBe(true);
  });

  it('rejects missing files, non-markdown, and already-archived paths', async () => {
    const missing = await archive_doc({ project_root: tmp_dir, docs_path, file: 'api/ghost.md' });
    expect(missing.ok).toBe(false);
    expect(missing.action).toBe('rejected');

    const not_md = await archive_doc({ project_root: tmp_dir, docs_path, file: 'api/x.txt' });
    expect(not_md.ok).toBe(false);

    await write_doc('archive/api/already.md');
    const already = await archive_doc({ project_root: tmp_dir, docs_path, file: 'archive/api/already.md' });
    expect(already.ok).toBe(false);
  });

  it('uses git mv when in a git repo (history-preserving)', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tmp_dir });
    execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: tmp_dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: tmp_dir });
    await write_doc('api/old.md');
    execFileSync('git', ['add', '-A'], { cwd: tmp_dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: tmp_dir });

    const res = await archive_doc({ project_root: tmp_dir, docs_path, file: 'api/old.md', today: '2026-06-09' });
    expect(res.ok).toBe(true);
    expect(res.move_method).toBe('git');
  });

  it('unarchive restores to archived_from and strips the stamp', async () => {
    await write_doc('api/old.md');
    await archive_doc({ project_root: tmp_dir, docs_path, file: 'api/old.md', today: '2026-06-09' });

    const res = await unarchive_doc({ project_root: tmp_dir, docs_path, file: 'archive/api/old.md' });
    expect(res.ok).toBe(true);
    expect(res.action).toBe('unarchived');
    expect(res.to).toBe('api/old.md');
    expect(await exists(join(docs_path, 'api/old.md'))).toBe(true);
    expect(await exists(join(docs_path, 'archive/api/old.md'))).toBe(false);

    const content = await readFile(join(docs_path, 'api/old.md'), 'utf-8');
    expect(content).toMatch(/status: active/);
    expect(content).not.toMatch(/archived_from/);
    expect(content).not.toMatch(/archived_on/);
  });

  it('unarchive rejects a non-archived path and refuses to clobber', async () => {
    const not_archived = await unarchive_doc({ project_root: tmp_dir, docs_path, file: 'api/x.md' });
    expect(not_archived.ok).toBe(false);

    // archive, then recreate the original path → unarchive must refuse to clobber.
    await write_doc('api/old.md');
    await archive_doc({ project_root: tmp_dir, docs_path, file: 'api/old.md', today: '2026-06-09' });
    await write_doc('api/old.md'); // recreate at the restore target
    const clobber = await unarchive_doc({ project_root: tmp_dir, docs_path, file: 'archive/api/old.md' });
    expect(clobber.ok).toBe(false);
    expect(clobber.errors.join(' ')).toMatch(/already exists/i);
  });

  describe('#44', () => {
    const GUIDE = '# Archive guide\n';

    async function expect_refused(dry_run = false): Promise<void> {
      const doc_before = await readFile(join(docs_path, 'README.md'), 'utf-8');
      const res = await archive_doc({ project_root: tmp_dir, docs_path, file: 'README.md', dry_run });
      expect(res.ok).toBe(false);
      expect(res.action).toBe('rejected');
      expect(res.errors.join(' ')).toMatch(/archive\/README\.md.*README\.md/);
      expect(await readFile(join(docs_path, 'archive/README.md'), 'utf-8')).toBe(GUIDE);
      expect(await readFile(join(docs_path, 'README.md'), 'utf-8')).toBe(doc_before);
    }

    it('refuses to overwrite an existing file at the archive path (fs)', async () => {
      await write_doc('archive/README.md', GUIDE);
      await write_doc('README.md');
      await expect_refused();
      await expect_refused(true);
    });

    it('refuses to overwrite a tracked file at the archive path (git)', async () => {
      execFileSync('git', ['init', '-q'], { cwd: tmp_dir });
      execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: tmp_dir });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: tmp_dir });
      await write_doc('archive/README.md', GUIDE);
      await write_doc('README.md');
      execFileSync('git', ['add', '-A'], { cwd: tmp_dir });
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: tmp_dir });

      await expect_refused();
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: tmp_dir, encoding: 'utf-8' });
      expect(status).toBe('');
    });
  });

  describe('#39', () => {
    it('does not count links from generated indexes, but still counts a hand-written one', async () => {
      await write_doc('api/old.md');
      // Generated root and domain indexes: rebuilt by archive's own reindex.
      await writeFile(join(docs_path, 'INDEX.md'), '# Index\n[old](api/old.md)\n', 'utf-8');
      await writeFile(join(docs_path, 'api/REGISTRY.md'), '# Registry\n[old](old.md)\n', 'utf-8');

      const res = await archive_doc({ project_root: tmp_dir, docs_path, file: 'api/old.md', dry_run: true });
      expect(res.inbound_links).toEqual([]);

      // A sub-feature INDEX.md is prose hewtd never writes: it still blocks.
      await write_doc('api/v2/INDEX.md', FM().replace('# Doc\n', '# V2\n[old](../old.md)\n'));
      const blocked = await archive_doc({ project_root: tmp_dir, docs_path, file: 'api/old.md' });
      expect(blocked.action).toBe('blocked');
      expect(blocked.inbound_links.map((l) => l.source)).toEqual(['api/v2/INDEX.md']);
    });

    it('accepts project-relative, docs-relative and absolute paths, for archive and unarchive', async () => {
      for (const file of ['.documentation/api/a.md', 'api/b.md', join(docs_path, 'api/c.md')]) {
        const name = file.slice(-4);
        await write_doc(`api/${name}`);
        const res = await archive_doc({ project_root: tmp_dir, docs_path, file, today: '2026-06-09' });
        expect(res.ok, file).toBe(true);
        expect(res.from).toBe(`api/${name}`);
      }

      const back = await unarchive_doc({
        project_root: tmp_dir,
        docs_path,
        file: '.documentation/archive/api/a.md',
      });
      expect(back.ok).toBe(true);
      expect(await exists(join(docs_path, 'api/a.md'))).toBe(true);
    });
  });
});
