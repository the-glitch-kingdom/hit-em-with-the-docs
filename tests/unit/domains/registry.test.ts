import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  build_registry,
  get_registry,
  reset_registry,
  get_all_domains,
  get_domain_definition,
  is_valid_domain,
  get_domains_by_category,
  get_domains_by_priority,
  get_all_keywords,
} from '../../../src/core/domains/registry.js';
import { DOMAINS } from '../../../src/core/domains/constants.js';

const CUSTOM = {
  id: 'compliance',
  name: 'Compliance',
  description: 'Regulatory compliance docs',
  keywords: ['gdpr', 'hipaa', 'compliance'],
  loadPriority: 7,
  category: 'features',
};

async function write_config(dir: string, obj: unknown): Promise<void> {
  await mkdir(join(dir, '.claude'), { recursive: true });
  await writeFile(
    join(dir, '.claude', 'hit-em-with-the-docs.json'),
    JSON.stringify(obj),
    'utf-8'
  );
}

describe('domain registry — buildRegistry (explicit projectRoot)', () => {
  let tmp_dir: string;

  beforeEach(async () => {
    tmp_dir = await mkdtemp(join(tmpdir(), 'hewtd-registry-'));
  });
  afterEach(async () => {
    await rm(tmp_dir, { recursive: true, force: true });
  });

  it('returns exactly the 15 built-ins with no config', () => {
    const reg = build_registry(tmp_dir);
    expect(reg.ids).toHaveLength(15);
    expect(reg.ids).toEqual([...DOMAINS]);
  });

  it('merges a custom domain after the built-ins', async () => {
    await write_config(tmp_dir, { domains: [CUSTOM] });
    const reg = build_registry(tmp_dir);
    expect(reg.ids).toHaveLength(16);
    expect(reg.ids.slice(0, 15)).toEqual([...DOMAINS]); // built-ins first, in order
    expect(reg.ids[15]).toBe('compliance');
    expect(reg.definitions.get('compliance')!.keywords).toContain('gdpr');
  });

  it('drops a custom entry that collides with a built-in id', async () => {
    await write_config(tmp_dir, {
      domains: [{ ...CUSTOM, id: 'security' }],
    });
    const reg = build_registry(tmp_dir);
    // 'security' stays the built-in; the colliding custom entry is ignored.
    expect(reg.ids.filter((d) => d === 'security')).toHaveLength(1);
    expect(reg.ids).toHaveLength(15);
    expect(reg.definitions.get('security')!.name).toBe('Security');
  });
});

describe('domain registry — cached accessors (cwd-based)', () => {
  let tmp_dir: string;
  let original_cwd: string;

  beforeEach(async () => {
    original_cwd = process.cwd();
    tmp_dir = await mkdtemp(join(tmpdir(), 'hewtd-registry-cwd-'));
    process.chdir(tmp_dir);
    reset_registry();
  });
  afterEach(async () => {
    process.chdir(original_cwd);
    reset_registry();
    await rm(tmp_dir, { recursive: true, force: true });
  });

  it('isValidDomain accepts built-in and custom, rejects unknown', async () => {
    await write_config(tmp_dir, { domains: [CUSTOM] });
    reset_registry();
    expect(is_valid_domain('security')).toBe(true);
    expect(is_valid_domain('compliance')).toBe(true);
    expect(is_valid_domain('nope')).toBe(false);
  });

  it('getAllDomains includes the custom domain', async () => {
    await write_config(tmp_dir, { domains: [CUSTOM] });
    reset_registry();
    expect(get_all_domains()).toContain('compliance');
  });

  it('getDomainDefinition returns the custom def and throws on unknown', async () => {
    await write_config(tmp_dir, { domains: [CUSTOM] });
    reset_registry();
    expect(get_domain_definition('compliance').loadPriority).toBe(7);
    expect(() => get_domain_definition('ghost')).toThrow(/Unknown domain/);
  });

  it('getAllKeywords maps custom keywords to the custom domain', async () => {
    await write_config(tmp_dir, { domains: [CUSTOM] });
    reset_registry();
    expect(get_all_keywords().get('gdpr')).toContain('compliance');
  });

  it('getDomainsByCategory includes the custom domain in its category', async () => {
    await write_config(tmp_dir, { domains: [CUSTOM] });
    reset_registry();
    expect(get_domains_by_category('features')).toContain('compliance');
  });

  it('getDomainsByPriority places a high-priority custom domain near the top', async () => {
    await write_config(tmp_dir, { domains: [{ ...CUSTOM, loadPriority: 10 }] });
    reset_registry();
    expect(get_domains_by_priority().indexOf('compliance')).toBeLessThan(6);
  });

  it('resetRegistry re-reads config (cache invalidation)', async () => {
    expect(get_registry().ids).toHaveLength(15);
    await write_config(tmp_dir, { domains: [CUSTOM] });
    // Without reset, still cached at 15.
    expect(get_registry().ids).toHaveLength(15);
    reset_registry();
    expect(get_registry().ids).toHaveLength(16);
  });
});
