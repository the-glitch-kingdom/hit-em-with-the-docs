import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DOC_STATUS_VALUES,
  build_status_vocabulary,
  get_status_values,
  is_valid_status,
  reset_status_registry,
} from '../../../src/core/metadata/status-registry.js';
import { MetadataSchema } from '../../../src/core/metadata/schema.js';

/** Write a project config with the given `status` block and return its root. */
async function project_with_status(status: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hewtd-status-'));
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(
    join(root, '.claude', 'hit-em-with-the-docs.json'),
    JSON.stringify({ status }),
    'utf-8'
  );
  return root;
}

describe('status vocabulary registry', () => {
  const cwd = process.cwd();
  const roots: string[] = [];

  beforeEach(() => reset_status_registry());

  afterEach(async () => {
    process.chdir(cwd);
    reset_status_registry();
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  it('is the four built-ins when no config exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hewtd-status-'));
    roots.push(root);
    expect(build_status_vocabulary(root)).toEqual([...DOC_STATUS_VALUES]);
  });

  it('appends project-declared values after the built-ins', async () => {
    const root = await project_with_status(['complete', 'current']);
    roots.push(root);
    expect(build_status_vocabulary(root)).toEqual([
      'draft',
      'active',
      'deprecated',
      'archived',
      'complete',
      'current',
    ]);
  });

  it('never lets config drop a built-in — hewtd writes those itself', async () => {
    // archive writes `archived`, unarchive writes `active`, generated indexes
    // are emitted `active`. Config is additive precisely so it cannot break them.
    const root = await project_with_status(['complete']);
    roots.push(root);
    const values = build_status_vocabulary(root);
    for (const builtin of DOC_STATUS_VALUES) {
      expect(values).toContain(builtin);
    }
  });

  it('de-duplicates a config value that repeats a built-in', async () => {
    const root = await project_with_status(['active', 'complete', 'complete']);
    roots.push(root);
    const values = build_status_vocabulary(root);
    expect(values.filter((v) => v === 'active')).toHaveLength(1);
    expect(values.filter((v) => v === 'complete')).toHaveLength(1);
  });

  it('drops malformed entries instead of failing the whole config load', async () => {
    const root = await project_with_status(['complete', 'BAD VALUE', 42, null]);
    roots.push(root);
    expect(build_status_vocabulary(root)).toEqual([...DOC_STATUS_VALUES, 'complete']);
  });

  it('falls back to built-ins when `status` is not an array', async () => {
    const root = await project_with_status('complete');
    roots.push(root);
    expect(build_status_vocabulary(root)).toEqual([...DOC_STATUS_VALUES]);
  });

  it('caches, and resetStatusRegistry() clears the cache', async () => {
    const root = await project_with_status(['complete']);
    roots.push(root);
    process.chdir(root);

    expect(get_status_values()).toContain('complete');
    expect(is_valid_status('complete')).toBe(true);
    expect(is_valid_status('nonsense')).toBe(false);

    await writeFile(
      join(root, '.claude', 'hit-em-with-the-docs.json'),
      JSON.stringify({ status: ['current'] }),
      'utf-8'
    );
    // still cached
    expect(get_status_values()).toContain('complete');
    reset_status_registry();
    expect(get_status_values()).not.toContain('complete');
    expect(get_status_values()).toContain('current');
  });

  it('getStatusValues() returns a copy callers cannot mutate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hewtd-status-'));
    roots.push(root);
    process.chdir(root);
    get_status_values().push('injected');
    expect(get_status_values()).not.toContain('injected');
  });
});

describe('MetadataSchema status validation against the active vocabulary', () => {
  const cwd = process.cwd();
  const roots: string[] = [];
  const base = {
    title: 'T',
    tier: 'guide' as const,
    domains: ['security'],
    last_updated: '2026-08-30',
    version: '1.0.0',
  };

  beforeEach(() => reset_status_registry());

  afterEach(async () => {
    process.chdir(cwd);
    reset_status_registry();
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  it('accepts a project-declared status (issue #18: complete / current)', async () => {
    const root = await project_with_status(['complete', 'current']);
    roots.push(root);
    process.chdir(root);
    reset_status_registry();

    expect(MetadataSchema.safeParse({ ...base, status: 'complete' }).success).toBe(true);
    expect(MetadataSchema.safeParse({ ...base, status: 'current' }).success).toBe(true);
  });

  it('still rejects a status outside the active vocabulary', async () => {
    const root = await project_with_status(['complete']);
    roots.push(root);
    process.chdir(root);
    reset_status_registry();

    const result = MetadataSchema.safeParse({ ...base, status: 'nonsense' });
    expect(result.success).toBe(false);
  });

  it('names the active vocabulary and the config file in the failure message', async () => {
    const root = await project_with_status(['complete']);
    roots.push(root);
    process.chdir(root);
    reset_status_registry();

    const result = MetadataSchema.safeParse({ ...base, status: 'nonsense' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = result.error.issues.find((i) => i.path[0] === 'status')?.message ?? '';
    expect(message).toContain('complete');
    expect(message).toContain('.claude/hit-em-with-the-docs.json');
  });

  it('leaves the built-in vocabulary enforced when no config is present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hewtd-status-'));
    roots.push(root);
    process.chdir(root);
    reset_status_registry();

    expect(MetadataSchema.safeParse({ ...base, status: 'active' }).success).toBe(true);
    expect(MetadataSchema.safeParse({ ...base, status: 'complete' }).success).toBe(false);
  });

  it('lifecycle-tracked tiers keep their own status vocabulary, unaffected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hewtd-status-'));
    roots.push(root);
    process.chdir(root);
    reset_status_registry();

    const plan = MetadataSchema.safeParse({
      title: 'P',
      tier: 'plan',
      domains: ['plans'],
      status: 'in-progress',
      last_updated: '2026-08-30',
    });
    expect(plan.success).toBe(true);
  });
});
