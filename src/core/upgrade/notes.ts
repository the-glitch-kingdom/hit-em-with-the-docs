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

export function compare_versions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
  return 0;
}

/** Versions with notes after `recorded` (or from 3.1.0 when unrecorded) up to and including `installed`, oldest first. */
export function list_crossed_versions(notes: UpgradeNotes, recorded: string | null, installed: string): string[] {
  return Object.keys(notes)
    .filter((version) => compare_versions(version, installed) <= 0 && (recorded === null ? compare_versions(version, FIRST_NOTED_VERSION) >= 0 : compare_versions(version, recorded) > 0))
    .sort(compare_versions);
}
