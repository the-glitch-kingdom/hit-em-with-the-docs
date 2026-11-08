import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fix_legacy_layout } from '../../../src/core/knowledge-base/fix-legacy-layout.js';

describe('fixLegacyLayout (2.4.0)', () => {
  let tmp_project: string;
  let vault_root: string;

  beforeEach(async () => {
    tmp_project = await mkdtemp(join(tmpdir(), 'hewtd-fix-legacy-'));
    vault_root = join(tmp_project, '.documentation/knowledge-base');
    await mkdir(vault_root, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp_project, { recursive: true, force: true });
  });

  it('moves legacy-layout folders into <vault>/incidents/ and reports them', async () => {
    // Plant two 2.3.0-buggy folders at the vault root.
    for (const slug of ['2026-04-23-foo', '2026-04-24-bar']) {
      const folder = join(vault_root, slug);
      await mkdir(folder, { recursive: true });
      await writeFile(
        join(folder, 'narrative.md'),
        `---
title: ${slug}
tier: incident-narrative
domains: [incidents]
status: active
last_updated: '2026-04-23'
id: ${slug}
date: '${slug.slice(0, 10)}'
severity: medium
resolution_status: resolved
components: [test]
---

# ${slug}
`,
        'utf-8'
      );
    }

    const result = await fix_legacy_layout({
      vaultRoot: vault_root,
      projectRoot: tmp_project,
    });

    expect(result.action).toBe('fixed');
    expect(result.moved).toHaveLength(2);
    expect(result.moved.map((m) => m.slug).sort()).toEqual([
      '2026-04-23-foo',
      '2026-04-24-bar',
    ]);

    // Folders now exist at the canonical location
    expect(existsSync(join(vault_root, 'incidents', '2026-04-23-foo'))).toBe(true);
    expect(existsSync(join(vault_root, 'incidents', '2026-04-24-bar'))).toBe(true);
    // And NOT at the legacy location
    expect(existsSync(join(vault_root, '2026-04-23-foo'))).toBe(false);
    expect(existsSync(join(vault_root, '2026-04-24-bar'))).toBe(false);
  });

  it('is a no-op on a clean vault (no legacy folders to move)', async () => {
    // Vault has only the canonical incidents/ folder, no stragglers.
    const canonical = join(vault_root, 'incidents', '2026-05-14-test');
    await mkdir(canonical, { recursive: true });
    await writeFile(
      join(canonical, 'narrative.md'),
      `---
title: Test
tier: incident-narrative
domains: [incidents]
status: active
last_updated: '2026-05-14'
id: 2026-05-14-test
date: '2026-05-14'
severity: low
resolution_status: resolved
components: [test]
---

# Test
`,
      'utf-8'
    );

    const result = await fix_legacy_layout({
      vaultRoot: vault_root,
      projectRoot: tmp_project,
    });

    expect(result.action).toBe('no_op');
    expect(result.moved).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('leaves the reserved facts/ and symptoms/ folders alone', async () => {
    // Plant a legacy incident folder + the reserved facts/ folder.
    await mkdir(join(vault_root, 'facts'), { recursive: true });
    await writeFile(
      join(vault_root, 'facts', 'some-fact.md'),
      `---
title: A fact
tier: fact
domains: [test]
status: active
last_updated: '2026-05-14'
id: some-fact
confidence: high
last_verified: '2026-05-14'
provenance:
  - 2026-04-23-foo/
---

# A fact
`,
      'utf-8'
    );

    const legacy_folder = join(vault_root, '2026-04-23-foo');
    await mkdir(legacy_folder, { recursive: true });
    await writeFile(
      join(legacy_folder, 'narrative.md'),
      `---
title: Foo
tier: incident-narrative
domains: [incidents]
status: active
last_updated: '2026-04-23'
id: 2026-04-23-foo
date: '2026-04-23'
severity: low
resolution_status: resolved
components: [test]
---

# Foo
`,
      'utf-8'
    );

    const result = await fix_legacy_layout({
      vaultRoot: vault_root,
      projectRoot: tmp_project,
    });

    expect(result.action).toBe('fixed');
    expect(result.moved).toHaveLength(1);

    // facts/ folder untouched
    expect(existsSync(join(vault_root, 'facts', 'some-fact.md'))).toBe(true);
  });

  it('rewrites fact provenance references to point at the new location', async () => {
    // Plant: a legacy folder + a fact whose provenance points at the legacy path.
    const legacy_folder = join(vault_root, '2026-04-23-foo');
    await mkdir(legacy_folder, { recursive: true });
    await writeFile(
      join(legacy_folder, 'narrative.md'),
      `---
title: Foo
tier: incident-narrative
domains: [incidents]
status: active
last_updated: '2026-04-23'
id: 2026-04-23-foo
date: '2026-04-23'
severity: low
resolution_status: resolved
components: [test]
---

# Foo
`,
      'utf-8'
    );

    await mkdir(join(vault_root, 'facts'), { recursive: true });
    const fact_path = join(vault_root, 'facts', 'foo-fact.md');
    await writeFile(
      fact_path,
      `---
title: Foo fact
tier: fact
domains: [test]
status: active
last_updated: '2026-04-23'
id: foo-fact
confidence: high
last_verified: '2026-04-23'
provenance:
  - .documentation/knowledge-base/2026-04-23-foo/
---

# Foo fact
`,
      'utf-8'
    );

    const result = await fix_legacy_layout({
      vaultRoot: vault_root,
      projectRoot: tmp_project,
    });

    expect(result.action).toBe('fixed');
    expect(result.rewrittenProvenance).toHaveLength(1);
    expect(result.rewrittenProvenance[0]!.oldRef).toBe(
      '.documentation/knowledge-base/2026-04-23-foo/'
    );
    expect(result.rewrittenProvenance[0]!.newRef).toBe(
      '.documentation/knowledge-base/incidents/2026-04-23-foo/'
    );

    // The fact file on disk has the rewritten reference.
    const updated = await readFile(fact_path, 'utf-8');
    expect(updated).toContain('.documentation/knowledge-base/incidents/2026-04-23-foo/');
    expect(updated).not.toContain('.documentation/knowledge-base/2026-04-23-foo/');
  });

  it('also rewrites bare-slug provenance refs (e.g. "2026-04-23-foo/" without the vault prefix)', async () => {
    const legacy_folder = join(vault_root, '2026-04-23-foo');
    await mkdir(legacy_folder, { recursive: true });
    await writeFile(
      join(legacy_folder, 'narrative.md'),
      `---
title: Foo
tier: incident-narrative
domains: [incidents]
status: active
last_updated: '2026-04-23'
id: 2026-04-23-foo
date: '2026-04-23'
severity: low
resolution_status: resolved
components: [test]
---
`,
      'utf-8'
    );

    await mkdir(join(vault_root, 'facts'), { recursive: true });
    const fact_path = join(vault_root, 'facts', 'foo-fact.md');
    await writeFile(
      fact_path,
      `---
title: Foo fact
tier: fact
domains: [test]
status: active
last_updated: '2026-04-23'
id: foo-fact
confidence: high
last_verified: '2026-04-23'
provenance:
  - 2026-04-23-foo/
---
`,
      'utf-8'
    );

    const result = await fix_legacy_layout({
      vaultRoot: vault_root,
      projectRoot: tmp_project,
    });

    expect(result.rewrittenProvenance).toHaveLength(1);
    expect(result.rewrittenProvenance[0]!.oldRef).toBe('2026-04-23-foo/');
    expect(result.rewrittenProvenance[0]!.newRef).toBe(
      '.documentation/knowledge-base/incidents/2026-04-23-foo/'
    );
  });

  it('dry-run does not move folders or rewrite files', async () => {
    const legacy_folder = join(vault_root, '2026-04-23-foo');
    await mkdir(legacy_folder, { recursive: true });
    await writeFile(
      join(legacy_folder, 'narrative.md'),
      `---
title: Foo
tier: incident-narrative
domains: [incidents]
status: active
last_updated: '2026-04-23'
id: 2026-04-23-foo
date: '2026-04-23'
severity: low
resolution_status: resolved
components: [test]
---
`,
      'utf-8'
    );

    const result = await fix_legacy_layout({
      vaultRoot: vault_root,
      projectRoot: tmp_project,
      dryRun: true,
    });

    expect(result.action).toBe('dry_run');
    expect(result.moved).toHaveLength(1);
    // BUT the actual folder is unchanged.
    expect(existsSync(legacy_folder)).toBe(true);
    expect(existsSync(join(vault_root, 'incidents', '2026-04-23-foo'))).toBe(false);
  });

  it('skips folders whose narrative.md is not tier: incident-narrative', async () => {
    // A folder with a narrative.md that's a different tier (e.g. a guide).
    const decoy_folder = join(vault_root, 'some-guide-folder');
    await mkdir(decoy_folder, { recursive: true });
    await writeFile(
      join(decoy_folder, 'narrative.md'),
      `---
title: Not an incident
tier: guide
domains: [misc]
status: active
last_updated: '2026-05-14'
version: '1.0.0'
---

# Just a guide that happens to be in a narrative.md
`,
      'utf-8'
    );

    const result = await fix_legacy_layout({
      vaultRoot: vault_root,
      projectRoot: tmp_project,
    });

    expect(result.moved).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.path).toBe(decoy_folder);
    expect(result.skipped[0]!.reason).toContain('tier is not "incident-narrative"');
  });

  it('refuses to clobber an existing canonical folder at the destination', async () => {
    // Plant: a legacy folder AND an existing canonical folder with the same slug.
    const legacy_folder = join(vault_root, '2026-04-23-foo');
    const canonical_folder = join(vault_root, 'incidents', '2026-04-23-foo');
    await mkdir(legacy_folder, { recursive: true });
    await mkdir(canonical_folder, { recursive: true });
    await writeFile(
      join(legacy_folder, 'narrative.md'),
      `---
title: Legacy
tier: incident-narrative
domains: [incidents]
status: active
last_updated: '2026-04-23'
id: 2026-04-23-foo
date: '2026-04-23'
severity: low
resolution_status: resolved
components: [test]
---
`,
      'utf-8'
    );
    await writeFile(
      join(canonical_folder, 'narrative.md'),
      `---
title: Canonical
tier: incident-narrative
domains: [incidents]
status: active
last_updated: '2026-04-23'
id: 2026-04-23-foo
date: '2026-04-23'
severity: low
resolution_status: resolved
components: [test]
---
`,
      'utf-8'
    );

    const result = await fix_legacy_layout({
      vaultRoot: vault_root,
      projectRoot: tmp_project,
    });

    expect(result.moved).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain('destination already exists');

    // Both folders still exist (no clobber).
    expect(existsSync(legacy_folder)).toBe(true);
    expect(existsSync(canonical_folder)).toBe(true);
  });
});
