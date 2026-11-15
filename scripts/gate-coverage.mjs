#!/usr/bin/env node
/**
 * gate:coverage (#117): release gate for `hewtd coverage`, a sibling of gate:gaps. Copies tests/fixtures/coverage-117
 * to a temp git repo, runs the BUILT CLI, and scores every case in expected.json: the surface's grade (absent, named,
 * explained), the engine outcome and target doc, a draft that states only facts true at their file:line (or waits for
 * the judge on the surface's own line), the ignore list (held), generated files (ignored), declared lists (generate the
 * reference), and no value that must never be written. Exit 1 on any wrong grade or outcome, a leaked value, or an
 * unstated fact. Usage: node scripts/gate-coverage.mjs [--expected <file>]   (run `npm run build` first)
 */
import { execFileSync, spawnSync } from 'child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root_dir = resolve(here, '..');
const fixture = join(root_dir, 'tests/fixtures/coverage-117');
const cli = join(root_dir, 'dist/cli/index.js');
const expected_arg = process.argv.indexOf('--expected');
const expected_file = expected_arg > 0 ? resolve(process.argv[expected_arg + 1]) : join(fixture, 'expected.json');
if (!existsSync(cli)) { console.error('gate:coverage: run `npm run build` first'); process.exit(2); }
const { load_review } = await import(pathToFileURL(join(root_dir, 'dist/core/reconcile/review.js')).href);
const expected = JSON.parse(readFileSync(expected_file, 'utf-8'));

