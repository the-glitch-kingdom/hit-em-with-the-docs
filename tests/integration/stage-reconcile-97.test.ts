import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// #97: `reconcile --stage <dir>` snapshots the live docs tree; `--staged <dir>` runs reconcile on the copy only.
const CLI = join(resolve(__dirname, '../..'), 'dist/cli/index.js');
let root: string;
let docs: string;

const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf-8' }).trim();
const hewtd = (args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8' });
const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
const fm = (title: string, extra = '') => `---\ntitle: ${title}\ndomains:\n  - backend\n${extra}---\n\n# ${title}\n\nBody of ${title}.\n`;
const files_of = (dir: string): string => (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[]).sort().map((rel) => { try { return `${rel}=${readFileSync(join(dir, rel), 'utf8')}`; } catch { return `${rel}/`; } }).join('\n');
/** Everything the live side owns: docs bytes, git HEAD + status, and no hewtd state files besides the stage. */
const live_state = (): string => [files_of(docs), g('rev-parse', 'HEAD'), g('status', '--porcelain', '--ignored'), existsSync(join(root, '.hewtd/graph.json')), existsSync(join(root, '.hewtd/reconcile.json')), existsSync(join(root, '.hewtd/reconcile'))].join('\n--\n');

beforeAll(() => { if (!existsSync(CLI)) throw new Error('run `npm run build` before the integration tests'); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stage-97-'));
  docs = join(root, '.documentation');
  put('src/real.ts', 'export const realThing = 1;\n');
  put('.documentation/backend/a.md', fm('a') + '\nSee `src/real.ts`.\n');
  put('.documentation/backend/b.md', fm('b') + '\nSee `src/real.ts` and `src/gone.ts`.\n');
  put('.documentation/archive/backend/old.md', fm('old'));
  put('.documentation/reports/run.md', 'generated report, gitignored\n');
  put('.gitignore', '.hewtd/\n.documentation/reports/\n');
  g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('reconcile --stage / --staged (#97, acceptance)', () => {
  it('stages the working tree (archive/ and gitignored files included) and reconciles only the copy', () => {
    const stage = join(root, '.hewtd/stage');
    const staged = hewtd(['reconcile', '--stage', stage]);
    expect(staged.status, staged.stderr).toBe(0);
    expect(files_of(join(stage, 'docs'))).toBe(files_of(docs));
    expect(JSON.parse(readFileSync(join(stage, 'stage.json'), 'utf8'))).toMatchObject({ format: 1, docs_path: '.documentation', source_commit: g('rev-parse', 'HEAD') });

    const before = live_state();
    expect(hewtd(['reconcile', '--staged', stage, 'backend', '--write-review']).status).toBe(0);
    const review = readdirSync(join(stage, 'reconcile')).filter((f) => /^review-.*\.md$/.test(f)).map((f) => join(stage, 'reconcile', f))[0]!;
    writeFileSync(review, readFileSync(review, 'utf8').split(/^(?=## )/m).map((sec) => {
      const m = /```json\n([\s\S]*?)\n```/.exec(sec);
      if (!m) return sec;
      return sec.replace(m[1]!, JSON.stringify({ ...JSON.parse(m[1]!), verdict: 'verify', sources: ['src/real.ts'] }, null, 2)).replace('- [ ] accept', '- [x] accept');
    }).join(''));
    const applied = hewtd(['reconcile', '--staged', stage, '--apply', review]);
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    expect(applied.stdout).toContain('applied 2');

    expect(readFileSync(join(stage, 'docs/backend/a.md'), 'utf8')).toContain('src/real.ts');
    expect(readFileSync(join(stage, 'docs/backend/a.md'), 'utf8')).not.toBe(readFileSync(join(docs, 'backend/a.md'), 'utf8'));
    expect(existsSync(join(stage, 'ledger.json'))).toBe(true);
    expect(live_state()).toBe(before);
  });
});

describe('reconcile --stage / --staged refusals (#97)', () => {
  it('--stage refuses a non-empty dir, a dir inside the docs, and changes nothing', () => {
    put('.hewtd/busy/x', 'x');
    const before = live_state();
    expect(hewtd(['reconcile', '--stage', join(root, '.hewtd/busy')]).status).toBe(1);
    expect(hewtd(['reconcile', '--stage', join(docs, 'inside')]).status).toBe(1);
    expect(existsSync(join(docs, 'inside'))).toBe(false);
    expect(live_state()).toBe(before);
  });

  it('--staged refuses a missing stage, -p, and --stage together', () => {
    const stage = join(root, '.hewtd/stage');
    expect(hewtd(['reconcile', '--staged', stage, '--status']).status).toBe(1);
    expect(hewtd(['reconcile', '--stage', stage]).status).toBe(0);
    const with_path = hewtd(['reconcile', '--staged', stage, '-p', '.documentation', '--status']);
    expect(with_path.status).toBe(1);
    expect(with_path.stderr + with_path.stdout).toContain('cannot be combined');
    expect(hewtd(['reconcile', '--staged', stage, '--stage', stage]).status).toBe(1);
  });

  it('--staged apply refuses the secret verdict (it would write .env.hewtd in the live repo)', () => {
    const stage = join(root, '.hewtd/stage');
    hewtd(['reconcile', '--stage', stage]);
    hewtd(['reconcile', '--staged', stage, 'backend/a.md', '--write-review']);
    const review = readdirSync(join(stage, 'reconcile')).map((f) => join(stage, 'reconcile', f))[0]!;
    writeFileSync(review, readFileSync(review, 'utf8').replace(/"verdict": null/, '"verdict": "secret"').replace('- [ ] accept', '- [x] accept'));
    const r = hewtd(['reconcile', '--staged', stage, '--apply', review]);
    expect(r.stdout).toContain('[error]');
    expect(existsSync(join(root, '.env.hewtd'))).toBe(false);
  });
});
