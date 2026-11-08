import { describe, it, expect } from 'vitest';
import { set_frontmatter_keys, parse_frontmatter } from '../../../src/utils/frontmatter.js';
import { validate_partial_metadata } from '../../../src/core/metadata/schema.js';

const fm_lines = [
  'title: "Title"',
  'created: 2026-07-31',
  '# keep this comment',
  'tags: [a,   b]',
  'symptoms:',
  '- old one',
  'last_verified: 2026-01-01',
];
const body = '\nBody  text.\n\n\n';
const make = (eol: string, lines = fm_lines) => `---${eol}${lines.join(eol)}${eol}---${eol}${body.replace(/\n/g, eol)}`;

describe('setFrontmatterKeys (#69)', () => {
  it('rewrites only the changed key; every other line and the body stay byte-identical', () => {
    const raw = make('\n');
    const out = set_frontmatter_keys(raw, { symptoms: ['old one', 'new phrase here'] });
    const rest = (s: string) => s.split('\n').filter((l) => !/symptoms|old one|new phrase/.test(l));
    expect(rest(out)).toEqual(rest(raw));
    expect(out.endsWith(`---\n${body}`)).toBe(true);
    expect(parse_frontmatter(out).data.symptoms).toEqual(['old one', 'new phrase here']);
    expect(validate_partial_metadata(parse_frontmatter(out).data).valid).toBe(true);
  });

  it('changes only last_verified', () => {
    const raw = make('\n');
    const out = set_frontmatter_keys(raw, { last_verified: '2026-11-07' });
    expect(out.split('\n').filter((l, i) => l !== raw.split('\n')[i])).toEqual(["last_verified: '2026-11-07'"]);
  });

  it('appends a missing key at the end of the block', () => {
    const raw = make('\n', fm_lines.slice(0, 3));
    const out = set_frontmatter_keys(raw, { symptoms: ['x y z'] });
    expect(out).toBe(raw.replace('\n---\n', '\nsymptoms:\n  - x y z\n---\n'));
  });

  it('keeps CRLF', () => {
    const out = set_frontmatter_keys(make('\r\n'), { symptoms: ['a b c', 'd e f'] });
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out).toContain('title: "Title"\r\n');
  });

  it('falls back (still valid) when the frontmatter is not a YAML map', () => {
    const out = set_frontmatter_keys('---\n- a\n- b\n---\n\nBody\n', { title: 'T' });
    expect(parse_frontmatter(out).data.title).toBe('T');
    expect(out).toContain('Body');
  });
});
