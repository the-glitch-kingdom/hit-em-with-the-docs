#!/usr/bin/env node
// Benchmark `hewtd index` (with graph export): cold, warm-unchanged, one doc edited, docs-only commit, one code file edited.
// Not part of CI. Usage: node scripts/bench-graph.mjs [path/to/dist/cli/index.js] [docs=900] [code=400] [--profile large]
// --profile large: ~920 docs, ~3000 code files (a few over 512 KB), ~2400 cited symbols, ~13000 refs, 150 commits (#74).
// Set HEWTD_TIMING=1 (done here) to print per-stage timings from build_graph.
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const profile_at = args.indexOf('--profile');
const large = profile_at >= 0 && args.splice(profile_at, 2)[1] === 'large';
const cli = resolve(args[0] ?? join(here, '..', 'dist', 'cli', 'index.js'));
const doc_count = Number(args[1] ?? (large ? 920 : 900));
const code_count = Number(args[2] ?? (large ? 3000 : 400));
const symbols_per_doc = large ? 2 : 0; // extra symbol and path refs per doc beyond the three base ones
const domains = ['guides', 'procedures', 'architecture', 'reference', 'operations', 'testing'];

const dir = mkdtempSync(join(tmpdir(), 'bench-graph-'));
const docs = join(dir, '.documentation');
const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'b', GIT_AUTHOR_EMAIL: 'b@b', GIT_COMMITTER_NAME: 'b', GIT_COMMITTER_EMAIL: 'b@b' } });
const put = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
const code_file = (i) => `src/mod${i % 20}/unit${i}.ts`;

try {
  git('init', '-q');
  for (let i = 0; i < code_count; i++) put(code_file(i), `export function benchUnit${i}() { return ${i}; }\nexport const BENCH_LIMIT_${i} = ${i};\n` + (large && i < 6 ? `// ${'filler line for a large file '.repeat(20)}\n`.repeat(1100) : ''));
  for (let i = 0; i < doc_count; i++) {
    const domain = domains[i % domains.length];
    const cites = [i % code_count, (i * 7 + 1) % code_count, (i * 13 + 5) % code_count];
    const extra = Array.from({ length: symbols_per_doc * 5 }, (_, k) => { const c = (i * 31 + k * 97 + 7) % code_count; return k % 2 ? `\`benchUnit${c}()\`` : `\`BENCH_LIMIT_${c}\``; }).join(', ');
    const body = Array.from({ length: 30 }, (_, line) => `Paragraph ${line} of document ${i} describes subsystem ${i % 37} behaviour number ${line * i}.`).join('\n\n');
    put(`.documentation/${domain}/doc-${i}.md`, `---\ntitle: Doc ${i}\npurpose: Explains subsystem ${i % 37} for the benchmark tree\nsources: [${code_file(cites[0])}]\nlast_verified: 2026-01-01\n---\n# Doc ${i}\n\nSee \`${code_file(cites[1])}\`, \`benchUnit${cites[2]}()\` and [next](./doc-${(i + 1) % doc_count}.md).\n\nConfig \`BENCH_LIMIT_${cites[0]}\` and \`missing/path-${i}.ts\`.\n\n${extra ? `Also ${extra}.\n\n` : ''}${body}\n`);
  }
  git('add', '-A'); git('commit', '-qm', 'initial');
  for (let n = large ? 6 : 0; n < (large ? 156 : 15); n++) { put(code_file(n % code_count), `export function benchUnit${n}() { return ${n + 1000}; }\nexport const BENCH_LIMIT_${n} = ${n};\n`); git('add', '-A'); git('commit', '-qm', `c${n}`); }

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
  git('add', '.documentation'); git('commit', '-qm', 'docs only');
  run('docs-only commit');
  put(code_file(3), 'export function benchUnit3() { return 99999; }\nexport const BENCH_LIMIT_3 = 3;\n');
  run('one code file edited');
} finally {
  if (process.env.BENCH_KEEP) console.log(`kept ${dir}`); else rmSync(dir, { recursive: true, force: true });
}
