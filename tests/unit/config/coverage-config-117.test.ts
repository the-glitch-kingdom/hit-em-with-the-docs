import { describe, it, expect } from 'vitest';
import { plugin_config_schema } from '../../../src/utils/config.js';

describe('coverage config (#117)', () => {
  it('coverage.ignore takes strings and {path|name, reason}; junk is dropped; default empty', () => {
    expect(plugin_config_schema.parse({}).coverage.ignore).toEqual([]);
    const parsed = plugin_config_schema.parse({ coverage: { ignore: ['a/**', { name: 'X', reason: 'r' }, { reason: 'no target' }, 5, { path: 'p' }] } });
    expect(parsed.coverage.ignore).toEqual([{ path: 'a/**' }, { name: 'X', reason: 'r' }, { path: 'p' }]);
    expect(plugin_config_schema.parse({ coverage: 'x' }).coverage.ignore).toEqual([]);
  });
  it('targets.code_coverage is opt-in: absent by default, a bad value opts out', () => {
    expect(plugin_config_schema.parse({}).targets.code_coverage).toBeUndefined();
    expect(plugin_config_schema.parse({ targets: { code_coverage: { min: 0.6 } } }).targets.code_coverage?.min).toBe(0.6);
    expect(plugin_config_schema.parse({ targets: { code_coverage: 'yes' } }).targets.code_coverage).toBeUndefined();
  });
});
