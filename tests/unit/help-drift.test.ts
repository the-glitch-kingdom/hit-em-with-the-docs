import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import type { Command } from 'commander';
import { ZodType } from 'zod';

// #90: the user-facing surface (commands, flags, config keys) must be named where users work, not only in --help or the code.
// Reads the commander program and the zod config schema directly: no hand-kept list, no CLI spawn.
process.env.HEWTD_NO_PARSE = '1';
const { program } = await import('../../src/cli/index');
const { plugin_config_schema } = await import('../../src/utils/config');

const root = resolve(__dirname, '../..');
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8');
const list_md = (dir: string): string[] =>
  readdirSync(resolve(root, dir), { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.md')).map((file) => join(dir, file));

const help = read('commands/help.md');
const slash_commands = list_md('commands').map((file) => file.replace(/^commands\/|\.md$/g, ''));
const doc_files = [...list_md('commands'), ...list_md('docs'), ...list_md('skills').filter((file) => file.endsWith('SKILL.md')), 'README.md'];
const docs = doc_files.map((file) => ({ file, text: read(file) }));
const all_text = docs.map((doc) => doc.text).join('\n');

// Options every command shares or that commander adds itself: they only need to appear in some doc.
const COMMON_FLAG_MIN_COMMANDS = 4;

// Config keys that are internal or catch-all, with the reason (keep this list short).
const CONFIG_KEY_EXEMPT = new Set<string>([]);
// Leaves too generic for a bare word match: these need `parent.leaf` in the docs.
const GENERIC_LEAVES = new Set(['allow', 'root']);

interface FlagUse { command: string; flag: string }
function list_flags(command: Command, trail: string[] = []): FlagUse[] {
  const here = [...trail, ...(trail.length || command.parent ? [command.name()] : [])];
  const own = command.options.map((option) => option.long).filter((flag): flag is string => !!flag && flag !== '--help' && flag !== '--version')
    .map((flag) => ({ command: here.join(' '), flag }));
  return [...own, ...command.commands.flatMap((child) => list_flags(child, here))];
}

function list_config_keys(schema: unknown, prefix = ''): string[] {
  let node = schema as { _def: Record<string, unknown>; shape?: Record<string, unknown> };
  while (!node.shape && (node._def.innerType || node._def.schema)) node = (node._def.innerType ?? node._def.schema) as typeof node;
  if (!node.shape) return [];
  return Object.entries(node.shape).flatMap(([name, child]) => [`${prefix}${name}`, ...list_config_keys(child, `${prefix}${name}.`)]);
}

const flag_re = (flag: string): RegExp => new RegExp(`${flag}(?![\\w-])`);

describe('#90 the whole surface is documented', () => {
  it('reads the program and the schema', () => {
    expect(program.commands.length).toBeGreaterThan(20);
    expect(plugin_config_schema).toBeInstanceOf(ZodType);
    expect(list_config_keys(plugin_config_schema)).toContain('reconcile.secrets.disabled_rules');
  });

  describe('commands/help.md', () => {
    const names = program.commands.flatMap((command) => [command.name(), ...command.aliases()]).filter((name) => name !== 'help');
    it.each([...new Set(names)])('CLI command %s', (name) => {
      expect(help).toMatch(new RegExp(`\`(?:hewtd )?${name}(?=[\\s\`|\\[<])`));
    });
    // A subcommand (discover patterns, domain add) is named on a help line that also names its parent.
    const nested = program.commands.flatMap((parent) => parent.commands.map((child) => [parent.name(), child.name()] as const));
    it.each(nested.map(([parent, child]) => [`${parent} ${child}`, parent, child] as const))('CLI subcommand %s', (_label, parent, child) => {
      expect(help.split('\n').some((line) => new RegExp(`\\b${parent}\\b`).test(line) && new RegExp(`(?<![\\w-])${child}(?![\\w-])`).test(line)), `${parent} ${child} is not on a help.md line with ${parent}`).toBe(true);
    });
    it.each(slash_commands)('slash command %s', (name) => {
      expect(help).toMatch(new RegExp(`/hit-em-with-the-docs:${name}(?![\\w-])`));
    });
    it.each(['reconcile', 'graph', 'secrets'])('topic %s', (topic) => {
      expect(help).toMatch(new RegExp(`^- \`${topic}\``, 'm'));
    });
    it('frontmatter contract names sources and external_refs', () => {
      expect(help).toContain('external_refs');
      expect(help).toMatch(/`sources`/);
    });
  });

  describe('CLI options', () => {
    const uses = list_flags(program);
    const commands_per_flag = new Map<string, number>();
    for (const use of uses) commands_per_flag.set(use.flag, (commands_per_flag.get(use.flag) ?? 0) + 1);
    it.each(uses.map((use) => [`${use.command} ${use.flag}`, use] as const))('%s', (_label, use) => {
      // a flag many commands share is documented once, in help.md's common options
      if ((commands_per_flag.get(use.flag) ?? 0) >= COMMON_FLAG_MIN_COMMANDS) return expect(flag_re(use.flag).test(help), `${use.flag} (shared by ${commands_per_flag.get(use.flag)} commands) is not in commands/help.md`).toBe(true);
      // A command-specific flag must sit near its command: in commands/<command>.md, or within 8 lines of the command's name.
      const top = use.command.split(' ')[0]!;
      const covered = docs.some((doc) => {
        if (doc.file === join('commands', `${top}.md`) && flag_re(use.flag).test(doc.text)) return true;
        const lines = doc.text.split('\n');
        return lines.some((line, index) => flag_re(use.flag).test(line) &&
          lines.slice(Math.max(0, index - 8), index + 9).some((near) => near.includes(use.command)));
      });
      expect(covered, `${use.flag} of "${use.command}" is not named near the command in any doc`).toBe(true);
    });
  });

  describe('config keys', () => {
    it.each(list_config_keys(plugin_config_schema).filter((key) => !CONFIG_KEY_EXEMPT.has(key)))('%s', (key) => {
      const parts = key.split('.');
      const leaf = parts.at(-1)!;
      const needle = GENERIC_LEAVES.has(leaf) || parts.length === 1 && leaf.length < 4 ? parts.slice(-2).join('.') : leaf;
      const word = (text: string) => new RegExp(`(?<![\\w])${text.replace(/\./g, '\\.')}(?![\\w])`);
      // a nested key's leaf counts only in its dotted form or within 15 lines of its parent's name
      const parent = parts.at(-2);
      const found = !parent || needle.includes('.') ? word(needle).test(all_text) : word(`${parent}.${leaf}`).test(all_text) || docs.some((doc) => {
        const lines = doc.text.split('\n');
        return lines.some((line, index) => word(leaf).test(line) && lines.slice(Math.max(0, index - 15), index + 16).some((near) => word(parent).test(near)));
      });
      expect(found, `config key ${key} (searched for ${needle}) is not named in any doc`).toBe(true);
    });
  });
});
