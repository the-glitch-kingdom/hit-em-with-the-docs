import { readFileSync } from 'fs';
import { join } from 'path';

export interface UpgradeConfigKey { key: string; default: unknown; note: string }
export interface UpgradeBehaviourChange { issue: number; note: string; patterns: string[] }
export interface UpgradeNote {
  summary: string;
  config_keys: UpgradeConfigKey[];
  changed_defaults: Array<{ key: string; from: unknown; to: unknown; note: string }>;
  behaviour_changes: UpgradeBehaviourChange[];
  hook_block: string | null;
  template_changes: string | null;
}
export type UpgradeNotes = Record<string, UpgradeNote>;

/** The first release `upgrade-notes.json` covers; older releases have no notes. */
export const FIRST_NOTED_VERSION = '3.1.0';

/** Reads `upgrade-notes.json` shipped at the package root. */
export function load_upgrade_notes(package_root: string): UpgradeNotes {
  return JSON.parse(readFileSync(join(package_root, 'upgrade-notes.json'), 'utf8')) as UpgradeNotes;
}

/** `3.2.1`, `v3.2.1` or `3.3.0-rc.1` as [major, minor, patch]; null when it is not a version. Prerelease and build tags are ignored. */
export function parse_version(text: string): number[] | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
}

/** Orders two versions; text that is not a version sorts as 0.0.0. */
export function compare_versions(a: string, b: string): number {
  const left = parse_version(a) ?? [0, 0, 0];
  const right = parse_version(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return 0;
}

/** Versions with notes after `recorded` (or from 3.1.0 when unrecorded) up to and including `installed`, oldest first. */
export function list_crossed_versions(notes: UpgradeNotes, recorded_text: string | null, installed: string): string[] {
  const recorded = recorded_text !== null && parse_version(recorded_text) ? recorded_text : null; // an invalid recorded value counts as unrecorded
  return Object.keys(notes)
    .filter((version) => compare_versions(version, installed) <= 0 && (recorded === null ? compare_versions(version, FIRST_NOTED_VERSION) >= 0 : compare_versions(version, recorded) > 0))
    .sort(compare_versions);
}