// the one credential-shaped line is built here, so no secret-shaped literal is committed
const secret_value = 'AK' + 'IA' + 'Q7ZR3LMP9XVB2NCK';
const port_value = '5432';
const temp = mkdtempSync(join(tmpdir(), 'gate-coverage-'));
const repo = join(temp, 'repo');
try {
  cpSync(join(fixture, 'repo'), repo, { recursive: true });
  writeFileSync(join(repo, 'src/secret.ts'), `export const DEPLOY_KEY_NAME = "${secret_value}";\n`);
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude/hit-em-with-the-docs.json'), JSON.stringify({ coverage: { ignore: [{ name: 'LEGACY_LIMIT', reason: 'slated for removal' }] } }));
  writeFileSync(join(repo, '.gitignore'), '.hewtd/\n');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=gate', '-c', 'user.email=gate@example.com', ...args], { cwd: repo, encoding: 'utf-8' });
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'fixture');
  const docs_before = readdirSync(join(repo, '.documentation'), { recursive: true }).filter((file) => /\.md$/.test(file)).map((file) => [file, readFileSync(join(repo, '.documentation', file), 'utf-8')]);
  const run = (extra) => {
    const result = spawnSync('node', [cli, 'coverage', ...extra], { cwd: repo, encoding: 'utf-8', env: { ...process.env, HOME: temp } });
    return { result, stdout: result.stdout };
  };
  const parse = (run_result) => {
    try { return JSON.parse(run_result.stdout); } catch { throw new Error(`the CLI did not print JSON (exit ${run_result.result.status}): ${(run_result.result.stderr || run_result.stdout).slice(0, 300)}`); }
  };
  const table = run([]);
  const wrote_nothing = !existsSync(join(repo, '.hewtd'));
  const main = run(['--json', '--write-review']);
  const out = parse(main);
  const review = await load_review(join(repo, out.coverage_review));
  const entries = review.entries.map(({ entry }) => entry);
  const entry_text = (entry) => [entry.draft ?? '', ...(entry.patch ?? []).map((patch) => patch.new)].join('\n');
  const repo_lines = (file) => (existsSync(join(repo, file)) ? readFileSync(join(repo, file), 'utf-8').split('\n') : []);
  const STATED = /^- `([^`]+)` is `([^`]+)` \(`([^`]+)`, line (\d+)\)\.$/;
  const stated_facts = entries.filter((entry) => entry.verdict !== null).flatMap((entry) => entry_text(entry).split('\n')).map((line) => STATED.exec(line)).filter(Boolean);
  const key_of = (kind, name, file) => `${kind}:${name}@${file}`;
  const entries_of = (keys) => entries.filter((entry) => (entry.reasons ?? []).some((reason) => keys.some((key) => reason.startsWith('coverage miss:') && reason.slice('coverage miss:'.length).split(', ').map((item) => item.trim()).includes(key))));

  const rows = [];
  for (const spec of expected.cases) {
    const problems = [];
    const surface = out.surfaces.find((found) => found.kind === spec.kind && found.name === spec.name && found.file === spec.file);
    if (spec.grade === 'undetected') {
      // a string literal is not a limit: it is not listed at all, so there is nothing to state or leak
      if (surface || out.held.entries.some((entry) => entry.name === spec.name)) problems.push('listed as a surface');
      rows.push({ id: spec.id, problems });
      continue;
    }
    if (!surface) problems.push('surface not detected');
    else {
      if (surface.grade !== spec.grade) problems.push(`grade ${surface.grade}, expected ${spec.grade}`);
      if (spec.line && surface.line !== spec.line) problems.push(`line ${surface.line}, expected ${spec.line}`);
    }
    const key = key_of(spec.kind, spec.name, spec.file);
    const proposal = out.coverage.proposals.find((found) => found.closes.some((closed) => closed.key === key));
    if (spec.outcome === 'none') { if (proposal) problems.push(`engine outcome ${proposal.kind}, expected none`); }
    else if (!proposal) problems.push(`no proposal, expected ${spec.outcome}`);
    else {
      if (proposal.kind !== spec.outcome) problems.push(`outcome ${proposal.kind}, expected ${spec.outcome}`);
      if ('doc' in spec && proposal.doc !== spec.doc) problems.push(`target ${proposal.doc ?? 'none'}, expected ${spec.doc}`);
      if (!proposal.source_files.includes(spec.file) && spec.outcome !== 'covered') problems.push(`sources ${proposal.source_files.join(',')} lack ${spec.file}`);
    }
    const mine = entries_of(proposal ? proposal.closes.map((closed) => closed.key) : [key]);
    if (spec.draft === 'none' && mine.length) problems.push('a draft was written, expected none');
    if (spec.draft === 'judge') {
      // a workflow name is also its schedule's and its jobs', so the lines are per file, not per surface
      const listed = mine.flatMap((entry) => (entry.for_judge ?? []).flatMap((item) => item.at ?? []));
      if (!listed.some((at) => at.startsWith(`${spec.file}:`))) problems.push(`the judge is not pointed at a line of ${spec.file}`);
    }
    if (spec.draft === 'stated') {
      if (!mine.length) problems.push('no draft');
      if (!Array.isArray(spec.stated) || !spec.stated.length) problems.push('malformed spec: draft "stated" needs a non-empty stated list');
      for (const fact of spec.stated ?? []) {
        const found = stated_facts.find((match) => match[1] === fact.name && match[2] === fact.value && match[3] === spec.file && Number(match[4]) === spec.line);
        if (!found) problems.push(`fact ${fact.name} = ${fact.value} is not stated at ${spec.file}:${spec.line}`);
      }
    }
    if (spec.no_value && stated_facts.some((match) => match[1] === spec.name)) problems.push('a value was stated for a name that must be listed without one');
    rows.push({ id: spec.id, problems });
  }

  const group = (id, problems) => rows.push({ id, problems });
  const held_names = out.held.entries.map((entry) => entry.name).sort().join(',');
  group('ignore list: held, never missed', [
    ...(held_names !== expected.held.map((entry) => entry.name).sort().join(',') ? [`held ${held_names}`] : []),
    ...(out.held.entries.some((entry) => !entry.reason) ? ['a held surface lost its reason'] : []),
    ...expected.held.filter((entry) => out.surfaces.some((found) => found.name === entry.name)).map((entry) => `${entry.name} is still graded`),
    ...expected.held.filter((entry) => JSON.stringify(out.coverage).includes(entry.name)).map((entry) => `${entry.name} reached the triage`),
  ]);
  const ignored_files = Array.isArray(expected.ignored_files) ? expected.ignored_files : [];
  group('generated files are ignored', [
    ...(!ignored_files.length ? ['malformed spec: ignored_files must be a non-empty list'] : []),
    ...ignored_files.filter((file) => out.surfaces.some((found) => found.file === file) || out.held.entries.some((entry) => entry.file === file)).map((file) => `${file} was graded`),
  ]);
  group('declared list: generate the reference, no per-entry draft', [
    ...(JSON.stringify(out.generate_reference.map(({ kind, file, count, absent }) => ({ kind, file, count, absent }))) !== JSON.stringify(expected.generate_reference) ? [`generate_reference ${JSON.stringify(out.generate_reference)}`] : []),
    ...expected.reference_entries.filter(([kind, name]) => !out.surfaces.some((found) => found.kind === kind && found.name === name && found.grade === 'absent')).map(([, name]) => `${name} is not graded absent`),
    ...expected.reference_entries.filter(([kind, name]) => out.coverage.proposals.some((proposal) => proposal.closes.some((closed) => closed.key.startsWith(`${kind}:${name}@`)))).map(([, name]) => `${name} was drafted one by one`),
  ]);
  group('every stated fact is true at its file:line', stated_facts.filter((match) => { const line = repo_lines(match[3])[Number(match[4]) - 1] ?? ''; return !line.includes(match[1]) || !line.replace(/[\s_,]/g, '').includes(match[2].replace(/[\s_,]/g, '')); }).map((match) => `${match[1]} is not at ${match[3]}:${match[4]}`));
  group('read-only without --write-review, nothing overwritten', [
    ...(table.result.status !== 0 ? [`exit ${table.result.status}`] : []),
    ...(!/By kind/.test(table.stdout) || !/By code area/.test(table.stdout) ? ['the surface table is missing'] : []),
    ...(!wrote_nothing ? ['it wrote .hewtd/ without --write-review'] : []),
    ...docs_before.filter(([file, text]) => readFileSync(join(repo, '.documentation', file), 'utf-8') !== text).map(([file]) => `${file} was changed`),
    ...(out.coverage.proposals.some((proposal) => proposal.kind === 'new' && proposal.doc && existsSync(join(repo, '.documentation', proposal.doc))) ? ['a new doc would overwrite an existing one'] : []),
  ]);
  // no value that must never be written, anywhere the gate writes
  const outputs = [table.stdout, main.stdout, ...readdirSync(join(repo, '.hewtd'), { recursive: true }).filter((file) => /\.(md|json|jsonl)$/.test(file)).map((file) => { try { return readFileSync(join(repo, '.hewtd', file), 'utf-8'); } catch { return ''; } })];
  group('no secret or value-named value in any output', [secret_value, port_value].filter((value) => outputs.some((text) => text.includes(value))).map((value) => `a value was written (${value.slice(0, 2)}...)`));

  const width = Math.max(...rows.map((row) => row.id.length));
  for (const row of rows) console.log(`${row.problems.length ? 'FAIL' : 'ok  '}  ${row.id.padEnd(width)}${row.problems.length ? '  ' + row.problems.join('; ') : ''}`);
  const passed = rows.filter((row) => !row.problems.length).length;
  console.log(`\ngate:coverage ${passed}/${rows.length} (${expected.cases.length} surface cases + ${rows.length - expected.cases.length} checks)`);
  process.exitCode = passed === rows.length ? 0 : 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
