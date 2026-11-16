import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { find_block_lines, find_security_check, has_code_syntax } from '../../../src/core/security/gate.js';
import { find_check_line } from '../../../src/core/coverage/draft.js';

/**
 * Generated matrix (#120): block-confusing constructs x check styles x placement. The oracle is by construction: a check
 * is held unless the generator put it inside a real block comment or a real Python docstring. Every `@@` line marks
 * where the check goes; `real` says that place is genuinely prose.
 */
interface Construct { name: string; ext: string; text: string; real?: boolean }
const Q = '"'.repeat(3);
const S = "'".repeat(3);
const B = '`';
const lines_of = (...rows: string[]): string => rows.join('\n') + '\n';

const PYTHON_CHECKS = ['if token != expected_token: deny()', 'verify_password(user, supplied)', '@login_required', '@permission_required', '@jwt_required', 'verify=False', 'role in ("admin", "staff")', 'hmac.compare_digest(a, b)', 'if not request.user.is_authenticated:', 'requireAdmin,'];
const C_CHECKS = ['if (token !== expectedToken) deny();', 'verifyPassword(user, supplied);', '@UseGuards(AuthGuard)', 'InsecureSkipVerify: true,', 'InsecureSkipVerify: true', 'requireAdmin,', '[requireAdmin, other]', 'if (!permissions.includes("admin")) return;', 'crypto.timingSafeEqual(a, b);', 'if (!req.user) return res.sendStatus(401);', 'rejectUnauthorized: false'];
const RUBY_CHECKS = ['before_action :authenticate_user!', 'authorize! :manage, @post', 'skip_before_action :verify_authenticity_token', 'before_action :require_admin', 'if !current_user.admin?', 'verify_password(user, supplied)', 'if token != expected_token', 'requireAdmin,', '[requireAdmin, other]', 'Rack::Utils.secure_compare(token, expected_token)'];

const PYTHON: Construct[] = [
  { name: 'return then triple string', ext: 'py', text: lines_of('def f():', `    return ${Q}`, '@@', Q) },
  { name: 'dict value triple string', ext: 'py', text: lines_of(`d = {"q": ${Q}`, '@@', `${Q}}`) },
  { name: 'concatenated triple string', ext: 'py', text: lines_of(`msg = "a" + ${Q}`, '@@', `${Q} + "b"`) },
  { name: 'call argument after a comma', ext: 'py', text: lines_of(`f(1, ${Q}`, '@@', `${Q})`) },
  { name: 'yield triple string', ext: 'py', text: lines_of('def g():', `    yield ${Q}`, '@@', `    ${Q}`) },
  { name: 'lambda body', ext: 'py', text: lines_of(`h = lambda: ${Q}`, '@@', Q) },
  { name: 'assert message', ext: 'py', text: lines_of(`assert ok, ${Q}`, '@@', Q) },
  { name: 'f-string triple', ext: 'py', text: lines_of(`s = f${Q}`, '@@', Q) },
  { name: 'rb prefix triple', ext: 'py', text: lines_of(`s = rb${Q}`, '@@', Q) },
  { name: 'fr prefix single-quote triple', ext: 'py', text: lines_of(`s = fr${S}`, '@@', S) },
  { name: 'single-quote triple', ext: 'py', text: lines_of(`s = ${S}`, '@@', S) },
  { name: 'quotes inside a triple string', ext: 'py', text: lines_of(`s = ${Q}`, `he said "hi" and 'bye'`, '@@', Q) },
  { name: 'escaped quote inside a triple string', ext: 'py', text: lines_of(`s = ${Q}`, `a \\${Q} b`, '@@', Q) },
  { name: 'hash inside a triple string', ext: 'py', text: lines_of(`s = ${Q}`, '# not a comment', '@@', Q) },
  { name: 'comment holding triple quotes', ext: 'py', text: lines_of(`# ${Q} is not a string`, '@@', 'x = 1') },
  { name: 'strings holding C comment delimiters', ext: 'py', text: lines_of('s = "/*"', '@@', 't = "*/"') },
  { name: 'regex string holding quotes', ext: 'py', text: lines_of('r = re.compile(r"[\\"\']+")', '@@', 'x = 1') },
  { name: 'unterminated triple string', ext: 'py', text: lines_of(`s = ${Q}`, '@@') },
  { name: 'unterminated single-quote string', ext: 'py', text: lines_of("s = 'abc", '@@') },
  { name: 'f-string with nested quotes', ext: 'py', text: lines_of('s = f"{d["k"]} {x}"', '@@', 'x = 1') },
  { name: 'backslash continuation before a triple string', ext: 'py', text: lines_of('x = \\', Q, '@@', Q) },
  { name: 'second string statement after a docstring', ext: 'py', text: lines_of('def f():', `    ${Q}Doc.${Q}`, `    ${Q}`, '@@', `    ${Q}`) },
  { name: 'string statement after an assignment', ext: 'py', text: lines_of('x = 1', Q, '@@', Q) },
  { name: 'string statement inside an if', ext: 'py', text: lines_of('if x:', `    ${Q}`, '@@', `    ${Q}`) },
  { name: 'docstring-shaped string with code after it', ext: 'py', text: lines_of(Q, '@@', `${Q} + y`) },
  { name: 'default argument triple string', ext: 'py', text: lines_of(`def f(x=${Q}`, '@@', `${Q}): pass`) },
  { name: 'real module docstring', ext: 'py', real: true, text: lines_of(`${Q}Module.`, '@@', Q, 'import os') },
  { name: 'real docstring after a def', ext: 'py', real: true, text: lines_of('def f():', `    ${Q}Doc.`, '@@', `    ${Q}`, '    return 1') },
  { name: 'real docstring after a multi-line def header', ext: 'py', real: true, text: lines_of('def f(', '    a,', '    b,', '):', `    ${Q}Doc.`, '@@', `    ${Q}`) },
  { name: 'real class docstring', ext: 'py', real: true, text: lines_of('class A:', `    ${Q}Doc.`, '@@', `    ${Q}`) },
  { name: 'real docstring after comments', ext: 'py', real: true, text: lines_of('# note', '', `${Q}Doc`, '@@', Q) },
];

