import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { add_domain, remove_domain, list_domains } from '../../../src/core/domains/manage.js';
import { reset_registry } from '../../../src/core/domains/registry.js';

const SPEC = {
  id: 'compliance',
  name: 'Compliance',
  description: 'Regulatory compliance docs',
  keywords: ['gdpr', 'hipaa'],
  loadPriority: 5,
  category: 'features',
};

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
async function read_config(dir: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(
      await readFile(join(dir, '.claude', 'hit-em-with-the-docs.json'), 'utf-8')
    );
  } catch {
    return {};
  }
}

describe('manage: addDomain / removeDomain / listDomains', () => {
  let tmp_dir: string;
  let docs_path: string;
  let original_cwd: string;

  beforeEach(async () => {
    original_cwd = process.cwd();
    tmp_dir = await mkdtemp(join(tmpdir(), 'hewtd-manage-'));
    docs_path = join(tmp_dir, '.documentation');
    await mkdir(docs_path, { recursive: true });
    // addDomain's scaffold uses the cwd-based registry — mirror the CLI, which
    // always runs with cwd === projectRoot.
    process.chdir(tmp_dir);
    reset_registry();
  });
  afterEach(async () => {
    process.chdir(original_cwd);
    reset_registry();
    await rm(tmp_dir, { recursive: true, force: true });
  });

  // ---- add ----

  it('adds a valid domain: writes config + scaffolds folder', async () => {
    const res = await add_domain({ projectRoot: tmp_dir, docsPath: docs_path, spec: SPEC });
    expect(res.ok).toBe(true);
    expect(res.action).toBe('added');
    expect(await exists(join(docs_path, 'compliance'))).toBe(true);
    expect(await exists(join(docs_path, 'compliance', 'INDEX.md'))).toBe(true);
    expect(await exists(join(docs_path, 'compliance', 'REGISTRY.md'))).toBe(true);
    const cfg = await read_config(tmp_dir);
    expect((cfg.domains as { id: string }[])[0]!.id).toBe('compliance');
  });

  it('dry-run writes nothing', async () => {
    const res = await add_domain({
      projectRoot: tmp_dir,
      docsPath: docs_path,
      spec: SPEC,
      dryRun: true,
    });
    expect(res.action).toBe('dry_run');
    expect(res.spec!.id).toBe('compliance');
    expect(await exists(join(docs_path, 'compliance'))).toBe(false);
    expect(await exists(join(tmp_dir, '.claude', 'hit-em-with-the-docs.json'))).toBe(false);
  });

  it('rejects a built-in id', async () => {
    const res = await add_domain({
      projectRoot: tmp_dir,
      docsPath: docs_path,
      spec: { ...SPEC, id: 'security' },
    });
    expect(res.ok).toBe(false);
    expect(res.action).toBe('rejected');
    expect(res.errors.join(' ')).toMatch(/built-in/i);
  });

  it('rejects a duplicate custom id', async () => {
    await add_domain({ projectRoot: tmp_dir, docsPath: docs_path, spec: SPEC });
    const res = await add_domain({ projectRoot: tmp_dir, docsPath: docs_path, spec: SPEC });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/already exists/i);
  });

  it('rejects a reserved structural folder name (archive)', async () => {
    const res = await add_domain({
      projectRoot: tmp_dir,
      docsPath: docs_path,
      spec: { ...SPEC, id: 'archive' },
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/reserved/i);
  });

  it('rejects an invalid spec (empty keywords, bad category)', async () => {
    const r1 = await add_domain({
      projectRoot: tmp_dir,
      docsPath: docs_path,
      spec: { ...SPEC, keywords: [] },
    });
    expect(r1.ok).toBe(false);
    const r2 = await add_domain({
      projectRoot: tmp_dir,
      docsPath: docs_path,
      spec: { ...SPEC, category: 'bogus' },
    });
    expect(r2.ok).toBe(false);
  });

  it('preserves other config keys when adding', async () => {
    await mkdir(join(tmp_dir, '.claude'), { recursive: true });
    await writeFile(
      join(tmp_dir, '.claude', 'hit-em-with-the-docs.json'),
      JSON.stringify({ updatePolicy: 'nudge', vault: { audit_window_days: 45 } }),
      'utf-8'
    );
    await add_domain({ projectRoot: tmp_dir, docsPath: docs_path, spec: SPEC });
    const cfg = await read_config(tmp_dir);
    expect(cfg.updatePolicy).toBe('nudge');
    expect((cfg.vault as { audit_window_days: number }).audit_window_days).toBe(45);
    expect((cfg.domains as unknown[]).length).toBe(1);
  });

  // ---- list ----

  it('listDomains partitions built-in vs custom', async () => {
    await add_domain({ projectRoot: tmp_dir, docsPath: docs_path, spec: SPEC });
    reset_registry();
    const { builtin, custom } = list_domains(tmp_dir);
    expect(builtin).toHaveLength(15);
    expect(custom).toHaveLength(1);
    expect(custom[0]!.id).toBe('compliance');
  });

  // ---- remove ----

  it('removes a custom domain non-destructively, reporting orphan count', async () => {
    await add_domain({ projectRoot: tmp_dir, docsPath: docs_path, spec: SPEC });
    // Drop a doc into the domain so removal orphans it.
    await writeFile(join(docs_path, 'compliance', 'policy.md'), '# Policy\n', 'utf-8');

    const res = await remove_domain({ projectRoot: tmp_dir, docsPath: docs_path, id: 'compliance' });
    expect(res.ok).toBe(true);
    expect(res.action).toBe('removed');
    expect(res.orphanedDocs).toBe(1);
    // Folder + doc survive (non-destructive).
    expect(await exists(join(docs_path, 'compliance'))).toBe(true);
    expect(await exists(join(docs_path, 'compliance', 'policy.md'))).toBe(true);
    // Config no longer lists it.
    const cfg = await read_config(tmp_dir);
    expect((cfg.domains as unknown[]).length).toBe(0);
  });

  it('remove dry-run reports orphans but does not change config', async () => {
    await add_domain({ projectRoot: tmp_dir, docsPath: docs_path, spec: SPEC });
    await writeFile(join(docs_path, 'compliance', 'a.md'), '# A\n', 'utf-8');
    const res = await remove_domain({
      projectRoot: tmp_dir,
      docsPath: docs_path,
      id: 'compliance',
      dryRun: true,
    });
    expect(res.action).toBe('dry_run');
    expect(res.orphanedDocs).toBe(1);
    const cfg = await read_config(tmp_dir);
    expect((cfg.domains as unknown[]).length).toBe(1);
  });

  it('refuses to remove a built-in domain', async () => {
    const res = await remove_domain({ projectRoot: tmp_dir, docsPath: docs_path, id: 'security' });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/built-in/i);
  });

  it('rejects removing a domain that is not configured', async () => {
    const res = await remove_domain({ projectRoot: tmp_dir, docsPath: docs_path, id: 'ghost' });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/not a configured custom domain/i);
  });
});
