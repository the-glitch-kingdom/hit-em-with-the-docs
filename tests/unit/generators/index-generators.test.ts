import { describe, it, expect } from 'vitest';
import { join, resolve } from 'path';
import { build_citer_index } from '../../../src/core/knowledge-base/citers.js';
import { render_facts_index } from '../../../src/generators/facts-index.js';
import { render_incidents_index } from '../../../src/generators/incidents-index.js';
import { render_symptoms_index } from '../../../src/generators/symptoms-index.js';

const VALID_FIXTURE_ROOT = resolve(__dirname, '../../fixtures/knowledge-base/valid');

async function build_index() {
  return build_citer_index({
    project_root: VALID_FIXTURE_ROOT,
    vault_root: VALID_FIXTURE_ROOT,
    playbook_globs: [resolve(VALID_FIXTURE_ROOT, 'playbooks/*.md')],
  });
}

describe('renderFactsIndex (2.3.0)', () => {
  it('produces deterministic, byte-identical output across runs', async () => {
    const index = await build_index();
    const out1 = render_facts_index(index);
    const out2 = render_facts_index(index);
    expect(out1).toBe(out2);
  });

  it('snapshot for the valid fixture', async () => {
    const index = await build_index();
    expect(render_facts_index(index)).toMatchSnapshot();
  });

  it('emits "no facts yet" message when index is empty', async () => {
    const empty = await build_citer_index({
      project_root: '/tmp',
      vault_root: '/tmp/nonexistent',
      playbook_globs: [],
    });
    const out = render_facts_index(empty);
    expect(out).toContain('No facts yet');
    // Still has well-formed frontmatter
    expect(out.startsWith('---\n')).toBe(true);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('uses \\n line endings only (no \\r\\n)', async () => {
    const index = await build_index();
    const out = render_facts_index(index);
    expect(out.includes('\r')).toBe(false);
  });

  it('starts with frontmatter and ends with a single trailing newline', async () => {
    const index = await build_index();
    const out = render_facts_index(index);
    expect(out.startsWith('---\n')).toBe(true);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });
});

describe('renderIncidentsIndex (2.3.0)', () => {
  it('produces deterministic output across runs', async () => {
    const index = await build_index();
    expect(render_incidents_index(index)).toBe(render_incidents_index(index));
  });

  it('snapshot for the valid fixture', async () => {
    const index = await build_index();
    expect(render_incidents_index(index)).toMatchSnapshot();
  });

  it('sorts by date descending', async () => {
    const index = await build_index();
    // Manually inject a second, older incident to verify sort order.
    index.incidents.set('2026-04-01-test-older', {
      id: '2026-04-01-test-older',
      folder_path: '/tmp/older',
      rel_folder_path: 'incidents/2026-04-01-test-older',
      title: 'Older Test Incident',
      date: '2026-04-01',
      severity: 'low',
      resolution_status: 'resolved',
      components: ['test'],
      produced: [],
      strengthened: [],
      weakened: [],
    });

    const out = render_incidents_index(index);
    const newer_idx = out.indexOf('2026-05-14-vault-alloy-stuck');
    const older_idx = out.indexOf('2026-04-01-test-older');
    expect(newer_idx).toBeGreaterThan(0);
    expect(older_idx).toBeGreaterThan(0);
    expect(newer_idx).toBeLessThan(older_idx); // newer appears first
  });

  it('emits "no incidents yet" message when index is empty', async () => {
    const empty = await build_citer_index({
      project_root: '/tmp',
      vault_root: '/tmp/nonexistent',
      playbook_globs: [],
    });
    expect(render_incidents_index(empty)).toContain('No incidents yet');
  });
});

describe('renderSymptomsIndex (2.3.0)', () => {
  it('produces deterministic output across runs', async () => {
    const index = await build_index();
    expect(render_symptoms_index(index)).toBe(render_symptoms_index(index));
  });

  it('snapshot for the valid fixture', async () => {
    const index = await build_index();
    expect(render_symptoms_index(index)).toMatchSnapshot();
  });

  it('groups by symptom kind (alert_name, user_phrase, error_pattern)', async () => {
    const index = await build_index();
    const out = render_symptoms_index(index);
    // Valid fixture has an alert_name and a user_phrase block.
    expect(out).toContain('## Alert names');
    expect(out).toContain('## User phrases');
  });

  // #23: the href must resolve from the index's OWN directory. `playbookRelPath` is
  // relative to projectRoot, and the index is written to <vaultRoot>/symptoms/, so using it
  // as the href produced <vaultRoot>/symptoms/<projectRelPath> — broken for every playbook.
  it('makes playbook hrefs relative to the symptoms dir, not the project root', async () => {
    const index = await build_index();
    const symptoms_dir = join(VALID_FIXTURE_ROOT, 'symptoms');
    const out = render_symptoms_index(index, symptoms_dir);

    // Label stays project-relative; href climbs out of symptoms/ first.
    expect(out).toMatch(/\]\(\.\.\//);
    // No href may start with the project-relative path, which is what the bug emitted.
    expect(out).not.toMatch(/\]\((?!\.\.\/|https?:|#)/);
  });

  it('falls back to the project-relative href when no symptoms dir is given', async () => {
    // Back-compat: the parameter is optional, so existing callers keep prior behaviour.
    const index = await build_index();
    expect(render_symptoms_index(index)).toBe(render_symptoms_index(index, undefined));
  });

  it('emits "no symptoms" message when index has no citers', async () => {
    const empty = await build_citer_index({
      project_root: '/tmp',
      vault_root: '/tmp/nonexistent',
      playbook_globs: [],
    });
    expect(render_symptoms_index(empty)).toContain('No symptoms blocks found');
  });
});