const RUBY: Construct[] = [
  { name: 'squiggly heredoc holding =begin', ext: 'rb', text: lines_of('x = <<~EOS', '=begin', '@@', '=end', 'EOS') },
  { name: 'dash heredoc holding =begin', ext: 'rb', text: lines_of('x = <<-EOS', '=begin', '@@', '=end', '  EOS') },
  { name: 'bare heredoc holding =begin', ext: 'rb', text: lines_of('x = <<EOS', '=begin', '@@', '=end', 'EOS') },
  { name: 'single-quoted heredoc', ext: 'rb', text: lines_of("x = <<~'EOS'", '=begin', '@@', 'EOS') },
  { name: 'double-quoted heredoc', ext: 'rb', text: lines_of('x = <<~"EOS"', '=begin', '@@', 'EOS') },
  { name: 'heredoc as a call argument', ext: 'rb', text: lines_of('puts(<<~A.strip, 1)', '=begin', '@@', 'A') },
  { name: 'two heredocs on one line', ext: 'rb', text: lines_of('f(<<~A, <<~B)', '=begin', 'A', '@@', 'B') },
  { name: 'heredoc line that only starts with the terminator', ext: 'rb', text: lines_of('x = <<~EOS', 'EOS more', '=begin', '@@', 'EOS') },
  { name: 'unterminated heredoc', ext: 'rb', text: lines_of('x = <<~EOS', '=begin', '@@', '=end') },
  { name: '%q string holding =begin', ext: 'rb', text: lines_of('x = %q(', '=begin', '@@', '=end', ')') },
  { name: '%Q string with nested brackets', ext: 'rb', text: lines_of('x = %Q[a [b] c', '=begin', '@@', ']') },
  { name: '%w list holding =begin', ext: 'rb', text: lines_of('x = %w[a', '=begin', '@@', ']') },
  { name: 'bare % literal', ext: 'rb', text: lines_of('x = %(', '=begin', '@@', ')') },
  { name: 'double-quoted multi-line string', ext: 'rb', text: lines_of('x = "', '=begin', '@@', '=end', '"') },
  { name: 'single-quoted multi-line string', ext: 'rb', text: lines_of("x = '", '=begin', '@@', "'") },
  { name: 'interpolation with nested quotes', ext: 'rb', text: lines_of('x = "a #{h["k"]} b', '=begin', '@@', '"') },
  { name: 'backtick string', ext: 'rb', text: lines_of('x = `echo', '=begin', '@@', '`') },
  { name: 'comment holding quotes', ext: 'rb', text: lines_of('# it\'s "quoted', '@@', 'y = 2') },
  { name: 'regex holding a quote', ext: 'rb', text: lines_of("r = /don't/", '@@', 'x = 1') },
  { name: 'char literals that are quotes', ext: 'rb', text: lines_of("c = ?'", '@@', 'd = ?"') },
  { name: 'quote globals', ext: 'rb', text: lines_of("puts $'", '@@', 'puts $"') },
  { name: 'quoted symbols', ext: 'rb', text: lines_of('s = :"a b"', '@@', "t = :'c'") },
  { name: 'escaped quotes', ext: 'rb', text: lines_of("x = 'it\\'s'", '@@', 'y = "a\\"b"') },
  { name: 'indented =begin is code', ext: 'rb', text: lines_of('  =begin', '@@', '  =end') },
  { name: 'unterminated =begin', ext: 'rb', text: lines_of('=begin', '@@') },
  { name: 'data after __END__', ext: 'rb', text: lines_of('x = 1', '__END__', '=begin', '@@', '=end') },
  { name: 'multi-line /x regex holding =begin (gives up)', ext: 'rb', text: lines_of('re = /', '  a b # x', '=begin', '@@', '=end', '/x') },
  { name: 'multi-line %r regex holding =begin', ext: 'rb', text: lines_of('re = %r{', '=begin', '@@', '=end', '}x') },
  { name: 'lowercase heredoc id holding =begin', ext: 'rb', text: lines_of('x = <<eos', '=begin', '@@', '=end', 'eos') },
  { name: 'lowercase squiggly heredoc holding =begin', ext: 'rb', text: lines_of('x = <<~eos', '=begin', '@@', '=end', 'eos') },
  { name: 'quoted heredoc id with a space (gives up)', ext: 'rb', text: lines_of('x = <<~"END OF"', '=begin', '@@', '=end', 'END OF') },
  { name: 'interpolated regex (gives up)', ext: 'rb', text: lines_of('re = /a#{b/c}d/', '=begin', '@@', '=end') },
  { name: 'real =begin block', ext: 'rb', real: true, text: lines_of('=begin', '@@', '=end', 'x = 1') },
  { name: 'real =begin after modulo', ext: 'rb', real: true, text: lines_of('y = x % 3', '=begin', '@@', '=end') },
];

