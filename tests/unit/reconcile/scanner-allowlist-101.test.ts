import { describe, it, expect } from 'vitest';
import { add_gitleaks_allowlist, add_baseline_exclude, get_cold_regex } from '../../../src/core/reconcile/scanner-allowlist';

// #101: pure text edits for the scanner configs a promote touches.
const re = get_cold_regex('.documentation-cold');
const entry = `'''${re}'''`;

describe('get_cold_regex', () => {
  it('anchors and escapes the cold root', () => {
    expect(re).toBe('^\\.documentation-cold/');
    expect(get_cold_regex('a+b/c')).toBe('^a\\+b/c/');
  });
});

describe('add_gitleaks_allowlist', () => {
  it('a new file extends the default rules (never replaces them)', () => {
    expect(add_gitleaks_allowlist(null, re)).toBe(`[extend]\nuseDefault = true\n\n[allowlist]\npaths = [${entry}]\n`);
  });
  it('inserts into an existing paths array, single or multi line, once', () => {
    const one = add_gitleaks_allowlist('[allowlist]\npaths = ["x"]\n', re)!;
    expect(one).toBe(`[allowlist]\npaths = [${entry}, "x"]\n`);
    const multi = add_gitleaks_allowlist('[allowlist]\npaths = [\n  "x",\n]\n[[rules]]\nid="r"\n', re)!;
    expect(multi).toContain(`paths = [${entry}, \n  "x",\n]`);
    expect(add_gitleaks_allowlist(one, re)).toBeNull();
  });
  it('adds a paths line to an [allowlist] that has none, and leaves other sections alone', () => {
    expect(add_gitleaks_allowlist('[allowlist]\ndescription = "d"\n[[rules]]\nid="r"\npaths=["rule-path"]\n', re)).toBe(`[allowlist]\npaths = [${entry}]\ndescription = "d"\n[[rules]]\nid="r"\npaths=["rule-path"]\n`);
  });
  it('appends a block when there is no [allowlist], [[allowlists]] when the file already uses it', () => {
    expect(add_gitleaks_allowlist('[[rules]]\nid="r"', re)).toBe(`[[rules]]\nid="r"\n\n[allowlist]\npaths = [${entry}]\n`);
    expect(add_gitleaks_allowlist('[[allowlists]]\npaths=["v"]\n', re)).toBe(`[[allowlists]]\npaths=["v"]\n\n[[allowlists]]\npaths = [${entry}]\n`);
  });
});

describe('add_baseline_exclude', () => {
  it('extends the should_exclude_file filter, or adds it, keeping the indent', () => {
    const has = JSON.stringify({ filters_used: [{ path: 'detect_secrets.filters.regex.should_exclude_file', pattern: ['^v/'] }] }, null, 4) + '\n';
    expect(JSON.parse(add_baseline_exclude(has, re)!).filters_used[0].pattern).toEqual(['^v/', re]);
    expect(add_baseline_exclude(has, re)!.startsWith('{\n    "filters_used"')).toBe(true);
    const none = JSON.stringify({ filters_used: [] });
    expect(JSON.parse(add_baseline_exclude(none, re)!).filters_used).toEqual([{ path: 'detect_secrets.filters.regex.should_exclude_file', pattern: [re] }]);
  });
  it('handles the old exclude.files form', () => {
    expect(JSON.parse(add_baseline_exclude('{"exclude":{"files":"^v/","lines":null}}', re)!).exclude.files).toBe(`^v/|${re}`);
  });
  it('is a no-op when already present, unreadable or an unknown format', () => {
    const once = add_baseline_exclude('{"filters_used":[]}', re)!;
    expect(add_baseline_exclude(once, re)).toBeNull();
    expect(add_baseline_exclude('not json', re)).toBeNull();
    expect(add_baseline_exclude('{"results":{}}', re)).toBeNull();
  });
});
