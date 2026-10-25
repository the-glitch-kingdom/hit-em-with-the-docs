import { describe, it, expect } from 'vitest';
import { resolve } from 'path';
import {
  buildCiterIndex,
  findCitersInIndex,
  citerCount,
} from '../../../src/core/knowledge-base/citers.js';

const VALID_FIXTURE_ROOT = resolve(__dirname, '../../fixtures/knowledge-base/valid');

describe('buildCiterIndex (2.3.0)', () => {
  it('walks facts/, incidents/, and playbooks/ and resolves the citation graph', async () => {
    const index = await buildCiterIndex({
      projectRoot: VALID_FIXTURE_ROOT,
      vaultRoot: VALID_FIXTURE_ROOT,
      playbookGlobs: [resolve(VALID_FIXTURE_ROOT, 'playbooks/*.md')],
    });

    // Facts
    expect(index.facts.size).toBe(1);
    expect(index.facts.has('alloy-env-set-at-entrypoint-only')).toBe(true);
    const fact = index.facts.get('alloy-env-set-at-entrypoint-only')!;
    expect(fact.title).toBe('Alloy reads env only at entrypoint');
    expect(fact.confidence).toBe('high');
    expect(fact.lastVerified).toBe('2026-05-14');
    expect(fact.tags).toContain('alloy');

    // Incidents
    expect(index.incidents.size).toBe(1);
    expect(index.incidents.has('2026-05-14-vault-alloy-stuck')).toBe(true);
    const inc = index.incidents.get('2026-05-14-vault-alloy-stuck')!;
    expect(inc.severity).toBe('high');
    expect(inc.resolution_status).toBe('resolved');
    expect(inc.produced).toContain('alloy-env-set-at-entrypoint-only');

    // Citers — playbook cites the fact twice (alert_name + user_phrase entries)
    const citationList = index.citers.get('alloy-env-set-at-entrypoint-only');
    expect(citationList).toBeDefined();
    expect(citationList!.length).toBeGreaterThan(0);
    // Distinct playbook count (citerCount dedups by relPath)
    expect(citerCount(index, 'alloy-env-set-at-entrypoint-only')).toBe(1);
  });

  it('returns an empty index when vault root has no facts and no incidents', async () => {
    const index = await buildCiterIndex({
      projectRoot: '/tmp',
      vaultRoot: '/tmp/nonexistent-vault',
      playbookGlobs: [],
    });
    expect(index.facts.size).toBe(0);
    expect(index.incidents.size).toBe(0);
    expect(index.citers.size).toBe(0);
  });
});

describe('findCitersInIndex (2.3.0)', () => {
  it('returns typed structure for an existing fact', async () => {
    const index = await buildCiterIndex({
      projectRoot: VALID_FIXTURE_ROOT,
      vaultRoot: VALID_FIXTURE_ROOT,
      playbookGlobs: [resolve(VALID_FIXTURE_ROOT, 'playbooks/*.md')],
    });

    const result = findCitersInIndex(index, 'alloy-env-set-at-entrypoint-only');

    expect(result.fact_id).toBe('alloy-env-set-at-entrypoint-only');
    expect(result.fact_exists).toBe(true);
    expect(result.citers).toEqual(['playbooks/grafana-alerts-runbook.md']);
    expect(result.incidents_produced_in).toContain('2026-05-14-vault-alloy-stuck');
    expect(result.incidents_strengthened_by).toEqual([]);
    expect(result.incidents_weakened_by).toEqual([]);
  });

  it('returns fact_exists=false for a dangling reference', async () => {
    const index = await buildCiterIndex({
      projectRoot: VALID_FIXTURE_ROOT,
      vaultRoot: VALID_FIXTURE_ROOT,
      playbookGlobs: [resolve(VALID_FIXTURE_ROOT, 'playbooks/*.md')],
    });

    const result = findCitersInIndex(index, 'nonexistent-fact-id');
    expect(result.fact_exists).toBe(false);
    expect(result.citers).toEqual([]);
    expect(result.incidents_produced_in).toEqual([]);
  });

  it('sorts citers, incidents, and ids alphabetically (deterministic output)', async () => {
    const index = await buildCiterIndex({
      projectRoot: VALID_FIXTURE_ROOT,
      vaultRoot: VALID_FIXTURE_ROOT,
      playbookGlobs: [resolve(VALID_FIXTURE_ROOT, 'playbooks/*.md')],
    });
    const result = findCitersInIndex(index, 'alloy-env-set-at-entrypoint-only');

    const sortedCiters = [...result.citers].sort();
    expect(result.citers).toEqual(sortedCiters);

    const sortedIncidents = [...result.incidents_produced_in].sort();
    expect(result.incidents_produced_in).toEqual(sortedIncidents);
  });
});

describe('plain-string symptoms (#46)', () => {
  it('ignores string entries and still records object entries', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const root = await mkdtemp(join(tmpdir(), 'hewtd-citers-'));
    try {
      await mkdir(join(root, 'playbooks'));
      await mkdir(join(root, 'facts'));
      // The fact carries a string symptom too (the semantic-memory shape).
      await writeFile(
        join(root, 'facts', 'some-fact.md'),
        `---\ntitle: F\ntier: fact\nid: some-fact\nsymptoms:\n  - "Exit code 144"\n---\n# F\n`,
        'utf-8'
      );
      await writeFile(
        join(root, 'playbooks', 'p.md'),
        `---\ntitle: P\nsymptoms:\n  - "Exit code 144"\n  - error_pattern: "x"\n    target: "#a"\n    cites: [some-fact]\n---\n# P\n`,
        'utf-8'
      );
      const index = await buildCiterIndex({
        projectRoot: root,
        vaultRoot: root,
        playbookGlobs: [join(root, 'playbooks/*.md')],
      });
      expect(index.citers.get('some-fact')).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