const C_STYLE: Construct[] = [
  { name: 'js template literal holding /*', ext: 'ts', text: lines_of(`const t = ${B}`, '/* sample', '@@', `${B};`) },
  { name: 'js nested template literals', ext: 'js', text: lines_of(`const t = ${B}a \${${B}b \${c}${B}}`, '/*', '@@', `${B};`) },
  { name: 'js template with an object in ${}', ext: 'js', text: lines_of(`const t = ${B}\${ {a: 1}.a }`, '/*', '@@', `${B};`) },
  { name: 'js template with an escaped backtick', ext: 'ts', text: lines_of(`const t = ${B}a \\${B} /* b`, '@@', `${B};`) },
  { name: 'sql hint inside a template', ext: 'ts', text: lines_of(`const q = ${B}SELECT /*+ INDEX(t) */ 1`, '/*', '@@', `${B};`) },
  { name: 'gitignore body in a template', ext: 'ts', text: lines_of(`const ig = ${B}node_modules/*`, '!keep/*', '@@', `${B};`) },
  { name: 'strings holding /* and */', ext: 'js', text: lines_of('const g = "a/*";', '@@', 'const h = "*/";') },
  { name: 'regex class holding /*', ext: 'js', text: lines_of('const re = /[/*]/;', '@@', 'const r2 = /[*/]/;') },
  { name: 'regex holding quotes', ext: 'js', text: lines_of('const re = /["\']/g;', '@@', 'x();') },
  { name: 'single-quoted string holding /*', ext: 'ts', text: lines_of("const s = '/* x';", '@@', 'y();') },
  { name: 'escaped quote then /*', ext: 'js', text: lines_of('const s = "a \\" /* b";', '@@', 'x();') },
  { name: 'url string holding //', ext: 'js', text: lines_of('const u = "http://x/*y";', '@@', 'z();') },
  { name: 'line comment holding /*', ext: 'js', text: lines_of('// see /* here', '@@', 'foo();') },
  { name: 'line comment holding a quote', ext: 'js', text: lines_of("// don't", '@@', 'foo();') },
  { name: 'glob in a line comment', ext: 'ts', text: lines_of('// src/**/*.ts', '@@', 'foo();') },
  { name: 'unterminated block comment', ext: 'js', text: lines_of('/* never', '@@') },
  { name: 'go raw string holding /*', ext: 'go', text: lines_of(`var s = ${B}`, '/* hint', '@@', B) },
  { name: 'go rune quote', ext: 'go', text: lines_of("r := '\"'", '@@', 's := "x"') },
  { name: 'go string holding a backtick, then a real block', ext: 'go', real: true, text: lines_of(`s := "${B}"; /* real`, '@@', '*/') },
  { name: 'php heredoc holding /*', ext: 'php', text: lines_of('<?php', '$x = <<<EOT', '/* hint', '@@', 'EOT;') },
  { name: 'php nowdoc holding /*', ext: 'php', text: lines_of('<?php', "$x = <<<'EOT'", '/* hint', '@@', 'EOT;') },
  { name: 'php hash comment holding /*', ext: 'php', text: lines_of('<?php', '# /* x', '@@', 'foo();') },
  { name: 'php string holding /*', ext: 'php', text: lines_of('<?php', '$x = "a /* b";', '@@', 'foo();') },
  { name: 'java text block holding /*', ext: 'java', text: lines_of(`String s = ${Q}`, '/* hint', '@@', `${Q};`) },
  { name: 'kotlin raw string holding /*', ext: 'kt', text: lines_of(`val s = ${Q}`, '/* hint', '@@', Q) },
  { name: 'swift multi-line string holding /*', ext: 'swift', text: lines_of(`let s = ${Q}`, '/* hint', '@@', Q) },
  { name: 'rust raw string holding /*', ext: 'rs', text: lines_of('let s = r#"', '/* hint', '@@', '"#;') },
  { name: 'rust lifetimes and chars', ext: 'rs', text: lines_of("fn f<'a>(x: &'a str) -> &'a str { x }", "let c = '/'; let d = '*';", '@@', 'g();') },
  { name: 'c++ raw string holding /*', ext: 'cpp', text: lines_of('auto s = R"(', '/* x', '@@', ')";') },
  { name: 'c# verbatim string holding /*', ext: 'cs', text: lines_of('var s = @"', '/* x', '@@', '";') },
  { name: 'css strings holding comment delimiters', ext: 'css', text: lines_of('a { content: "/*"; }', '@@', 'b { content: "*/"; }') },
  { name: 'nested block comment in rust (one real block)', ext: 'rs', real: true, text: lines_of('/* a /* b */', '@@', '*/') },
  { name: 'the same text in java (the block closes early)', ext: 'java', text: lines_of('/* a /* b */', '@@', '*/') },
  { name: 'real jsdoc', ext: 'ts', real: true, text: lines_of('/**', ' * @@', ' */', 'foo();') },
  { name: 'real block holding quotes and delimiters', ext: 'js', real: true, text: lines_of('/* it\'s "x" // y', '@@', '*/') },
  { name: 'real block after a char literal', ext: 'c', real: true, text: lines_of('char c = \'"\'; /* x', '@@', '*/') },
  { name: 'real block after a division', ext: 'js', real: true, text: lines_of('const a = b / c; /* real', '@@', '*/') },
  // regex literals after a keyword or the paren of if/while/for: the `/*` inside the class is not a comment (review finding 1)
  ...['if (ok)', 'while (ok)', 'for (;;)', 'return', 'typeof', 'case 1: return', 'x instanceof', "'a' in", 'else', 'do', 'void', 'delete', 'throw', 'x =', 'foo(1,', 'x = !'].map((head): Construct => ({ name: `regex after ${head}`, ext: 'js', text: lines_of(`${head} /[/*]/.test(s);`, '@@', 'y = z; // end */') })),
  ...['for (const a of', 'yield', 'await', '}'].map((head): Construct => ({ name: `regex after ${head} (gives up or reads both)`, ext: 'js', text: lines_of(`${head}`, '/[/*]/.test(s);', '@@', 'y = z; // end */') })),
  { name: 'regex after a ++ (gives up)', ext: 'ts', text: lines_of('a++', '/[/*]/.test(s);', '@@', 'y = z; // end */') },
  { name: 'division after ) and ] and a name', ext: 'ts', text: lines_of('const q = (a + b) / 2 / c[0] / d; // x', '@@', 'const w = "*/";') },
  { name: 'jsx text holding /* in a jsx file (gives up)', ext: 'jsx', text: lines_of('const e = <code>src/*</code>;', '@@', 'const t = x; // */') },
  { name: 'jsx text holding /* in a tsx file (gives up)', ext: 'tsx', text: lines_of('const e = <code>src/*</code>;', '@@', 'const t = x; // */') },
  { name: 'jsx text holding /* in a js file (gives up)', ext: 'js', text: lines_of('const e = cond ? <code>src/*</code> : null;', '@@', 'const t = x; // */') },
  { name: 'comparison is not jsx', ext: 'js', real: true, text: lines_of('if (a <b) go(); /* real', '@@', '*/') },
  { name: 'hashbang ending in a block opener', ext: 'js', text: lines_of('#!/usr/bin/env node /*', '@@', 'y = z; // end */') },
  { name: 'hashbang in a c file (gives up)', ext: 'c', text: lines_of('#!/usr/bin/env tcc /*', '@@', 'y = z; // end */') },
  { name: 'include with a comment opener in the header name', ext: 'c', text: lines_of('#include <a/*b>', '@@', 'int x; // end */') },
  { name: 'spliced line comment', ext: 'c', text: lines_of('// note \\', '/* still the comment', '@@', 'int y; /* real */') },
  { name: 'spliced line comment with trailing space', ext: 'cpp', text: lines_of('// note \\ ', '/* still the comment', '@@', 'int y; /* real */') },
  { name: 'splice inside a comment opener (gives up)', ext: 'c', text: lines_of('int a; /\\', '* x', '@@', 'int y; // end */') },
];

