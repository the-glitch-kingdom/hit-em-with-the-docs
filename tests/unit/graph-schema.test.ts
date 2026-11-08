import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GRAPH_VERDICTS, GRAPH_REF_KINDS, type GraphV1 } from '../../src/core/graph/schema.js';

const schema = JSON.parse(readFileSync(join(__dirname, '../../schemas/graph.v1.schema.json'), 'utf8'));

// Tiny checker for the keyword subset the schema uses (no new dependency).
function check(s: any, v: any, path = '$'): string[] {
  if (s.$ref) return check(s.$ref.split('/').reduce((n: any, k: string) => (k === '#' ? schema : n[k]), schema), v, path);
  if (s.oneOf) return s.oneOf.some((o: any) => check(o, v, path).length === 0) ? [] : [`${path}: no oneOf match`];
  if ('const' in s) return v === s.const ? [] : [`${path}: expected ${s.const}`];
  if (s.enum) return s.enum.includes(v) ? [] : [`${path}: not in enum`];
  const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  if (s.type && !([] as string[]).concat(s.type).includes(t)) return [`${path}: expected ${s.type}, got ${t}`];
  if (s.pattern && typeof v === 'string' && !new RegExp(s.pattern).test(v)) return [`${path}: pattern`];
  const errs: string[] = [];
  if (t === 'object') {
    for (const r of s.required ?? []) if (!(r in v)) errs.push(`${path}.${r}: missing`);
    for (const [k, x] of Object.entries(v)) {
      const sub = s.properties?.[k] ?? (typeof s.additionalProperties === 'object' ? s.additionalProperties : null);
      if (sub) errs.push(...check(sub, x, `${path}.${k}`));
    }
  }
  if (t === 'array' && s.items) v.forEach((x: any, i: number) => errs.push(...check(s.items, x, `${path}[${i}]`)));
  return errs;
}

const graph: GraphV1 = {
  version: 1,
  source_commit: 'a'.repeat(40),
  docs: {
    'devops/x.md': {
      body_changed: '2026-08-01',
      verdict: 'verified',
      last_verified: '2026-10-02',
      refs: [
        { kind: 'file', target: 'scripts/ci/guards.sh', resolved: true, code_changed: '2026-10-20' },
        { kind: 'symbol', target: 'check_rls', file: 'backend/check_rls.py', resolved: true, code_changed: '2026-09-30' },
        { kind: 'file', target: 'src/old.py', resolved: false },
        { kind: 'file', target: 'lib/server.ts', repo: 'voice-agent', resolved: true, code_changed: '2026-10-11' },
        { kind: 'table', target: 'tasks', resolved: null },
      ],
      owner_of: ['devops/x.md#rollback'],
      points_to: [{ from: '#rollback', to: 'devops/y.md#rollback' }, { from: null, to: 'devops/y.md#top' }],
      duplicates: [{ section: '#setup', owner: 'devops/z.md#setup' }],
    },
    'a.md': { body_changed: null, verdict: 'unreviewed', last_verified: null, refs: [], owner_of: [], points_to: [], duplicates: [] },
  },
  symbols: { check_rls: { file: 'backend/check_rls.py', cited_by: ['devops/x.md'] } },
};

describe('graph.v1 schema', () => {
  it('accepts a full fixture, and one with null source_commit and unknown extra fields', () => {
    expect(check(schema, graph)).toEqual([]);
    expect(check(schema, { ...graph, source_commit: null, future: 1 })).toEqual([]);
  });

  it('rejects bad version, verdict, ref kind, date, missing field', () => {
    expect(check(schema, { ...graph, version: 2 })).not.toEqual([]);
    const bad = (mut: (g: any) => void) => {
      const g = JSON.parse(JSON.stringify(graph));
      mut(g);
      return check(schema, g);
    };
    expect(bad((g) => (g.docs['a.md'].verdict = 'maybe'))).not.toEqual([]);
    expect(bad((g) => (g.docs['devops/x.md'].refs[0].kind = 'url'))).not.toEqual([]);
    expect(bad((g) => (g.docs['a.md'].body_changed = '2026-8-1'))).not.toEqual([]);
    expect(bad((g) => delete g.docs['a.md'].refs)).not.toEqual([]);
    expect(bad((g) => (g.docs['devops/x.md'].refs[2].resolved = 'no'))).not.toEqual([]);
  });

  it('stays in sync with the TypeScript constants', () => {
    expect(schema.$defs.doc.properties.verdict.enum).toEqual([...GRAPH_VERDICTS]);
    expect(schema.$defs.ref.properties.kind.enum).toEqual([...GRAPH_REF_KINDS]);
  });
});
