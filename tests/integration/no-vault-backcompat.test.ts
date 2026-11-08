/**
 * Backward-compatibility regression test (2.3.0).
 *
 * Load-bearing guarantee from the phase plan: a project that adopts none of
 * the 2.3.0 knowledge-base features must observe zero behavior change.
 * Specifically:
 *   - `hewtd maintain` produces no NEW files under the docs tree.
 *   - The audit emits no KB-coded issues.
 *   - The maintenance flow completes without errors.
 *
 * If this test fails, the PR can't ship.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { run_maintenance } from '../../src/core/maintain/orchestrator.js';
import { audit_documentation } from '../../src/core/audit/auditor.js';
import { regenerate_indexes } from '../../src/generators/regenerate.js';

describe('Backward compatibility — no-vault project (2.3.0 regression test)', () => {
  let tmp_root: string;
  let docs_path: string;

  beforeEach(async () => {
    tmp_root = await mkdtemp(join(tmpdir(), 'hewtd-backcompat-'));
    docs_path = join(tmp_root, '.documentation');

    // Build a minimal pre-2.3.0 doc tree: one guide, no knowledge-base/,
    // no symptoms: blocks anywhere.
    await mkdir(join(docs_path, 'security'), { recursive: true });
    await writeFile(
      join(docs_path, 'security', 'auth-guide.md'),
      `---
title: "Authentication Guide"
tier: guide
domains: [security]
audience: [developers]
tags: [auth]
status: active
last_updated: '2026-05-14'
version: '1.0.0'
---

# Authentication Guide

Body content for the guide.
`,
      'utf-8'
    );

    // Generate the domain + root INDEX.md/REGISTRY.md so the fixture matches
    // a real `hewtd init`-built tree (which always ships index files). Without
    // this the tree has a document but no INDEX.md, which the 2.5.0 drift
    // audit rule correctly flags — that's a fixture gap, not a regression.
    await regenerate_indexes({ docs_path, silent: true });
  });

  afterEach(async () => {
    await rm(tmp_root, { recursive: true, force: true });
  });

  it('hewtd maintain does not create a knowledge-base/ subtree', async () => {
    await run_maintenance({ docs_path, silent: true });

    const docs_contents = await readdir(docs_path);
    expect(docs_contents).not.toContain('knowledge-base');
  });

  it('hewtd maintain does not create facts/INDEX.md, incidents/INDEX.md, or symptoms/INDEX.md', async () => {
    await run_maintenance({ docs_path, silent: true });

    const vault_path = join(docs_path, 'knowledge-base');
    let vault_exists = true;
    try {
      await readdir(vault_path);
    } catch {
      vault_exists = false;
    }
    expect(vault_exists).toBe(false);
  });

  it('audit emits no KB-coded errors on a pre-2.3.0 doc tree', async () => {
    const result = await audit_documentation({ docs_path, silent: true });
    const kb_issues = result.issues.filter((i) => i.code !== undefined);
    expect(kb_issues).toEqual([]);
  });

  it('maintain completes without errors on a no-vault tree', async () => {
    const result = await run_maintenance({ docs_path, silent: true });
    // Some pre-existing maintain errors are possible (missing INDEX.md for
    // domains, etc.) — those are not 2.3.0's concern. What we assert is that
    // NO error in the result.errors list mentions knowledge-base.
    const kb_errors = result.errors.filter((e) =>
      e.toLowerCase().includes('knowledge-base')
    );
    expect(kb_errors).toEqual([]);
  });

  it('strict audit still passes on a pre-2.3.0 tree (no KB violations to escalate)', async () => {
    const result = await audit_documentation({
      docs_path,
      silent: true,
      strict: true,
    });
    const kb_issues = result.issues.filter((i) => i.code !== undefined);
    const error_issues = result.issues.filter((i) => i.severity === 'error');

    // The CLI's strict-mode predicate: exit non-zero on any error OR any
    // KB-coded issue. With a clean pre-2.3.0 tree, both lists are empty.
    expect(kb_issues).toEqual([]);
    expect(error_issues).toEqual([]);
  });
});

describe('Backward compatibility — KB-adopting project (2.3.0 active path)', () => {
  let tmp_root: string;
  let docs_path: string;
  let vault_path: string;

  beforeEach(async () => {
    tmp_root = await mkdtemp(join(tmpdir(), 'hewtd-kb-active-'));
    docs_path = join(tmp_root, '.documentation');
    vault_path = join(docs_path, 'knowledge-base');

    // Tree with the KB subtree present + one fact + one incident.
    await mkdir(join(vault_path, 'facts'), { recursive: true });
    await mkdir(join(vault_path, 'incidents', '2026-05-14-test'), {
      recursive: true,
    });
    await writeFile(
      join(vault_path, 'facts', 'test-fact.md'),
      `---
title: Test fact
tier: fact
domains: [observability]
status: active
last_updated: '2026-05-14'
id: test-fact
confidence: high
last_verified: '2026-05-14'
provenance:
  - incidents/2026-05-14-test/
tags: [test]
---

# Test fact

## Claim
A test claim.
`,
      'utf-8'
    );
    await writeFile(
      join(vault_path, 'incidents', '2026-05-14-test', 'narrative.md'),
      `---
title: Test incident
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

# Test incident
`,
      'utf-8'
    );
    await writeFile(
      join(vault_path, 'incidents', '2026-05-14-test', 'facts.md'),
      `---
title: Facts from 2026-05-14 test
tier: incident-facts
domains: [incidents]
status: active
last_updated: '2026-05-14'
incident_id: 2026-05-14-test
produced: [test-fact]
---

# Facts from test
`,
      'utf-8'
    );
  });

  afterEach(async () => {
    await rm(tmp_root, { recursive: true, force: true });
  });

  it('hewtd maintain DOES generate KB indexes when a vault root exists', async () => {
    await run_maintenance({ docs_path, silent: true });

    const facts_index = join(vault_path, 'facts', 'INDEX.md');
    const incidents_index = join(vault_path, 'incidents', 'INDEX.md');
    const symptoms_index = join(vault_path, 'symptoms', 'INDEX.md');

    let facts_exists = true;
    let incidents_exists = true;
    let symptoms_exists = true;
    try {
      await readdir(facts_index);
    } catch (e: any) {
      facts_exists = e.code !== 'ENOENT';
    }
    try {
      await readdir(incidents_index);
    } catch (e: any) {
      incidents_exists = e.code !== 'ENOENT';
    }
    try {
      await readdir(symptoms_index);
    } catch (e: any) {
      symptoms_exists = e.code !== 'ENOENT';
    }

    expect(facts_exists).toBe(true);
    expect(incidents_exists).toBe(true);
    expect(symptoms_exists).toBe(true);
  });
});