const FILLER = 'filler line';
const place = (construct: Construct, check: string, where: 'before' | 'inside' | 'after'): string => {
  if (where === 'inside') return construct.text.replace('@@', check);
  const body = construct.text.replace('@@', FILLER);
  const head = body.startsWith('<?php\n') ? '<?php\n' : '';
  return where === 'before' ? `${head}${check}\n${body.slice(head.length)}` : `${body}${check}\n`;
};

let repo: string;
let count = 0;
beforeAll(() => { repo = mkdtempSync(join(tmpdir(), 'prose120-')); mkdirSync(join(repo, 'src')); });
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

const run_family = (title: string, constructs: Construct[], checks: string[]): void => {
  describe(`prose lines matrix: ${title} (#120)`, () => {
    it('has 25+ constructs and 8+ check styles, and every check style is a check on its own', () => {
      expect(constructs.length).toBeGreaterThanOrEqual(25);
      expect(checks.length).toBeGreaterThanOrEqual(8);
      for (const check of checks) expect(find_security_check(check), check).toBeDefined();
    });
    for (const construct of constructs) {
      for (const where of ['before', 'inside', 'after'] as const) {
        if (where === 'inside' && construct.real) continue;
        it(`${construct.name}: check ${where}`, async () => {
          for (const check of checks) {
            const text = place(construct, check, where);
            const file = `src/case${count++}.${construct.ext}`;
            writeFileSync(join(repo, file), text);
            const index = text.split('\n').indexOf(check);
            expect(find_block_lines(text, file).has(index), `${check} is not prose`).toBe(false);
            expect(await find_check_line(repo, [{ file, line: index + 1 }]), `${check} is held`).toMatchObject({ file, line: index + 1 });
          }
        });
      }
    }
  });
};
run_family('python', PYTHON, PYTHON_CHECKS);
run_family('ruby', RUBY, RUBY_CHECKS);
run_family('c-style', C_STYLE, C_CHECKS);

