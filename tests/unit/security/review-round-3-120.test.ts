// Regression tests for the third #120 security review (3.8.0): interpolation holes, person words inside flag names, dot segments.
import { describe, it, expect } from 'vitest';
import { find_value_spans, find_block_lines } from '../../../src/core/security/gate.js';

const is_withheld = (line: string, facet: string): boolean => {
  const at = line.indexOf(facet);
  return find_value_spans(line).some(([from, to]) => at < to && at + facet.length > from);
};

describe('prose is read only in parser-checked languages; the rest hold every line as in 3.7.0', () => {
  const cases: [string, string][] = [
    ['src/a.kt', 'val s = "${a("/*")}"\nlistOf(\n  requireAdmin,\n)\n// */\n'],
    ['src/a.php', '<?php\n$s = "{$a["/*"]}";\n$m = [\n  requireAdmin,\n];\n// */\n'],
    ['src/a.cs', 'var s = $"{a["/*"]}";\n[Authorize]\n// */\n'],
    ['src/b.cs', 'var s = """"\n"""/*\n"""";\nrequireAdmin,\n// */\n'],
    ['src/a.swift', 'let s = #"a" /* "#\nrequireAdmin,\n// */\n'],
    ['src/a.scala', 'val s = s"${a("/*")}"\nrequireAdmin,\n// */\n'],
    ['src/A.java', '/* a real comment\n requireAdmin\n*/\n'],
    ['src/a.rs', '/* a real comment\n requireAdmin\n*/\n'],
    ['src/a.rb', '=begin\nrequireAdmin\n=end\n'],
  ];
  it.each(cases)('%s marks nothing', (file, text) => expect([...find_block_lines(text, file)]).toEqual([]));
  it('a classic-script HTML comment opener in JS makes the lexer give up', () => {
    expect([...find_block_lines('x = 1 <!-- /*\nrequireAdmin,\n// */\n', 'src/a.js')]).toEqual([]);
  });
  it('real block comments and docstrings are still prose in Python, TS, Go and C', () => {
    for (const file of ['src/a.ts', 'src/a.go', 'src/a.c']) expect(find_block_lines('/* note\n requireAdmin\n*/\nx();\n', file).has(1), file).toBe(true);
    expect(find_block_lines('def f():\n    """\n    token check happens upstream\n    """\n    return 1\n', 'src/a.py').has(2)).toBe(true);
  });
});

describe('a person word anywhere in a flag name makes its phrase a value', () => {
  for (const [line, facet] of [['run("npm audit --customer-acme-corp")', 'acme-corp'], ['run("npm audit --user-jdoe")', 'jdoe'], ['run("git push --owner-acme")', 'acme'], ['run("kubectl get pods --as-alice")', 'alice'], ['run("npm audit --email-x")', '--email-x']])
    it(`${line} withholds ${facet}`, () => expect(is_withheld(line, facet)).toBe(true));
  for (const [line, facet] of [['run("npm audit fix --package-lock-only")', 'npm audit fix --package-lock-only'], ['run("npm ci --omit=dev")', '--omit=dev'], ['run("git push --force-with-lease")', 'git push --force-with-lease']])
    it(`${line} keeps ${facet}`, () => expect(is_withheld(line, facet)).toBe(false));
});

describe('a path with a dot segment never passes the folder rule', () => {
  for (const path of ['docs/../data/jane-doe.csv', 'lib/../customers/acme-corp.csv', 'fixtures/../data/x.json', 'examples/../../users/x.json', 'fixtures//x.json', 'fixtures/./x.json'])
    it(`${path} is a value`, () => expect(is_withheld(`P = "${path}"`, path)).toBe(true));
  it('fixtures/x.json stays a name', () => expect(is_withheld('P = "fixtures/x.json"', 'fixtures/x.json')).toBe(false));
});
