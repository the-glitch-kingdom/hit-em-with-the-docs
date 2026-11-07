import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

describe('#50 template guidance', () => {
  it('fact template carries purpose and string symptoms', () => {
    const t = read('templates/knowledge-base/fact.template.md');
    expect(t).toMatch(/^purpose:/m);
    expect(t).toMatch(/^symptoms:/m);
  });

  it('extract-facts command asks for purpose and symptoms', () => {
    const t = read('commands/extract-facts.md');
    expect(t).toContain('"purpose"');
    expect(t).toContain('"symptoms"');
  });
});