describe('real prose is still skipped (#120)', () => {
  it('a docstring prose line, a block comment line and an =begin line are prose', () => {
    const prose = 'the token expiry is why we compare the token against the expected value';
    expect([...find_block_lines(lines_of('def f():', `    ${Q}Doc.`, `    ${prose}`, `    ${Q}`, '    return 1'), 'a.py')]).toEqual([1, 2, 3]);
    expect([...find_block_lines(lines_of('/*', prose, '*/', 'foo();'), 'a.ts')]).toEqual([0, 1, 2]);
    expect([...find_block_lines(lines_of('=begin', prose, '=end', 'x = 1'), 'a.rb')]).toEqual([]); // Ruby is not parser-checked: every line is held
  });
  it('find_check_line skips the docstring prose line and still finds the real check after it', async () => {
    const prose = 'the token expiry is why we compare the token against the expected value';
    const text = lines_of('def check(token, expected):', `    ${Q}Doc.`, `    ${prose}`, `    ${Q}`, '    if token != expected:', '        deny()');
    writeFileSync(join(repo, 'src/doc.py'), text);
    expect(find_security_check(prose)).toBeDefined();
    expect(await find_check_line(repo, [{ file: 'src/doc.py', line: 3 }])).toBeUndefined();
    expect(await find_check_line(repo, [{ file: 'src/doc.py', line: 5 }])).toMatchObject({ line: 5 });
  });
  it('an unknown extension, an unterminated construct and a file with no name mark nothing', () => {
    expect(find_block_lines('/*\nx\n*/\n', 'a.txt').size).toBe(0);
    expect(find_block_lines('/*\nx\n*/\n').size).toBe(0);
    expect(find_block_lines('/*\nx\n*/\ns = "abc\n', 'a.ts').size).toBe(0);
    expect(find_block_lines('/*\nx\n*/\nt = `abc\n', 'a.ts').size).toBe(0);
  });
});

