import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check_security_gate, is_constant_value } from '../../../src/core/security/gate.js';
import { classify_gaps, parse_gaps } from '../../../src/core/reconcile/gaps.js';
import { render_gaps_report } from '../../../src/core/reconcile/gaps-report.js';
import { load_plugin_config } from '../../../src/utils/config.js';

const config = { allow: [], disabled_rules: [] };
const rules = (text: string): string[] => check_security_gate(text, 'draft', config).map((finding) => finding.rule);

describe('gate: code constants pass, values do not (#115)', () => {
  it('numbers, arithmetic, durations and sizes assigned to a named constant are not config values', () => {
    for (const text of ['CHUNK_SIZE = 10 * 1024 * 1024', 'MAX_FILE_SIZE = 2 * 1024 * 1024;', 'TIMEOUT_MS = 30 * 1000', 'IDLE_TIMEOUT = 30 * time.Second', 'RETRY_LIMIT: 5', 'UPLOAD_TTL = 24 * 3600  # seconds', 'MAX_BYTES = 10MB', 'WINDOW = Duration.ofMinutes(15)'])
      expect(rules(text), text).toEqual([]);
    expect(is_constant_value('(2 + 3) * 1_000')).toBe(true);
  });
  it('env and config defaults, quoted values and names that hold a host, port, id, url or credential stay blocked', () => {
    for (const text of ['API_BASE = "x"', 'MODE = fast', 'const t = process.env.T ?? 30', 'x = os.environ.get("T", "30")', 'v = getenv("T", "30")', 'url: ${HOST:-db}', 'default: 30', 'the timeout defaults to 30', 'DB_PORT = 5432', 'REGION_ID = 12345678', 'API_TOKEN = 123456', 'set CACHE_TTL=3600 in the env'])
      expect(rules(text), text).toContain('config-value');
  });
  it('a host, port or IP is still blocked wherever it is written', () => {
    expect(rules('PORT = 8080')).toContain('port');
    expect(rules('LIMIT = 5\nhost 10.1.2.3')).toContain('ip-address');
  });
});

let repo: string, ctx: { docs_root: string; repo_root: string };
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'gate115-'));
  mkdirSync(join(repo, '.documentation/ops'), { recursive: true });
  writeFileSync(join(repo, '.documentation/ops/a.md'), '# a\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  ctx = { docs_root: join(repo, '.documentation'), repo_root: repo };
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const classify = async (gaps: object[]) => classify_gaps(parse_gaps(JSON.stringify(gaps), ctx).gaps, { root: repo, docs_root: ctx.docs_root, config: await load_plugin_config(repo) });

describe('classify_gaps: one bad facet never drops the question (#115)', () => {
  it('size-constant facets are classified normally', async () => {
    const result = await classify([{ id: 'u', query: 'what are the upload limits', facets: ['CHUNK_SIZE = 10 \\* 1024 \\* 1024', 'MAX_FILE_SIZE\\s*=\\s*2 \\* 1024 \\* 1024', 'TIMEOUT_MS = 30 \\* 1000'] }]);
    expect(result.facet_gaps[0]!.facets).toHaveLength(3);
    expect(result.dropped).toEqual([]);
    expect(result.held_back).toBeUndefined();
  });
  it('a credential-shaped facet is withheld, the other facets keep the miss classified, nothing is quoted', async () => {
    const secret = 'AK' + 'IA' + 'Q7ZR3LMP9XVB2NCK';
    const result = await classify([{ id: 'k', query: 'which key does deploy use', facets: [secret, 'deploy_step'] }]);
    expect(result.facet_gaps[0]!.facets).toEqual(['deploy_step']);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('every facet withheld: the miss stays as needs-a-human with the reason, not dropped, value-free', async () => {
    const result = await classify([{ id: 'h', query: 'where is the database', facets: ['db-prod\\.acme-corp\\.internal', '10\\.20\\.30\\.40'] }]);
    expect(result.facet_gaps).toEqual([]);
    expect(result.held_back).toEqual([{ keys: ['h'], reason: expect.stringMatching(/every facet withheld.*(?:hostname|environment-resource).*ip-address|every facet withheld.*ip-address.*(?:hostname|environment-resource)/) }]); // db-prod.* is also an environment resource name (3.6.0 review)
    const report = render_gaps_report(result, config);
    expect(report).toContain('h');
    expect(report).toMatch(/needs a human/);
    for (const value of ['acme-corp', '10.20.30.40', '10\\.20']) expect(report + JSON.stringify(result)).not.toContain(value);
  });
  it('a usage-log file without facets has no held_back key (3.4.1 shape)', async () => {
    expect(Object.keys(await classify([{ query: 'where is the zzz thing' }])).sort()).toEqual(['candidates', 'dropped', 'facet_gaps', 'proposals', 'questions', 'warnings']);
  });
});
