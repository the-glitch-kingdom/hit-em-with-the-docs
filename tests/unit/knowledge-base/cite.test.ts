import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { cite } from '../../../src/core/knowledge-base/cite.js';

describe('cite (2.3.0)', () => {
  let tmp_dir: string;
  let playbook_path: string;

  beforeEach(async () => {
    tmp_dir = await mkdtemp(join(tmpdir(), 'hewtd-cite-'));
    playbook_path = join(tmp_dir, 'runbook.md');
  });

  afterEach(async () => {
    await rm(tmp_dir, { recursive: true, force: true });
  });

  it('inserts a cites: entry into the first symptoms block', async () => {
    await writeFile(
      playbook_path,
      `---
title: Runbook
tier: admin
domains: [observability]
status: active
last_updated: '2026-05-14'
version: '1.0.0'
symptoms:
  - alert_name: "Some Alert"
    target: "#some-alert"
    cites:
      - existing-fact
---

# Runbook
`,
      'utf-8'
    );

    const result = await cite({
      playbookPath: playbook_path,
      factId: 'new-fact',
    });

    expect(result.action).toBe('inserted');
    expect(result.symptomIndex).toBe(0);

    const updated = await readFile(playbook_path, 'utf-8');
    expect(updated).toContain('existing-fact');
    expect(updated).toContain('new-fact');
  });

  it('is idempotent — re-citing the same fact is a no-op', async () => {
    await writeFile(
      playbook_path,
      `---
title: Runbook
tier: admin
domains: [observability]
status: active
last_updated: '2026-05-14'
version: '1.0.0'
symptoms:
  - alert_name: "Some Alert"
    target: "#some-alert"
    cites:
      - my-fact
---

# Runbook
`,
      'utf-8'
    );

    const original = await readFile(playbook_path, 'utf-8');
    const result = await cite({
      playbookPath: playbook_path,
      factId: 'my-fact',
    });

    expect(result.action).toBe('already_present');

    const after = await readFile(playbook_path, 'utf-8');
    expect(after).toBe(original); // byte-identical — file untouched
  });

  it('creates a symptoms block when none exists', async () => {
    await writeFile(
      playbook_path,
      `---
title: Runbook
tier: admin
domains: [observability]
status: active
last_updated: '2026-05-14'
version: '1.0.0'
---

# Runbook
`,
      'utf-8'
    );

    const result = await cite({
      playbookPath: playbook_path,
      factId: 'new-fact',
    });

    expect(result.action).toBe('created_block');

    const updated = await readFile(playbook_path, 'utf-8');
    expect(updated).toContain('symptoms:');
    expect(updated).toContain('new-fact');
    expect(updated).toContain('TODO'); // placeholder for the new symptom entry
  });

  it('targets a specific symptom entry by alert_name', async () => {
    await writeFile(
      playbook_path,
      `---
title: Runbook
tier: admin
domains: [observability]
status: active
last_updated: '2026-05-14'
version: '1.0.0'
symptoms:
  - alert_name: "Alert A"
    target: "#alert-a"
    cites:
      - fact-a
  - alert_name: "Alert B"
    target: "#alert-b"
    cites:
      - fact-b
---

# Runbook
`,
      'utf-8'
    );

    const result = await cite({
      playbookPath: playbook_path,
      factId: 'new-fact',
      symptomMatch: { alert_name: 'Alert B' },
    });

    expect(result.action).toBe('inserted');
    expect(result.symptomIndex).toBe(1);

    const updated = await readFile(playbook_path, 'utf-8');
    // Alert B should have new-fact; Alert A should NOT.
    const parsed = await import('gray-matter').then((m) => m.default(updated));
    const symptoms = parsed.data.symptoms as Array<{ alert_name: string; cites: string[] }>;
    expect(symptoms[0]!.cites).toEqual(['fact-a']);
    expect(symptoms[1]!.cites).toEqual(['fact-b', 'new-fact']);
  });

  it('dry-run does not write the file', async () => {
    await writeFile(
      playbook_path,
      `---
title: Runbook
tier: admin
domains: [observability]
status: active
last_updated: '2026-05-14'
version: '1.0.0'
symptoms:
  - alert_name: "Alert"
    target: "#alert"
    cites:
      - existing
---

# Runbook
`,
      'utf-8'
    );

    const original = await readFile(playbook_path, 'utf-8');
    const result = await cite({
      playbookPath: playbook_path,
      factId: 'new-fact',
      dryRun: true,
    });

    expect(result.action).toBe('inserted');
    expect(result.newContent).toContain('new-fact');

    const after = await readFile(playbook_path, 'utf-8');
    expect(after).toBe(original); // unchanged on disk
  });
  it('skips plain-string symptoms on a non-fact tier (#46, #50)', async () => {
    const fm = (symptoms: string) =>
      `---\ntitle: F\ntier: guide\ndomains: [observability]\nstatus: active\nlast_updated: '2026-10-25'\n${symptoms}---\n\n# F\n`;

    // A string first, an object second → the cite goes on the object.
    await writeFile(
      playbook_path,
      fm('symptoms:\n  - "pkill -f: Exit code 144"\n  - error_pattern: "x"\n    target: "#a"\n    cites: [old]\n'),
      'utf-8'
    );
    const on_object = await cite({ playbookPath: playbook_path, factId: 'new-fact' });
    expect(on_object.action).toBe('inserted');
    expect(on_object.symptomIndex).toBe(1);

    // Only strings → a placeholder entry is appended; the strings stay.
    await writeFile(playbook_path, fm('symptoms:\n  - "pkill -f: Exit code 144"\n'), 'utf-8');
    const appended = await cite({ playbookPath: playbook_path, factId: 'new-fact' });
    expect(appended.action).toBe('created_block');
    expect(appended.symptomIndex).toBe(1);
    const after = await readFile(playbook_path, 'utf-8');
    expect(after).toContain('pkill -f: Exit code 144');
    expect(after).toContain('new-fact');
  });
});