// the lexer must be back in the normal state after each construct: a real block after it is still found (no construct fails by giving up)
const PARSER_CHECKED = new Set(['py', 'pyi', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'go']);
const TAIL: Record<string, string> = { py: lines_of('def tail():', `    ${Q}`, '    tail prose', `    ${Q}`), rb: lines_of('=begin', 'tail prose', '=end'), c: lines_of('/*', 'tail prose', '*/') };
describe('the lexer recovers after every well-formed construct (#120)', () => {
  for (const construct of [...PYTHON, ...RUBY, ...C_STYLE]) {
    if (/unterminated|__END__|indented|gives up/.test(construct.name)) continue;
    it(construct.name, () => {
      const tail = TAIL[construct.ext === 'py' ? 'py' : construct.ext === 'rb' ? 'rb' : 'c']!;
      const text = construct.text.replace('@@', FILLER) + tail;
      const marked = find_block_lines(text, `a.${construct.ext}`);
      if (!PARSER_CHECKED.has(construct.ext)) return expect(marked.size).toBe(0); // only parser-checked languages read prose; the rest hold every line
      expect(marked.has(text.split('\n').findIndex((line) => line.trim() === 'tail prose'))).toBe(true);
    });
  }
});

describe('code syntax second guard (#120)', () => {
  it('a decorator, a symbol argument, a bang call and an object-literal entry are code', () => {
    for (const code of ['@login_required', '@permission_required', 'before_action :authenticate_user!', 'authorize! :manage, @post', 'skip_before_action :verify_authenticity_token', 'InsecureSkipVerify: true,', 'InsecureSkipVerify: true', 'retries: 3,']) expect(has_code_syntax(code), code).toBe(true);
  });
});
