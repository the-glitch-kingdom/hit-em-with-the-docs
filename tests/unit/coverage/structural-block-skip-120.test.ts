import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { find_check_line } from '../../../src/core/coverage/draft.js';
import { has_code_syntax } from '../../../src/core/security/gate.js';

// a line is prose only when it is inside a detected block AND has no code syntax, so a wrong block can only cause a needless hold (#120)
const check = 'if user.role != "admin": deny()';
const shapes: [string, string, string][] = [
  ['python return """', 'a.py', `def f(user):\n    return """\n    sample\n"""\n${check}\nx = """\n"""\n`],
  ['python dict value """', 'a.py', `d = {"q": """\n${check}\n"""}\n`],
  ['python concatenation """', 'a.py', `msg = "a" + """\n${check}\n"""\n`],
  ['python call argument """', 'a.py', `msg = f(\n"""\n${check}\n""")\n`],
  ['ts template literal then glob', 'a.ts', `const t = \`\n/* sample\n\`;\n${check}\nconst g = "src/**/x.ts";\n`],
  ['go raw string then glob', 'a.go', `var s = \`\n/* sample\n\`\n${check}\nvar g = "a/**/b"\n`],
  ['php unclosed block then glob', 'a.php', `<?php\n/* never closed\n${check}\n$g = "src/**/x";\n`],
  ['ruby =begin inside a heredoc', 'a.rb', `x = <<~EOS\n=begin\nEOS\n${check}\n=end\n`],
  ['ruby =begin', 'a.rb', `=begin\n${check}\n=end\n`],
];

describe('a check inside a mis-detected block is still held (#120 structural)', () => {
  for (const [name, file, text] of shapes) {
    it(name, async () => {
      const repo = mkdtempSync(join(tmpdir(), 'blk120s-'));
      try {
        mkdirSync(join(repo, 'src'));
        writeFileSync(join(repo, 'src', file), text);
        const line = text.split('\n').indexOf(check) + 1;
        expect(await find_check_line(repo, [{ file: `src/${file}`, line }])).toMatchObject({ line });
      } finally { rmSync(repo, { recursive: true, force: true }); }
    });
  }
});

describe('code syntax (#120 structural)', () => {
  it('operators, assignment, calls, statement keywords, braces and semicolons are code', () => {
    for (const code of ['a != b', 'a === b', 'a <= b', 'a >= b', 'a && b', 'a || b', 'x = 1', 'x := 1', 'f(x)', 'if admin', 'unless ok', 'return role', 'raise Denied', 'throw e', 'assert a', 'require x', 'deny', 'a {', 'a;', 'ok and not locked', 'a or b)', 'a and b:', 'redirect_to root unless admin?']) expect(has_code_syntax(code), code).toBe(true);
  });
  it('a sentence is not', () => {
    for (const prose of ['the token expiry is why we compare the token against the expected value', 'token expires, and the token check happens upstream.', 'A session is reaped on its last-used time, because that is when the offline']) expect(has_code_syntax(prose), prose).toBe(false);
  });
});
