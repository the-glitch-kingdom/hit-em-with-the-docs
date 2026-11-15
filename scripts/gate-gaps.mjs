#!/usr/bin/env node
/**
 * gate:gaps (#115): release gate for `reconcile --gaps` coverage triage. Copies tests/fixtures/gaps-triage-115 to a
 * temp git repo, runs the BUILT CLI, and scores every case in expected.json. Exit 1 on any wrong outcome or target,
 * a draft that does not state its fact (file:line), a source with no distinctive facet, or a leaked secret value.
 * Usage: node scripts/gate-gaps.mjs [--expected <file>]   (run `npm run build` first)
 */
import { execFileSync, spawnSync } from 'child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root_dir = resolve(here, '..');
const fixture = join(root_dir, 'tests/fixtures/gaps-triage-115');
const cli = join(root_dir, 'dist/cli/index.js');
const expected_arg = process.argv.indexOf('--expected');
const expected_file = expected_arg > 0 ? resolve(process.argv[expected_arg + 1]) : join(fixture, 'expected.json');
if (!existsSync(cli)) { console.error('gate:gaps: run `npm run build` first'); process.exit(2); }
const { compile_facet, is_weak_facet } = await import(pathToFileURL(join(root_dir, 'dist/core/coverage/facets.js')).href);
const { load_review } = await import(pathToFileURL(join(root_dir, 'dist/core/reconcile/review.js')).href);
const expected = JSON.parse(readFileSync(expected_file, 'utf-8'));

