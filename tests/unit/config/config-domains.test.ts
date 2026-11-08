import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  custom_domain_schema,
  load_plugin_config,
  load_plugin_config_sync,
  load_raw_config,
  write_raw_config,
  resolve_config_file_path,
} from '../../../src/utils/config.js';

const VALID = {
  id: 'compliance',
  name: 'Compliance',
  description: 'Regulatory compliance docs',
  keywords: ['gdpr', 'hipaa'],
  loadPriority: 5,
  category: 'features',
};

describe('customDomainSchema', () => {
  it('accepts a well-formed entry', () => {
    expect(custom_domain_schema.safeParse(VALID).success).toBe(true);
  });

  it('rejects a non-kebab id', () => {
    expect(custom_domain_schema.safeParse({ ...VALID, id: 'Bad Id' }).success).toBe(false);
    expect(custom_domain_schema.safeParse({ ...VALID, id: 'UPPER' }).success).toBe(false);
  });

  it('rejects empty keywords', () => {
    expect(custom_domain_schema.safeParse({ ...VALID, keywords: [] }).success).toBe(false);
  });

  it('rejects an out-of-enum category', () => {
    expect(custom_domain_schema.safeParse({ ...VALID, category: 'nonsense' }).success).toBe(false);
  });

  it('rejects loadPriority outside 1-10', () => {
    expect(custom_domain_schema.safeParse({ ...VALID, loadPriority: 0 }).success).toBe(false);
    expect(custom_domain_schema.safeParse({ ...VALID, loadPriority: 11 }).success).toBe(false);
  });
});

describe('config loaders with custom domains', () => {
  let tmp_dir: string;

  beforeEach(async () => {
    tmp_dir = await mkdtemp(join(tmpdir(), 'hewtd-config-'));
    await mkdir(join(tmp_dir, '.claude'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp_dir, { recursive: true, force: true });
  });

  async function write_config(obj: unknown): Promise<void> {
    await writeFile(
      join(tmp_dir, '.claude', 'hit-em-with-the-docs.json'),
      JSON.stringify(obj),
      'utf-8'
    );
  }

  it('loads a valid custom domain (async)', async () => {
    await write_config({ domains: [VALID] });
    const config = await load_plugin_config(tmp_dir);
    expect(config.domains).toHaveLength(1);
    expect(config.domains[0]!.id).toBe('compliance');
  });

  it('loads a valid custom domain (sync) — regression: ESM require(fs) bug', async () => {
    // loadPluginConfigSync historically used a lazy require("fs") that throws
    // in the ESM runtime, silently returning defaults. This guards the static-
    // import fix so the sync path (used by the domain registry) actually reads
    // the file.
    await write_config({ domains: [VALID] });
    const config = load_plugin_config_sync(tmp_dir);
    expect(config.domains).toHaveLength(1);
    expect(config.domains[0]!.id).toBe('compliance');
  });

  it('drops a malformed domain entry but keeps valid ones (never-throw)', async () => {
    await write_config({
      domains: [VALID, { id: 'Bad Id', keywords: [] }],
      vault: { audit_window_days: 30 },
    });
    const config = load_plugin_config_sync(tmp_dir);
    expect(config.domains).toHaveLength(1);
    expect(config.domains[0]!.id).toBe('compliance');
    // A bad domain entry must not nuke the rest of the config.
    expect(config.vault.audit_window_days).toBe(30);
  });

  it('defaults domains to [] when absent', () => {
    const config = load_plugin_config_sync(tmp_dir);
    expect(config.domains).toEqual([]);
  });
});

describe('readRawConfig / writeRawConfig', () => {
  let tmp_dir: string;

  beforeEach(async () => {
    tmp_dir = await mkdtemp(join(tmpdir(), 'hewtd-raw-'));
  });

  afterEach(async () => {
    await rm(tmp_dir, { recursive: true, force: true });
  });

  it('returns {} when no config exists', async () => {
    expect(await load_raw_config(tmp_dir)).toEqual({});
  });

  it('round-trips and preserves unmodeled keys (updatePolicy)', async () => {
    await write_raw_config(tmp_dir, {
      updatePolicy: 'nudge',
      vault: { audit_window_days: 45 },
      domains: [VALID],
    });
    const raw = await load_raw_config(tmp_dir);
    expect(raw.updatePolicy).toBe('nudge');
    expect((raw.vault as { audit_window_days: number }).audit_window_days).toBe(45);
    expect((raw.domains as unknown[]).length).toBe(1);
  });

  it('creates the .claude directory if missing', async () => {
    const path = await write_raw_config(tmp_dir, { domains: [] });
    expect(path).toBe(resolve_config_file_path(tmp_dir));
    const contents = await readFile(path, 'utf-8');
    expect(contents.endsWith('\n')).toBe(true);
  });
});
