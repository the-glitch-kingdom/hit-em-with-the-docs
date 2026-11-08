import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrate_incident } from '../../../src/core/knowledge-base/migrate.js';

describe('migrateIncident (2.3.0 / 2.4.0 target-path fix)', () => {
  let tmp_dir: string;
  let vault_root: string;
  let flat_file_path: string;

  beforeEach(async () => {
    tmp_dir = await mkdtemp(join(tmpdir(), 'hewtd-migrate-'));
    vault_root = tmp_dir;
    flat_file_path = join(tmp_dir, '2026-05-14-vault-test.md');
  });

  afterEach(async () => {
    await rm(tmp_dir, { recursive: true, force: true });
  });

  it('migrates a flat-file incident into <vault>/incidents/<slug>/ (canonical target — fixed in 2.4.0)', async () => {
    await writeFile(
      flat_file_path,
      `---
title: Vault Test Incident
domains: [incidents]
status: active
last_updated: '2026-05-14'
severity: high
resolution_status: resolved
components: [vault]
---

# Vault Test Incident

## Timeline
- 10:00 — issue began
- 10:15 — resolved

## Root Cause
Test.
`,
      'utf-8'
    );

    const result = await migrate_incident({ flatFilePath: flat_file_path, vaultRoot: vault_root });

    expect(result.action).toBe('migrated');
    // KEY FIX: target is under incidents/, not a sibling of the flat file.
    expect(result.targetFolder).toBe(
      join(vault_root, 'incidents', '2026-05-14-vault-test')
    );

    const narrative = await readFile(result.narrativePath, 'utf-8');
    expect(narrative).toContain('tier: incident-narrative');
    expect(narrative).toContain('id: 2026-05-14-vault-test');
    expect(narrative).toContain('## Timeline');

    const facts = await readFile(result.factsPath, 'utf-8');
    expect(facts).toContain('tier: incident-facts');
    expect(facts).toContain('incident_id: 2026-05-14-vault-test');
    expect(facts).toContain('produced: []');

    const evidence_stat = await stat(result.evidencePath);
    expect(evidence_stat.isDirectory()).toBe(true);

    const renamed = `${flat_file_path}.migrated`;
    const renamed_stat = await stat(renamed);
    expect(renamed_stat.isFile()).toBe(true);
  });

  it('creates <vault>/incidents/ parent dir if it doesn\'t exist yet', async () => {
    await writeFile(
      flat_file_path,
      `---
title: T
domains: [incidents]
status: active
last_updated: '2026-05-14'
severity: high
resolution_status: resolved
components: [vault]
---

# T
`,
      'utf-8'
    );
    // No incidents/ subdir yet — migration must create it.
    const result = await migrate_incident({ flatFilePath: flat_file_path, vaultRoot: vault_root });
    expect(result.action).toBe('migrated');
    const incidents_parent = join(vault_root, 'incidents');
    const s = await stat(incidents_parent);
    expect(s.isDirectory()).toBe(true);
  });

  it('is idempotent at the canonical location — second run reports already_migrated (new)', async () => {
    await writeFile(
      flat_file_path,
      `---
title: Test
domains: [incidents]
status: active
last_updated: '2026-05-14'
severity: high
resolution_status: resolved
components: [vault]
---

# Test
`,
      'utf-8'
    );

    await migrate_incident({ flatFilePath: flat_file_path, vaultRoot: vault_root });

    // Plant a fresh flat file (simulate user re-running)
    await writeFile(flat_file_path, '---\ntitle: Stale\n---\n# Stale\n', 'utf-8');

    const result2 = await migrate_incident({ flatFilePath: flat_file_path, vaultRoot: vault_root });
    expect(result2.action).toBe('already_migrated');
    expect(result2.existingLocation).toBe('new');
  });

  it('detects pre-existing 2.3.0-style folders at the legacy location and reports already_migrated (legacy)', async () => {
    // Simulate the 2.3.0 bug aftermath: a folder at the legacy location
    // (<vault>/<slug>/) with a valid narrative.md.
    const legacy_folder = join(vault_root, '2026-05-14-vault-test');
    await mkdir(legacy_folder, { recursive: true });
    await writeFile(
      join(legacy_folder, 'narrative.md'),
      `---
title: Legacy
tier: incident-narrative
domains: [incidents]
status: active
last_updated: '2026-05-14'
id: 2026-05-14-vault-test
date: '2026-05-14'
severity: medium
resolution_status: resolved
components: [vault]
---

# Legacy
`,
      'utf-8'
    );

    // Now create a fresh flat file with the same slug and try to migrate.
    await writeFile(
      flat_file_path,
      `---
title: New
domains: [incidents]
status: active
last_updated: '2026-05-14'
severity: high
resolution_status: resolved
components: [vault]
---

# New
`,
      'utf-8'
    );

    const result = await migrate_incident({ flatFilePath: flat_file_path, vaultRoot: vault_root });
    expect(result.action).toBe('already_migrated');
    expect(result.existingLocation).toBe('legacy');
    // The result's narrativePath points at the legacy folder so the CLI
    // can tell the user where the existing migration lives.
    expect(result.narrativePath).toBe(join(legacy_folder, 'narrative.md'));
  });

  it('--force re-migrates even when canonical folder exists', async () => {
    await writeFile(
      flat_file_path,
      `---
title: Original
domains: [incidents]
status: active
last_updated: '2026-05-14'
severity: high
resolution_status: resolved
components: [vault]
---

# Original
`,
      'utf-8'
    );

    // First migration
    await migrate_incident({ flatFilePath: flat_file_path, vaultRoot: vault_root });

    // Re-create flat file with new content
    await writeFile(
      flat_file_path,
      `---
title: Replaced
domains: [incidents]
status: active
last_updated: '2026-05-15'
severity: critical
resolution_status: resolved
components: [vault, alloy]
---

# Replaced
`,
      'utf-8'
    );

    const result = await migrate_incident({
      flatFilePath: flat_file_path,
      vaultRoot: vault_root,
      force: true,
    });
    expect(result.action).toBe('migrated');

    const narrative = await readFile(result.narrativePath, 'utf-8');
    expect(narrative).toContain('title: Replaced');
    expect(narrative).toContain('severity: critical');
  });

  it('dry-run produces the canonical plan without writing files', async () => {
    await writeFile(
      flat_file_path,
      `---
title: Dry Test
domains: [incidents]
status: active
last_updated: '2026-05-14'
severity: low
resolution_status: open
components: [vault]
---

# Dry Test
`,
      'utf-8'
    );

    const result = await migrate_incident({
      flatFilePath: flat_file_path,
      vaultRoot: vault_root,
      dryRun: true,
    });

    expect(result.action).toBe('dry_run');
    expect(result.targetFolder).toBe(
      join(vault_root, 'incidents', '2026-05-14-vault-test')
    );
    expect(result.narrativeContent).toContain('tier: incident-narrative');
    expect(result.factsContent).toContain('tier: incident-facts');

    let folder_exists = true;
    try {
      await stat(result.targetFolder);
    } catch {
      folder_exists = false;
    }
    expect(folder_exists).toBe(false);

    const original = await stat(flat_file_path);
    expect(original.isFile()).toBe(true);
  });

  it('falls back to defaults when the source frontmatter is sparse', async () => {
    await writeFile(
      flat_file_path,
      `---
title: Bare
---

# Bare
`,
      'utf-8'
    );

    const result = await migrate_incident({ flatFilePath: flat_file_path, vaultRoot: vault_root });
    const narrative = await readFile(result.narrativePath, 'utf-8');
    expect(narrative).toContain('severity: medium');
    expect(narrative).toContain('resolution_status: resolved');
    expect(narrative).toContain('- unknown');
  });

  describe('dates and folder names (#39)', () => {
    const plan = async (name: string, frontmatter = 'title: X') => {
      const path = join(tmp_dir, name);
      await writeFile(path, `---\n${frontmatter}\n---\n\n# X\n`, 'utf-8');
      const result = await migrate_incident({ flatFilePath: path, vaultRoot: vault_root, dryRun: true });
      return {
        folder: result.targetFolder.slice(join(vault_root, 'incidents').length + 1),
        date: /^date: '?([^'\n]*)'?$/m.exec(result.narrativeContent)?.[1],
      };
    };

    it('takes the date from inside a prefixed name, and drops the prefix', async () => {
      expect(await plan('incident-2026-09-28-lab-vcp-and-overnight.md')).toEqual({
        folder: '2026-09-28-lab-vcp-and-overnight',
        date: '2026-09-28',
      });
    });

    it('keeps the prefix as the slug when nothing follows the date', async () => {
      expect(await plan('postmortem-2026-05-14.md')).toEqual({
        folder: '2026-05-14-postmortem',
        date: '2026-05-14',
      });
    });

    it('dates an undated name from frontmatter date:', async () => {
      expect(await plan('vault-outage.md', "title: X\ndate: '2026-03-02'")).toEqual({
        folder: '2026-03-02-vault-outage',
        date: '2026-03-02',
      });
    });

    it('never writes a slice of the name as the date', async () => {
      const { date } = await plan('vault-outage.md', "title: X\nlast_updated: '2026-04-01'");
      expect(date).toBe('2026-04-01');
    });
  });
});
