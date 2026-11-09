#!/usr/bin/env node
// Benchmark `hewtd index` (with graph export): cold, warm-unchanged, one doc edited, one code file edited.
// Not part of CI. Usage: node scripts/bench-graph.mjs [path/to/dist/cli/index.js] [docs=900] [code=400]
// Set HEWTD_TIMING=1 (done here) to print per-stage timings from build_graph.
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(process.argv[2] ?? join(here, '..', 'dist', 'cli', 'index.js'));
const doc_count = Number(process.argv[3] ?? 900);
const code_count = Number(process.argv[4] ?? 400);
const domains = ['guides', 'procedures', 'architecture', 'reference', 'operations', 'testing'];

const dir = mkdtempSync(join(tmpdir(), 'bench-graph-'));
const docs = join(dir, '.documentation');
const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'b', GIT_AUTHOR_EMAIL: 'b@b', GIT_COMMITTER_NAME: 'b', GIT_COMMITTER_EMAIL: 'b@b' } });
const put = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
const code_file = (i) => `src/mod${i % 20}/unit${i}.ts`;

try {
  git('init', '-q');
  for (let i = 0; i < code_count; i++) put(code_file(i), `export function benchUnit${i}() { return ${i}; }\nexport const BENCH_LIMIT_${i} = ${i};\n`);
  for (let i = 0; i < doc_count; i++) {
    const domain = domains[i % domains.length];
    const cites = [i % code_count, (i * 7 + 1) % code_count, (i * 13 + 5) % code_count];
    const body = Array.from({ length: 30 }, (_, line) => `Paragraph ${line} of document ${i} describes subsystem ${i % 37} behaviour number ${line * i}.`).join('\n\n');
    put(`.documentation/${domain}/doc-${i}.md`, `---\ntitle: Doc ${i}\npurpose: Explains subsystem ${i % 37} for the benchmark tree\nsources: [${code_file(cites[0])}]\nlast_verified: 2026-01-01\n---\n# Doc ${i}\n\nSee \`${code_file(cites[1])}\`, \`benchUnit${cites[2]}()\` and [next](./doc-${(i + 1) % doc_count}.md).\n\nConfig \`BENCH_LIMIT_${cites[0]}\` and \`missing/path-${i}.ts\`.\n\n${body}\n`);
  }
  git('add', '-A'); git('commit', '-qm', 'initial');
  for (let n = 0; n < 15; n++) { put(code_file(n), `export function benchUnit${n}() { return ${n + 1000}; }\nexport const BENCH_LIMIT_${n} = ${n};\n`); git('add', '-A'); git('commit', '-qm', `c${n}`); }

  const run = (label) => {
    const start = Date.now();
    const result = spawnSync('node', [cli, 'index', '-p', docs], { cwd: dir, encoding: 'utf-8', env: { ...process.env, HEWTD_TIMING: '1' } });
    const seconds = ((Date.now() - start) / 1000).toFixed(1);
    const timing = (result.stderr + result.stdout).split('\n').filter((line) => line.startsWith('[timing]')).join('\n  ');
    console.log(`${label.padEnd(22)} ${seconds.padStart(6)} s${timing ? '\n  ' + timing : ''}`);
  };
  console.log(`tree: ${doc_count} docs, ${code_count} code files, cli ${cli}`);
  run('cold');
  run('warm (unchanged)');
  appendFileSync(join(docs, 'guides', 'doc-0.md'), '\nOne more line.\n');
  run('one doc edited');
  put(code_file(3), 'export function benchUnit3() { return 99999; }\nexport const BENCH_LIMIT_3 = 3;\n');
  run('one code file edited');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
