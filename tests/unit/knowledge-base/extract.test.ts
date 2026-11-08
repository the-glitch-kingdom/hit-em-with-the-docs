import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { extract_facts } from '../../../src/core/knowledge-base/extract.js';

describe('extractFacts (2.3.0)', () => {
  let tmp_project: string;
  let vault_root: string;
  let incident_folder: string;

  beforeEach(async () => {
    tmp_project = await mkdtemp(join(tmpdir(), 'hewtd-extract-'));
    vault_root = join(tmp_project, '.documentation/knowledge-base');
    incident_folder = join(vault_root, 'incidents/2026-05-14-test');

    await mkdir(join(vault_root, 'facts'), { recursive: true });
    await mkdir(incident_folder, { recursive: true });

    await writeFile(
      join(incident_folder, 'narrative.md'),
      `---
title: Test Incident
tier: incident-narrative
domains: [incidents]
status: active
last_updated: '2026-05-14'
id: 2026-05-14-test
date: '2026-05-14'
severity: medium
resolution_status: resolved
components: [test]
---

# Test Incident
`,
      'utf-8'
    );

    await writeFile(
      join(incident_folder, 'facts.md'),
      `---
title: Facts from test
tier: incident-facts
domains: [incidents]
status: active
last_updated: '2026-05-14'
incident_id: 2026-05-14-test
produced: []
---

# Facts
`,
      'utf-8'
    );
  });

  afterEach(async () => {
    await rm(tmp_project, { recursive: true, force: true });
  });

  it('writes accepted fact specs to <vault>/facts/ with provenance auto-populated', async () => {
    const result = await extract_facts({
      incident_folder,
      vault_root,
      project_root: tmp_project,
      accept: [
        {
          id: 'test-fact-one',
          title: 'First test fact',
          confidence: 'high',
          claim: 'A specific claim.',
          howToVerify: 'Run X to confirm.',
          consequences: 'It matters because Y.',
          verifyCommand: 'echo "ok"',
        },
        {
          id: 'test-fact-two',
          title: 'Second test fact',
          confidence: 'medium',
          claim: 'A different claim.',
        },
      ],
    });

    expect(result.extracted_facts).toHaveLength(2);
    expect(result.extracted_facts[0]!.action).toBe('created');
    expect(result.extracted_facts[1]!.action).toBe('created');

    // Verify file contents
    const fact_one = await readFile(result.extracted_facts[0]!.fact_path, 'utf-8');
    expect(fact_one).toContain('tier: fact');
    expect(fact_one).toContain('id: test-fact-one');
    expect(fact_one).toContain('confidence: high');
    expect(fact_one).toContain('verify_command:');
    expect(fact_one).toContain('## Claim');
    expect(fact_one).toContain('A specific claim');
    expect(fact_one).toContain('## How to verify');
    expect(fact_one).toContain('## Consequences');
    // Provenance points to the incident folder
    expect(fact_one).toContain('.documentation/knowledge-base/incidents/2026-05-14-test/');
  });

  it('updates the incident facts.md produced: list', async () => {
    await extract_facts({
      incident_folder,
      vault_root,
      project_root: tmp_project,
      accept: [
        {
          id: 'test-fact-one',
          title: 'First',
          confidence: 'high',
          claim: 'A claim.',
        },
      ],
    });

    const facts_md = await readFile(join(incident_folder, 'facts.md'), 'utf-8');
    expect(facts_md).toContain('produced:');
    expect(facts_md).toContain('test-fact-one');
  });

  it('is idempotent — already-existing facts are not overwritten', async () => {
    // First pass: create the fact
    await extract_facts({
      incident_folder,
      vault_root,
      project_root: tmp_project,
      accept: [
        {
          id: 'test-fact-one',
          title: 'Original title',
          confidence: 'high',
          claim: 'Original claim',
        },
      ],
    });

    const original = await readFile(join(vault_root, 'facts/test-fact-one.md'), 'utf-8');

    // Second pass: same id but different content
    const result = await extract_facts({
      incident_folder,
      vault_root,
      project_root: tmp_project,
      accept: [
        {
          id: 'test-fact-one',
          title: 'NEW title',
          confidence: 'low',
          claim: 'DIFFERENT claim',
        },
      ],
    });

    expect(result.extracted_facts[0]!.action).toBe('already_exists');

    const after = await readFile(join(vault_root, 'facts/test-fact-one.md'), 'utf-8');
    expect(after).toBe(original); // unchanged
  });

  it('dry-run does not write files', async () => {
    const result = await extract_facts({
      incident_folder,
      vault_root,
      project_root: tmp_project,
      accept: [
        {
          id: 'dry-test',
          title: 'Dry',
          confidence: 'high',
          claim: 'A claim',
        },
      ],
      dry_run: true,
    });

    expect(result.extracted_facts[0]!.action).toBe('created');
    // But file doesn't exist on disk
    let exists = true;
    try {
      await readFile(result.extracted_facts[0]!.fact_path, 'utf-8');
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('writes purpose and symptoms into fact frontmatter when given', async () => {
    const r = await extract_facts({
      incident_folder, vault_root, project_root: tmp_project,
      accept: [{ id: 'f-one', title: 'F one', confidence: 'high', claim: 'c',
        purpose: 'Why does X fail?', symptoms: ['x fails on boot', 'ERR_X'] }],
    });
    const c = r.extracted_facts[0].content;
    expect(c).toContain('purpose: Why does X fail?');
    expect(c).toMatch(/symptoms:\n  - x fails on boot\n  - ERR_X/);
  });
});
