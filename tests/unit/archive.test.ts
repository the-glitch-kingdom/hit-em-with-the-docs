import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { find_markdown_files, ARCHIVE_DIR } from '../../src/utils/glob.js';
import { create_scaffold } from '../../src/generators/scaffold.js';
import { check_documentation } from '../../src/core/audit/auditor.js';
import { reset_registry } from '../../src/core/domains/registry.js';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('archive/ — deprecated-docs convention', () => {
  let docs_path: string;
  let original_cwd: string;
  let tmp_dir: string;

  beforeEach(async () => {
    original_cwd = process.cwd();
    tmp_dir = await mkdtemp(join(tmpdir(), 'hewtd-archive-'));
    docs_path = join(tmp_dir, '.documentation');
    process.chdir(tmp_dir);
    reset_registry();
  });
  afterEach(async () => {
    process.chdir(original_cwd);
    reset_registry();
    await rm(tmp_dir, { recursive: true, force: true });
  });

  it('scaffold creates an archive/ folder with an instructional README', async () => {
    await create_scaffold({ root_path: docs_path, silent: true });
    expect(await exists(join(docs_path, ARCHIVE_DIR))).toBe(true);
    expect(await exists(join(docs_path, ARCHIVE_DIR, 'README.md'))).toBe(true);
  });

  it('findMarkdownFiles excludes everything under archive/', async () => {
    await mkdir(join(docs_path, 'security'), { recursive: true });
    await mkdir(join(docs_path, ARCHIVE_DIR, 'security'), { recursive: true });
    await writeFile(join(docs_path, 'security', 'live.md'), '# live\n', 'utf-8');
    await writeFile(join(docs_path, ARCHIVE_DIR, 'old.md'), '# old\n', 'utf-8');
    await writeFile(
      join(docs_path, ARCHIVE_DIR, 'security', 'nested-old.md'),
      '# nested\n',
      'utf-8'
    );

    const files = await find_markdown_files(docs_path);
    expect(files.some((f) => f.endsWith('live.md'))).toBe(true);
    expect(files.some((f) => f.includes(`/${ARCHIVE_DIR}/`))).toBe(false);
  });

  it('audit does not flag a malformed doc parked in archive/', async () => {
    await create_scaffold({ root_path: docs_path, silent: true });
    // A doc with deliberately broken frontmatter — would fail audit if scanned.
    await writeFile(
      join(docs_path, ARCHIVE_DIR, 'retired-guide.md'),
      `---\ntitle: Retired\n---\n# Retired guide with no valid tier/domains\n`,
      'utf-8'
    );

    const result = await check_documentation({ docs_path, silent: true });
    const flagged_archive = result.issues.some((i) =>
      i.file.includes(`${ARCHIVE_DIR}/`)
    );
    expect(flagged_archive).toBe(false);
  });
});
