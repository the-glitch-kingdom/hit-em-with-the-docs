/**
 * Frontmatter must round-trip: `parse(stringify(parse(src)))` deep-equals `parse(src)`.
 *
 * It did not. The read path used gray-matter's js-yaml default schema, which
 * includes the YAML 1.1 timestamp type; the write path used the `yaml` package's
 * core schema, which does not. A quoted `last_updated: '2026-08-22'` was read as
 * a string, written back UNQUOTED, and re-read as a `Date` (#28).
 *
 * On 2.8.2 the audit consequence was masked by `dateStringSchema` coercing Date
 * back to YYYY-MM-DD, so the visible damage was limited to the file on disk and
 * to any other tool reading the same frontmatter. The defect was real either way.
 */

import { describe, it, expect } from 'vitest';
import {
  parse_frontmatter,
  stringify_frontmatter,
  set_frontmatter,
} from '../../../src/utils/frontmatter.js';
import { metadata_schema } from '../../../src/core/metadata/schema.js';

const doc = (fm: string) => `---\n${fm}\n---\n\nBody text.\n`;

describe('frontmatter round-trip (#28)', () => {
  it('keeps a quoted date a string through parse -> stringify -> parse', () => {
    const src = doc("title: T\nlast_updated: '2026-08-22'\nlast_validated: '2026-08-22'");

    const first = parse_frontmatter(src);
    expect(typeof first.data.last_updated).toBe('string');

    const second = parse_frontmatter(set_frontmatter(src, first.data));
    expect(second.data.last_updated).not.toBeInstanceOf(Date);
    expect(second.data.last_updated).toBe('2026-08-22');
  });

  it('is stable: parse(stringify(parse(src))) deep-equals parse(src)', () => {
    const src = doc(
      [
        'title: T',
        'tier: guide',
        'domains:',
        '  - procedures',
        'status: active',
        "last_updated: '2026-08-22'",
        "version: '1.0.0'",
        "last_validated: '2026-08-22'",
      ].join('\n')
    );

    const once = parse_frontmatter(src).data;
    const twice = parse_frontmatter(set_frontmatter(src, once)).data;
    expect(twice).toEqual(once);

    // and again, so a repeated `maintain --fix` cannot drift
    const thrice = parse_frontmatter(set_frontmatter(src, twice)).data;
    expect(thrice).toEqual(twice);
  });

  it('writes date-shaped values quoted, so other YAML readers agree', () => {
    // Most YAML readers still default to 1.1, where a bare 2026-08-22 is a
    // timestamp. Frontmatter is a shared contract with editors and sister tools.
    const out = stringify_frontmatter({ last_updated: '2026-08-22', version: '1.0.0' });
    expect(out).toContain("last_updated: '2026-08-22'");
  });

  it('quotes date-shaped values nested in objects and arrays', () => {
    const out = stringify_frontmatter({
      provenance: [{ date: '2026-08-22' }],
      nested: { archived_on: '2026-01-05' },
    });
    expect(out).toContain("date: '2026-08-22'");
    expect(out).toContain("archived_on: '2026-01-05'");
  });

  it('does not quote values that merely contain digits', () => {
    const out = stringify_frontmatter({ version: '1.0.0', title: 'Release 2026 notes' });
    expect(out).toContain('version: 1.0.0');
    expect(out).not.toContain("version: '1.0.0'");
  });

  it('reads an already-damaged bare date back as a string, not a Date', () => {
    // Docsets damaged by the old write path self-heal on the next read/write.
    const { data } = parse_frontmatter(doc('last_updated: 2026-08-22'));
    expect(data.last_updated).not.toBeInstanceOf(Date);
    expect(data.last_updated).toBe('2026-08-22');
    expect(stringify_frontmatter(data)).toContain("last_updated: '2026-08-22'");
  });

  it('does not mutate the object it is given', () => {
    const data = { last_updated: '2026-08-22' };
    stringify_frontmatter(data);
    expect(data.last_updated).toBe('2026-08-22');
    expect(typeof data.last_updated).toBe('string');
  });

  it('a round-tripped document still validates', () => {
    const src = doc(
      [
        'title: Sample Procedure',
        'tier: guide',
        'domains:',
        '  - procedures',
        'status: active',
        "last_updated: '2026-08-22'",
        "version: '1.0.0'",
      ].join('\n')
    );
    const round_tripped = parse_frontmatter(set_frontmatter(src, parse_frontmatter(src).data)).data;
    expect(metadata_schema.safeParse(round_tripped).success).toBe(true);
  });
});

describe('ISO timestamps in date fields (#28)', () => {
  it('accepts a full ISO timestamp, normalizing it to YYYY-MM-DD', () => {
    const result = metadata_schema.safeParse({
      title: 'T',
      tier: 'guide',
      domains: ['procedures'],
      status: 'active',
      last_updated: '2026-04-18T00:00:00.000Z',
      version: '1.0.0',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.last_updated).toBe('2026-04-18');
  });

  it('still rejects a value that is not a date at all', () => {
    const result = metadata_schema.safeParse({
      title: 'T',
      tier: 'guide',
      domains: ['procedures'],
      status: 'active',
      last_updated: 'sometime last tuesday',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });
});
