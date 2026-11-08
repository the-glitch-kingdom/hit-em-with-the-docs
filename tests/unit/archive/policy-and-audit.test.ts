import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { load_plugin_config_sync, DEFAULT_ARCHIVE_CANDIDATE_DAYS } from '../../../src/utils/config.js';
import { check_documentation } from '../../../src/core/audit/auditor.js';
import { reset_registry } from '../../../src/core/domains/registry.js';

describe('archive config defaults', () => {
  let tmp_dir: string;

  beforeEach(async () => {
    tmp_dir = await mkdtemp(join(tmpdir(), 'hewtd-arccfg-'));
  });
  afterEach(async () => {
    await rm(tmp_dir, { recursive: true, force: true });
  });

  it('applies safe defaults when no archive block present', () => {
    const cfg = load_plugin_config_sync(tmp_dir);
    expect(cfg.archive.auto).toBe(false);
    expect(cfg.archive.require_orphaned).toBe(true);
    expect(cfg.archive.honor_status_deprecated).toBe(true);
    expect(cfg.archive.candidate_after_days).toBe(DEFAULT_ARCHIVE_CANDIDATE_DAYS);
  });

  it('reads an explicit archive block', async () => {
    await mkdir(join(tmp_dir, '.claude'), { recursive: true });
    await writeFile(
      join(tmp_dir, '.claude', 'hit-em-with-the-docs.json'),
      JSON.stringify({ archive: { candidate_after_days: 90, auto: true } }),
      'utf-8'
    );
    const cfg = load_plugin_config_sync(tmp_dir);
    expect(cfg.archive.candidate_after_days).toBe(90);
    expect(cfg.archive.auto).toBe(true);
    // unspecified keys still default
    expect(cfg.archive.require_orphaned).toBe(true);
  });
});

describe('audit nudge: deprecated-not-archived', () => {
  let tmp_dir: string;
  let docs_root: string;

  beforeEach(async () => {
    tmp_dir = await mkdtemp(join(tmpdir(), 'hewtd-depnudge-'));
    docs_root = join(tmp_dir, '.documentation');
    await mkdir(join(docs_root, 'api'), { recursive: true });
    reset_registry();
  });
  afterEach(async () => {
    reset_registry();
    await rm(tmp_dir, { recursive: true, force: true });
  });

  it('flags a status: deprecated doc still in an active domain folder', async () => {
    await writeFile(
      join(docs_root, 'api', 'old.md'),
      `---\ntitle: Old\ntier: reference\ndomains: [api]\nstatus: deprecated\nlast_updated: '2026-06-01'\nversion: '1.0.0'\n---\n# Old\n`,
      'utf-8'
    );
    const result = await check_documentation({ docs_root: docs_root, silent: true });
    const nudge = result.issues.find((i) => i.rule === 'deprecated-not-archived');
    expect(nudge).toBeDefined();
    expect(nudge!.severity).toBe('info');
    expect(nudge!.suggestion).toMatch(/hewtd archive/);
  });

  it('does not flag an active doc', async () => {
    await writeFile(
      join(docs_root, 'api', 'live.md'),
      `---\ntitle: Live\ntier: reference\ndomains: [api]\nstatus: active\nlast_updated: '2026-06-01'\nversion: '1.0.0'\n---\n# Live\n`,
      'utf-8'
    );
    const result = await check_documentation({ docs_root: docs_root, silent: true });
    expect(result.issues.find((i) => i.rule === 'deprecated-not-archived')).toBeUndefined();
  });
});
