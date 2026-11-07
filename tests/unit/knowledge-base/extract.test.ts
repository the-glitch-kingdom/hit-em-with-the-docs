import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractFacts } from '../../../src/core/knowledge-base/extract.js';

describe('extractFacts (2.3.0)', () => {
  let tmpProject: string;
  let vaultRoot: string;
  let incidentFolder: string;

  beforeEach(async () => {
    tmpProject = await mkdtemp(join(tmpdir(), 'hewtd-extract-'));
    vaultRoot = join(tmpProject, '.documentation/knowledge-base');
    incidentFolder = join(vaultRoot, 'incidents/2026-05-14-test');

    await mkdir(join(vaultRoot, 'facts'), { recursive: true });
    await mkdir(incidentFolder, { recursive: true });

    await writeFile(
      join(incidentFolder, 'narrative.md'),
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
      join(incidentFolder, 'facts.md'),
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
    await rm(tmpProject, { recursive: true, force: true });
  });

  it('writes accepted fact specs to <vault>/facts/ with provenance auto-populated', async () => {
    const result = await extractFacts({
      incidentFolder,
      vaultRoot,
      projectRoot: tmpProject,
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

    expect(result.extractedFacts).toHaveLength(2);
    expect(result.extractedFacts[0]!.action).toBe('created');
    expect(result.extractedFacts[1]!.action).toBe('created');

    // Verify file contents
    const factOne = await readFile(result.extractedFacts[0]!.factPath, 'utf-8');
    expect(factOne).toContain('tier: fact');
    expect(factOne).toContain('id: test-fact-one');
    expect(factOne).toContain('confidence: high');
    expect(factOne).toContain('verify_command:');
    expect(factOne).toContain('## Claim');
    expect(factOne).toContain('A specific claim');
    expect(factOne).toContain('## How to verify');
    expect(factOne).toContain('## Consequences');
    // Provenance points to the incident folder
    expect(factOne).toContain('.documentation/knowledge-base/incidents/2026-05-14-test/');
  });

  it('updates the incident facts.md produced: list', async () => {
    await extractFacts({
      incidentFolder,
      vaultRoot,
      projectRoot: tmpProject,
      accept: [
        {
          id: 'test-fact-one',
          title: 'First',
          confidence: 'high',
          claim: 'A claim.',
        },
      ],
    });

    const factsMd = await readFile(join(incidentFolder, 'facts.md'), 'utf-8');
    expect(factsMd).toContain('produced:');
    expect(factsMd).toContain('test-fact-one');
  });

  it('is idempotent — already-existing facts are not overwritten', async () => {
    // First pass: create the fact
    await extractFacts({
      incidentFolder,
      vaultRoot,
      projectRoot: tmpProject,
      accept: [
        {
          id: 'test-fact-one',
          title: 'Original title',
          confidence: 'high',
          claim: 'Original claim',
        },
      ],
    });

    const original = await readFile(join(vaultRoot, 'facts/test-fact-one.md'), 'utf-8');

    // Second pass: same id but different content
    const result = await extractFacts({
      incidentFolder,
      vaultRoot,
      projectRoot: tmpProject,
      accept: [
        {
          id: 'test-fact-one',
          title: 'NEW title',
          confidence: 'low',
          claim: 'DIFFERENT claim',
        },
      ],
    });

    expect(result.extractedFacts[0]!.action).toBe('already_exists');

    const after = await readFile(join(vaultRoot, 'facts/test-fact-one.md'), 'utf-8');
    expect(after).toBe(original); // unchanged
  });

  it('dry-run does not write files', async () => {
    const result = await extractFacts({
      incidentFolder,
      vaultRoot,
      projectRoot: tmpProject,
      accept: [
        {
          id: 'dry-test',
          title: 'Dry',
          confidence: 'high',
          claim: 'A claim',
        },
      ],
      dryRun: true,
    });

    expect(result.extractedFacts[0]!.action).toBe('created');
    // But file doesn't exist on disk
    let exists = true;
    try {
      await readFile(result.extractedFacts[0]!.factPath, 'utf-8');
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('writes purpose and symptoms into fact frontmatter when given', async () => {
    const r = await extractFacts({
      incidentFolder, vaultRoot, projectRoot: tmpProject,
      accept: [{ id: 'f-one', title: 'F one', confidence: 'high', claim: 'c',
        purpose: 'Why does X fail?', symptoms: ['x fails on boot', 'ERR_X'] }],
    });
    const c = r.extractedFacts[0].content;
    expect(c).toContain('purpose: Why does X fail?');
    expect(c).toMatch(/symptoms:\n  - x fails on boot\n  - ERR_X/);
  });
});