// the fixture's one credential line is built here, so no secret-shaped literal is committed
const secret_value = 'AK' + 'IA' + 'Q7ZR3LMP9XVB2NCK';
const temp = mkdtempSync(join(tmpdir(), 'gate-gaps-'));
const repo = join(temp, 'repo');
try {
  cpSync(join(fixture, 'repo'), repo, { recursive: true });
  mkdirSync(join(repo, 'src/deploy'), { recursive: true });
  writeFileSync(join(repo, 'src/deploy/client.ts'), `export const DEPLOY_TIMEOUT = 30;\nexport const deploy_region_name = "${secret_value}";\n`);
  writeFileSync(join(repo, '.gitignore'), '.hewtd/\ngaps.jsonl\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=gate', '-c', 'user.email=gate@example.com', ...args], { cwd: repo, encoding: 'utf-8' });
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'fixture');
  cpSync(join(fixture, 'gaps.jsonl'), join(repo, 'gaps.jsonl'));
  const gaps = readFileSync(join(repo, 'gaps.jsonl'), 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const facets_of = (key) => gaps.find((gap) => gap.id === key)?.facets ?? [];
  const run = (extra) => {
    const result = spawnSync('node', [cli, 'reconcile', '--gaps', 'gaps.jsonl', '--json', ...extra], { cwd: repo, encoding: 'utf-8', env: { ...process.env, HOME: temp } });
    let out;
    try { out = JSON.parse(result.stdout); } catch { throw new Error(`the CLI did not print JSON (exit ${result.status}): ${(result.stderr || result.stdout).slice(0, 300)}`); }
    return { out, stdout: result.stdout };
  };
  const main = run(['--include-blind', '--write-review']);
  const plain = run([]);
  const review = await load_review(join(repo, main.out.coverage_review));
  const entries = review.entries.map(({ entry }) => entry);
  const entry_text = (entry) => [entry.draft ?? '', ...(entry.patch ?? []).map((patch) => patch.new)].join('\n');
  const entries_of = (keys) => entries.filter((entry) => (entry.reasons ?? []).some((reason) => reason === `coverage miss: ${keys.join(', ')}`));
  const repo_lines = (file) => (existsSync(join(repo, file)) ? readFileSync(join(repo, file), 'utf-8').split('\n') : []);
  const holds = (file, facet) => { const regex = compile_facet(facet).regex; return !!regex && repo_lines(file).some((line) => regex.test(line)); };
  const STATED = /^- `([^`]+)` is `([^`]+)` \(`([^`]+)`, line (\d+)\)\.$/;

  const rows = [];
  const total = expected.cases.length;
  for (const spec of expected.cases) {
    const problems = [];
    const keys = spec.keys ?? [spec.id];
    const facets = keys.flatMap(facets_of);
    const proposal = main.out.coverage.proposals.find((found) => found.closes.some((closed) => closed.key === keys[0]));
    if (!proposal) problems.push('no proposal');
    else {
      if (proposal.kind !== spec.kind) problems.push(`outcome ${proposal.kind}, expected ${spec.kind}`);
      if ('doc' in spec && proposal.doc !== (spec.doc ?? undefined)) problems.push(`target ${proposal.doc ?? 'none'}, expected ${spec.doc ?? 'none'}`);
      if (spec.domain && proposal.domain !== spec.domain) problems.push(`domain ${proposal.domain ?? 'none'}, expected ${spec.domain}`);
      const closed = proposal.closes.map((entry) => entry.key).sort().join(',');
      if (closed !== [...keys].sort().join(',')) problems.push(`closes ${closed}, expected ${[...keys].sort().join(',')}`);
      if (spec.sources && proposal.source_files.join(',') !== spec.sources.join(',')) problems.push(`sources ${proposal.source_files.join(',')}, expected ${spec.sources.join(',')}`);
      for (const file of proposal.source_files) if (!facets.some((facet) => !is_weak_facet(facet) && holds(file, facet))) problems.push(`source ${file} holds no distinctive facet`);
      const reference = proposal.generated_reference.map((list) => list.kind).sort().join(',');
      if (reference !== (spec.reference ?? '')) problems.push(`generate-reference hint "${reference}", expected "${spec.reference ?? ''}"`);
    }
    const mine = entries_of(proposal ? proposal.closes.map((closed) => closed.key) : keys);
    if (spec.draft === 'none' && mine.length) problems.push('a draft was written, expected none');
    if (spec.draft === 'stated') {
      if (!mine.length) problems.push('no draft');
      for (const facet of spec.stated ?? []) {
        const regex = compile_facet(facet).regex;
        const found = mine.filter((entry) => entry.verdict !== null).flatMap((entry) => entry_text(entry).split('\n')).map((line) => STATED.exec(line)).filter(Boolean)
          .find((match) => (regex.test(match[0]) || regex.test(`${match[1]} = ${match[2]}`)) && regex.test(repo_lines(match[3])[Number(match[4]) - 1] ?? ''));
        if (!found) problems.push(`fact "${facet}" is not stated with file:line`);
      }
      for (const entry of mine) for (const file of entry.sources ?? []) if (!facets.some((facet) => !is_weak_facet(facet) && holds(file, facet))) problems.push(`draft source ${file} holds no distinctive facet`);
    }
    if (spec.draft === 'judge') {
      const listed = mine.flatMap((entry) => (entry.for_judge ?? []).map((item) => item.facet));
      for (const facet of spec.judge ?? []) if (!listed.includes(facet)) problems.push(`fact "${facet}" is not listed for the judge`);
      if (mine.some((entry) => entry.verdict !== null)) problems.push('a judge-pending case was written as a verdict');
    }
    if (spec.path && !mine.some((entry) => entry.path === spec.path)) problems.push(`new doc path ${mine.map((entry) => entry.path).join(',') || 'none'}, expected ${spec.path}`);
    if (spec.security_adjacent && !main.out.coverage.security_adjacent?.some((found) => found.keys.includes(keys[0]) && found.word === spec.security_adjacent)) problems.push(`not marked security-adjacent by "${spec.security_adjacent}"`);
    const human = main.out.coverage.needs_human.find((found) => found.keys.includes(keys[0]));
    if (spec.needs_human) { if (!human) problems.push('not listed for a human'); else if (!human.reason?.includes(spec.needs_human)) problems.push(`reason "${human.reason}" lacks "${spec.needs_human}"`); } else if (human) problems.push(`listed for a human: ${human.reason}`);
    if (spec.skipped && !main.out.coverage.skipped.some((found) => found.keys.includes(keys[0]) && found.reason.includes(spec.skipped))) problems.push(`not skipped with "${spec.skipped}"`);
    if (spec.blind) {
      if (!main.out.warnings?.some((text) => text.includes('classified and drafted (--include-blind was passed)'))) problems.push('--include-blind warning text wrong');
      if (!plain.out.warnings?.some((text) => text.includes('classified but not drafted without --include-blind'))) problems.push('blind warning text wrong without --include-blind');
      if (!plain.out.coverage.skipped.some((found) => found.keys.includes(keys[0]) && /blind/.test(found.reason))) problems.push('blind entry drafted without --include-blind');
    }
    rows.push({ id: spec.id, problems });
  }

  // no value from a credential line, anywhere the gate writes
  const outputs = [main.stdout, plain.stdout, ...[main.out.report, plain.out.report, main.out.coverage_review].filter(Boolean).map((file) => readFileSync(join(repo, file), 'utf-8')), ...readdirSync(join(repo, '.hewtd'), { recursive: true }).filter((file) => /\.(md|json|jsonl)$/.test(file)).map((file) => { try { return readFileSync(join(repo, '.hewtd', file), 'utf-8'); } catch { return ''; } })];
  const leaked = outputs.some((text) => text.includes(secret_value));
  rows.push({ id: 'no secret value in any output', problems: leaked ? ['a credential value was written'] : [] });

  const width = Math.max(...rows.map((row) => row.id.length));
  for (const row of rows) console.log(`${row.problems.length ? 'FAIL' : 'ok  '}  ${row.id.padEnd(width)}${row.problems.length ? '  ' + row.problems.join('; ') : ''}`);
  const passed = rows.filter((row) => !row.problems.length).length;
  console.log(`\ngate:gaps ${passed}/${rows.length} (${total} cases + secret scan)`);
  process.exitCode = passed === rows.length ? 0 : 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
