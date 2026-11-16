import { describe, it, expect } from 'vitest';
import ts from "typescript";
import { find_block_lines } from '../../../src/core/security/gate.js';

/**
 * Differential test (#120, I2): seeded random TS/JS programs, with the TypeScript parser as the oracle for which lines are
 * wholly inside a real block comment. The lexer may mark fewer lines than the oracle (fail closed) but never one more.
 */
const make_random = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
};

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = { ts: ts.ScriptKind.TS, tsx: ts.ScriptKind.TSX, js: ts.ScriptKind.JS, jsx: ts.ScriptKind.JSX, mjs: ts.ScriptKind.JS, cjs: ts.ScriptKind.JS };
const EXTENSIONS = ['ts', 'ts', 'js', 'js', 'mjs', 'cjs', 'tsx', 'jsx'];
const REGEXES = ['/[/*]/', '/\\/*/', '/a*\\//', '/[*/]/', '/"/', "/'/", '/\\//', '/[`]/', '/x+/g', '/[/*]x*/i'];
const NAMES = ['requireAdmin,', 'authMiddleware,', 'verifyToken,', 'isAdmin,'];

const generate_program = (random: () => number, extension: string): string => {
  const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)]!;
  const re = (): string => pick(REGEXES);
  let counter = 0;
  const name = (): string => `v${counter++}`;
  const list = (): string => `const ${name()} = [\n  ${pick(NAMES)}\n  ${pick(NAMES)}\n];`;
  const jsx_ok = extension !== 'ts';
  const segments: (() => string)[] = [
    () => `if (${name()}) ${re()}.test(s);`,
    () => `while (${name()}) ${re()}.test(s);`,
    () => `for (;;) ${re()}.test(s);`,
    () => `for (const k of ks) ${re()}.test(k);`,
    () => `function ${name()}(s) {\n  return ${re()}.test(s);\n}`,
    () => `function ${name()}(s) {\n  throw ${re()};\n}`,
    () => `const ${name()} = typeof ${re()};`,
    () => `void ${re()};`,
    () => `delete ${re()}.x;`,
    () => `const ${name()} = 'a' in ${re()};`,
    () => `const ${name()} = a instanceof ${re()};`,
    () => `switch (a) {\n  case ${re()}.x:\n    go();\n}`,
    () => `if (a) go(); else ${re()}.test(s);`,
    () => `do ${re()}.test(s); while (a);`,
    () => `function* ${name()}() {\n  yield ${re()};\n}`,
    () => `async function ${name()}() {\n  await ${re()}.test(s);\n}`,
    () => `const ${name()} = a || ${re()}.test(s);`,
    () => `const ${name()} = a ? ${re()} : b;`,
    () => `const ${name()} = [${re()}, ${re()}];`,
    () => `const ${name()} = { r: ${re()} };`,
    () => `const ${name()} = !${re()}.test(s);`,
    () => `foo(${re()}, 1);`,
    () => `{\n}\n${re()}.test(s);`,
    () => `const ${name()} = a / b / c;`,
    () => `const ${name()} = (a + b) / 2 / 3;`,
    () => `const ${name()} = g(x) / 2;`,
    () => `const ${name()} = arr[0] / arr[1];`,
    () => `const ${name()} = a++ / 2;`,
    () => `const ${name()} = a /* c */ / 2;`,
    () => `const ${name()} = a / 2; // end */`,
    () => `const ${name()} = (a) / 2 /* real */;`,
    () => `const ${name()} = "/*";`,
    () => `const ${name()} = '*/';`,
    () => 'const ' + name() + ' = `/* ${ "}" } */`;',
    () => 'const ' + name() + ' = `a /* ${ `b ${c} */` } d`;',
    () => 'const ' + name() + ' = `${a / b}${ /[/*]/.test(c) }`;',
    () => `/*\n  ${pick(NAMES)}\n  ${pick(NAMES)}\n*/`,
    () => `/**\n * ${pick(NAMES)}\n * it's "quoted" // here\n */`,
    () => `const ${name()} = 1; /* inline ${pick(NAMES)} */`,
    () => `${list()}`,
    () => `${list()}`,
    () => `app.use(\n  ${pick(NAMES)}\n  handler,\n);`,
    () => `// see /* here`,
    () => `const ${name()} = a < b;`,
    () => `if (a <b) go();`,
    () => `// ${pick(NAMES)}`,
  ];
  const jsx_segments: (() => string)[] = [
    () => `const ${name()} = <code>src/*</code>;`,
    () => `const ${name()} = <><b>*/</b> {a / 2}</>;`,
    () => `const ${name()} = <a href="x/*">t</a>;`,
    () => `const ${name()} = cond ? <i>/*</i> : null;`,
    () => `const ${name()} = <p>\n  /* ${pick(NAMES)}\n</p>;`,
  ];
  const all = jsx_ok ? [...segments, ...jsx_segments, ...jsx_segments] : segments;
  const rows: string[] = [];
  const shebang = random();
  if (extension !== 'tsx' && extension !== 'jsx' && shebang < 0.12) rows.push(`#!/usr/bin/env node${random() < 0.7 ? ' /*' : ''}`);
  const count = 3 + Math.floor(random() * 6);
  for (let i = 0; i < count; i++) rows.push(pick(all)());
  if (random() < 0.5) rows.push(pick(segments)());
  return rows.join('\n') + '\n';
};

/** The 0-based lines whose every non-blank character sits inside a real block comment, or undefined when the program does not parse. */
const find_oracle_lines = (text: string, extension: string): { inside: boolean[] } | undefined => {
  const source = ts.createSourceFile(`a.${extension}`, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[extension]);
  if ((source as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length) return undefined;
  const inside = new Array<boolean>(text.length).fill(false);
  const seen = new Set<number>();
  const visit = (node: ts.Node): void => {
    // JSX text and the insides of a doc comment are never trivia; the comment itself is found from the token that follows it
    if (node.kind === ts.SyntaxKind.JsxText || (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)) return;
    for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
      if (range.kind !== ts.SyntaxKind.MultiLineCommentTrivia || seen.has(range.pos)) continue;
      seen.add(range.pos);
      inside.fill(true, range.pos, range.end);
    }
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return { inside };
};

describe('prose lexer vs the TypeScript parser (#120)', () => {
  it('never marks a line that is not wholly inside a real block comment', () => {
    const random = make_random(120);
    let compared = 0;
    let marked_total = 0;
    const violations: string[] = [];
    for (let n = 0; n < 2400; n++) {
      const extension = EXTENSIONS[Math.floor(random() * EXTENSIONS.length)]!;
      const text = generate_program(random, extension);
      const oracle = find_oracle_lines(text, extension);
      if (!oracle) continue;
      compared++;
      const rows = text.split('\n');
      let offset = 0;
      const starts = rows.map((row) => { const at = offset; offset += row.length + 1; return at; });
      for (const line of find_block_lines(text, `a.${extension}`)) {
        marked_total++;
        const row = rows[line]!;
        for (let i = 0; i < row.length; i++) {
          if (!/\s/.test(row[i]!) && !oracle.inside[starts[line]! + i]) { violations.push(`${extension} line ${line + 1} of:\n${text}`); break; }
        }
      }
    }
    expect(violations.slice(0, 3)).toEqual([]);
    expect(compared).toBeGreaterThanOrEqual(2000);
    expect(marked_total).toBeGreaterThan(100); // the lexer still finds real comments
  });
});
