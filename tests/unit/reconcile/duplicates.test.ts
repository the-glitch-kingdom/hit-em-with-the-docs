import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadPluginConfig } from '../../../src/utils/config';
import { findDuplicates } from '../../../src/core/reconcile/duplicates';
import { seedOverview } from '../../../src/core/reconcile/overview';
import { triage } from '../../../src/core/reconcile/triage';

let root: string;
let docs: string;
const put = (rel: string, body: string) => {
  mkdirSync(join(docs, rel, '..'), { recursive: true });
  writeFileSync(join(docs, rel), body);
};
const steps = (n: number) =>
  Array.from({ length: n }, (_, i) => `${i + 1}. Run the release step number ${i + 1} and confirm the pipeline reports green before tagging version ${i}.`).join('\n');
const filler = Array.from({ length: 400 }, (_, i) => `Admin note ${i}: rotate unrelated knob ${i * 7} weekly.`).join('\n');
const BOILER = 'Copyright notice: this document is internal and must not be shared outside the company without approval.';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dups-'));
  docs = join(root, '.documentation');
  put('procedures/release-procedure.md', `---\ntitle: Release procedure\npurpose: How to cut and tag a release\n---\n# Release procedure\n\n${steps(8)}\n\n${BOILER}\n`);
  put('guides/admin.md', `---\ntitle: Admin\n---\n# Admin\n\n${filler}\n\n## Cutting a release\n\n${steps(8)}\n\n${BOILER}\n`);
  put('misc/other.md', `---\ntitle: Other\n---\n# Other\n\n${Array.from({ length: 12 }, (_, i) => `Totally different content line ${i} about lunch menus and parking.`).join('\n')}\n\n${BOILER}\n`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('findDuplicates', () => {
  it('flags a large doc embedding a procedure, naming the procedure doc as owner', async () => {
    const d = await findDuplicates(docs, await loadPluginConfig(root));
    const hit = d.get('guides/admin.md')!;
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ owner: 'procedures/release-procedure.md', section: 'release-procedure' });
    expect(hit[0]!.overlap).toBeGreaterThanOrEqual(0.5);
    expect(d.has('procedures/release-procedure.md')).toBe(false);
  });
  it('still flags a lightly edited copy', async () => {
    put('guides/admin.md', `---\ntitle: Admin\n---\n# Admin\n\n${filler}\n\n## Cutting a release\n\n${steps(8).replace('green', 'passing').replace('step number 3', 'step 3')}\n`);
    const d = await findDuplicates(docs, await loadPluginConfig(root));
    expect(d.get('guides/admin.md')?.[0]).toMatchObject({ owner: 'procedures/release-procedure.md' });
  });
  it('ignores shared boilerplate below the size floor', async () => {
    const d = await findDuplicates(docs, await loadPluginConfig(root));
    expect(d.has('misc/other.md')).toBe(false);
  });
  it('marks a tie when neither doc names the text better', async () => {
    put('a/one.md', `---\ntitle: One\n---\n# Shared\n\n${steps(8)}\n`);
    put('b/two.md', `---\ntitle: Two\n---\n# Shared\n\n${steps(8)}\n`);
    rmSync(join(docs, 'procedures'), { recursive: true });
    rmSync(join(docs, 'guides'), { recursive: true });
    const d = await findDuplicates(docs, await loadPluginConfig(root));
    expect(d.get('b/two.md')![0]).toMatchObject({ owner: 'a/one.md' });
    expect(d.has('a/one.md')).toBe(false);
  });
});

describe('triage and overview integration', () => {
  it('raises a clean-looking copy holder to check with a reason and duplicates', async () => {
    const config = await loadPluginConfig(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'x'], { cwd: root });
    const t = await triage({ root, docsPath: docs, rels: ['guides/admin.md'], config });
    const doc = t.docs[0]!;
    expect(doc.lane).toBe('check');
    expect(doc.reasons).toContain('copy of procedures/release-procedure.md#release-procedure');
    expect(doc.duplicates?.[0]?.owner).toBe('procedures/release-procedure.md');
  });
  it('marks overview members that copy another member', async () => {
    const config = await loadPluginConfig(root);
    const seed = await seedOverview({ docsPath: docs, config, ledger: { version: 1, entries: {} }, question: 'release procedure cutting a release' });
    const admin = seed.members.find((m) => m.path === 'guides/admin.md');
    expect(admin?.duplicates?.[0]?.owner).toBe('procedures/release-procedure.md');
  });
});
