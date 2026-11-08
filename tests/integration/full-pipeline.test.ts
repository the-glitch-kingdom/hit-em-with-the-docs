/**
 * Full pipeline integration test (2.3.0 PR3).
 *
 * Walks through the user-facing workflow end-to-end against a temp tree:
 *   1. migrate-incident   (legacy flat-file → folder form)
 *   2. extract-facts      (writer side; LLM proposer simulated by accept array)
 *   3. cite               (insert citation into a playbook)
 *   4. audit-facts        (stale detection — clean tree)
 *   5. find-citers        (citation graph lookup)
 *
 * The test exercises the deterministic CLI surface; the LLM proposer
 * (extract-facts slash command) is not covered here — that's the
 * non-deterministic prompt-driven layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { migrate_incident } from '../../src/core/knowledge-base/migrate.js';
import { extract_facts } from '../../src/core/knowledge-base/extract.js';
import { cite } from '../../src/core/knowledge-base/cite.js';
import { audit_facts } from '../../src/core/knowledge-base/audit.js';
import {
  build_citer_index,
  find_citers_in_index,
} from '../../src/core/knowledge-base/citers.js';

describe('Full KB pipeline integration (2.3.0)', () => {
  let tmp_project: string;
  let vault_root: string;
  let legacy_incident_path: string;
  let playbook_path: string;

  beforeEach(async () => {
    tmp_project = await mkdtemp(join(tmpdir(), 'hewtd-pipeline-'));
    vault_root = join(tmp_project, '.documentation/knowledge-base');

    // Set up the vault structure
    await mkdir(join(vault_root, 'facts'), { recursive: true });
    await mkdir(join(vault_root, 'incidents'), { recursive: true });

    // Legacy flat-file incident already under incidents/ — common shape for
    // users mid-migration to the folder convention.
    legacy_incident_path = join(vault_root, 'incidents', '2026-05-14-vault-alloy-stuck.md');
    await writeFile(
      legacy_incident_path,
      `---
title: Vault Down on Auth-Staging
domains: [incidents, observability]
status: active
last_updated: '2026-05-14'
severity: high
resolution_status: resolved
components: [vault, alloy, grafana]
---

# Vault Down on Auth-Staging

## Timeline
- 14:02 — Grafana alert fired
- 14:05 — Investigated: Vault healthy
- 14:15 — Alloy scrape worker stuck
- 14:18 — Restarted Alloy

## Root Cause
Grafana Alloy's scrape worker hung on a stale connection.

## Resolution
Restarted the Alloy container.

## Lessons Learned
Alloy reads env at entrypoint only.
`,
      'utf-8'
    );

    // Set up an existing playbook
    playbook_path = join(tmp_project, '.documentation/devops/grafana-runbook.md');
    await mkdir(join(tmp_project, '.documentation/devops'), { recursive: true });
    await writeFile(
      playbook_path,
      `---
title: Grafana Runbook
tier: admin
domains: [observability]
status: active
last_updated: '2026-05-14'
version: '1.0.0'
---

# Grafana Runbook

## Vault Down — auth-staging

1. Verify Vault directly: \`curl https://vault.../v1/sys/health\`
2. If Vault is healthy, check Alloy.
3. Restart Alloy if needed.
`,
      'utf-8'
    );
  });

  afterEach(async () => {
    await rm(tmp_project, { recursive: true, force: true });
  });

  it('runs the full pipeline end-to-end', async () => {
    // === Step 1: migrate-incident ===
    const migration = await migrate_incident({ flat_file_path: legacy_incident_path, vault_root });
    expect(migration.action).toBe('migrated');

    const incident_folder = migration.target_folder;
    expect(existsSync(join(incident_folder, 'narrative.md'))).toBe(true);
    expect(existsSync(join(incident_folder, 'facts.md'))).toBe(true);
    expect(existsSync(join(incident_folder, 'evidence'))).toBe(true);

    // Original file renamed for rollback
    expect(existsSync(`${legacy_incident_path}.migrated`)).toBe(true);
    expect(existsSync(legacy_incident_path)).toBe(false);

    // === Step 2: extract-facts (writer side) ===
    const extraction = await extract_facts({
      incident_folder,
      vault_root,
      project_root: tmp_project,
      accept: [
        {
          id: 'alloy-env-set-at-entrypoint-only',
          title: 'Alloy reads env only at entrypoint',
          confidence: 'high',
          claim: 'Grafana Alloy reads env vars at entrypoint; does not refresh.',
          howToVerify: '`docker exec alloy printenv VAR` after restart.',
          consequences: 'Updating .env requires a restart.',
          verifyCommand: 'docker exec alloy printenv VAULT_TOKEN | head -c 10',
        },
      ],
    });

    expect(extraction.extracted_facts).toHaveLength(1);
    expect(extraction.extracted_facts[0]!.action).toBe('created');
    expect(extraction.facts_md_updated).toBe(true);

    // The facts.md `produced:` list now includes the new fact
    const facts_md = await readFile(join(incident_folder, 'facts.md'), 'utf-8');
    expect(facts_md).toContain('alloy-env-set-at-entrypoint-only');

    // === Step 3: cite (enrich the playbook) ===
    const citation = await cite({
      playbook_path,
      fact_id: 'alloy-env-set-at-entrypoint-only',
    });

    // The playbook had no symptoms: block, so cite created one
    expect(citation.action).toBe('created_block');

    const playbook_after = await readFile(playbook_path, 'utf-8');
    expect(playbook_after).toContain('symptoms:');
    expect(playbook_after).toContain('alloy-env-set-at-entrypoint-only');

    // === Step 4: audit-facts (clean — fact was just verified) ===
    const index = await build_citer_index({
      project_root: tmp_project,
      vault_root,
      playbook_globs: [resolve(tmp_project, '.documentation/**/*.md')],
    });

    expect(index.facts.size).toBe(1);
    expect(index.incidents.size).toBe(1);

    const audit = audit_facts({
      index,
      now: new Date(), // today
      audit_window_days: 90,
    });
    expect(audit.stale).toEqual([]); // fact just created with today's last_verified

    // === Step 5: find-citers ===
    const citers = find_citers_in_index(index, 'alloy-env-set-at-entrypoint-only');
    expect(citers.fact_exists).toBe(true);
    // Note: the playbook's symptoms block was auto-created with TODO placeholders,
    // so it cites the fact and shows up as a citer.
    expect(citers.citers.length).toBeGreaterThan(0);
    expect(citers.incidents_produced_in).toContain(migration.target_folder.split('/').pop()!);
  });

  it('re-running each step is idempotent', async () => {
    // Migrate twice
    await migrate_incident({ flat_file_path: legacy_incident_path, vault_root });
    // Plant a stale flat file (simulating user re-running by mistake)
    await writeFile(legacy_incident_path, '---\ntitle: Stale\n---\n# Stale\n', 'utf-8');
    const second = await migrate_incident({ flat_file_path: legacy_incident_path, vault_root });
    expect(second.action).toBe('already_migrated');

    // Extract the same fact twice
    const incident_folder = second.target_folder;
    const accept = [
      {
        id: 'test-fact',
        title: 'Test',
        confidence: 'high' as const,
        claim: 'A claim.',
      },
    ];
    await extract_facts({ incident_folder, vault_root, project_root: tmp_project, accept });
    const second_extract = await extract_facts({
      incident_folder,
      vault_root,
      project_root: tmp_project,
      accept,
    });
    expect(second_extract.extracted_facts[0]!.action).toBe('already_exists');
  });
});
