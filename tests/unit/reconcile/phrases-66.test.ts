import { describe, it, expect } from 'vitest';
import { buildPhrases, normalizeQuery } from '../../../src/core/reconcile/phrases.js';

const cfg = { allow: [], disabled_rules: [] };
// Built at runtime: no secret-shaped literal in the repo.
const token = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';

describe('buildPhrases (#66)', () => {
  it('normalizes whitespace and trailing punctuation, keeps casing', () => {
    expect(normalizeQuery('  How do I  roll back?? ')).toBe('How do I roll back');
  });
  it('merges near-duplicates, keeping the most frequent', () => {
    const r = buildPhrases([
      { query: 'how do I roll back a bad deploy?', count: 4 },
      { query: 'roll back a bad deploy', count: 1 },
      { query: 'how to roll back bad deploy', count: 2 },
    ], [], cfg, 5);
    expect(r.accepted.map((a) => a.query)).toEqual(['how do I roll back a bad deploy']);
    expect(r.dropped.filter((d) => d.reason === 'duplicate')).toHaveLength(2);
  });
  it('does not merge distinct questions that share one keyword', () => {
    const r = buildPhrases([
      { query: 'how do I roll back a bad deploy', count: 3 }, { query: 'how to deploy to staging', count: 2 },
    ], ['how do I deploy'], cfg, 5);
    expect(r.accepted.map((a) => a.query)).toEqual(['how do I roll back a bad deploy', 'how to deploy to staging']);
  });
  it('merges against existing phrases and counts them toward the cap', () => {
    const r = buildPhrases([
      { query: 'restore the database from backup' }, { query: 'rotate the signing keys safely' }, { query: 'clear the stuck job queue' },
    ], ['restore database from backup', 'a', 'b'], cfg, 4);
    expect(r.accepted).toHaveLength(1);
    expect(r.dropped.map((d) => d.reason).sort()).toEqual(['duplicate', 'over cap']);
  });
  it('drops short and long queries', () => {
    const r = buildPhrases([{ query: 'deploy broken' }, { query: Array(21).fill('word').map((w, i) => w + i).join(' ') }], [], cfg, 5);
    expect(r.dropped.map((d) => d.reason)).toEqual(['too short', 'too long']);
  });
  it('drops a secret-shaped query with a masked note, never the text', () => {
    const r = buildPhrases([{ query: `why does key ${token} fail on login` }], [], cfg, 5);
    expect(r.accepted).toEqual([]);
    expect(r.dropped[0]!.reason).toBe('secret');
    expect(JSON.stringify(r)).not.toContain(token);
    expect(r.dropped[0]!.note).toMatch(/…\d+$/);
  });
});
