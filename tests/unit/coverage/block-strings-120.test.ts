import { describe, it, expect } from 'vitest';
import { find_block_lines, find_security_check } from '../../../src/core/security/gate.js';
import { find_check_line } from '../../../src/core/coverage/draft.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const prose = 'the token expiry is why we compare the token against the expected value';
const real = 'if not verify_password(user, supplied):';
const cases: Record<string, string> = {
  'python docstring': `"""\n${prose}\n"""\n${real}\n`,
  'single-quoted triple': `'''\n${prose}\n'''\n${real}\n`,
  'one-line docstring': `"""${prose}"""\n${real}\n`,
  'jsdoc': `/**\n * ${prose}\n */\n${real}\n`,
  'c block': `/*\n${prose}\n*/\n${real}\n`,
  'ruby begin': `=begin\n${prose}\n=end\n${real}\n`,
};
const files: Record<string, string> = { 'python docstring': 'a.py', 'single-quoted triple': 'a.py', 'one-line docstring': 'a.py', jsdoc: 'a.ts', 'c block': 'a.ts', 'ruby begin': 'a.rb' };
describe('block strings and comments are prose (#120 section 3)', () => {
  for (const [name, text] of Object.entries(cases)) {
    it(name, () => {
      const lines = text.split('\n');
      // a file name is required: an unknown extension marks nothing
      const blocks = find_block_lines(text, files[name]);
      const prose_at = lines.findIndex((line) => line.includes('expiry'));
      if (!['one-line docstring', 'jsdoc'].includes(name)) expect(find_security_check(lines[prose_at]!)).toBeDefined(); // flagged alone, so the block is what saves it
      expect(blocks.has(prose_at)).toBe(!files[name]!.endsWith('.rb')); // Ruby is not parser-checked: every line is held
      expect(blocks.has(lines.indexOf(real))).toBe(false);
    });
  }
  it('an unterminated opener and a glob in a string open nothing', () => {
    expect(find_block_lines('x = "src/**/*.ts"\nfoo()\n').size).toBe(0);
    expect(find_block_lines('/* never closed\nfoo()\n').size).toBe(0);
  });
  it('find_check_line skips docstring prose and still finds the real check', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'blk120-'));
    try {
      mkdirSync(join(repo, 'src'));
      writeFileSync(join(repo, 'src/t.py'), cases['python docstring']!);
      expect(await find_check_line(repo, [{ file: 'src/t.py', line: 2 }])).toBeUndefined();
      expect(await find_check_line(repo, [{ file: 'src/t.py', line: 4 }])).toMatchObject({ line: 4 });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
