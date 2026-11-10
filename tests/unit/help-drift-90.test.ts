import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const root = resolve(__dirname, '../..');
const help = readFileSync(resolve(root, 'commands/help.md'), 'utf8');

// Needs a built CLI (npm run build).
const cli_help = execFileSync('node', [resolve(root, 'dist/cli/index.js'), '--help'], { encoding: 'utf8' });
const cli_commands = cli_help
  .split('Commands:')[1]
  .split('\n')
  .map((line) => /^ {2}(\S+)/.exec(line)?.[1])
  .filter((name): name is string => !!name)
  .flatMap((name) => name.split('|'))
  .filter((name) => name !== 'help');

const slash_commands = readdirSync(resolve(root, 'commands'))
  .filter((file) => file.endsWith('.md'))
  .map((file) => file.replace(/\.md$/, ''));

describe('#90 commands/help.md covers the whole surface', () => {
  it.each(cli_commands)('CLI command %s', (name) => {
    expect(help).toMatch(new RegExp(`\`(hewtd )?${name}[ \`]`));
  });

  it.each(slash_commands)('slash command %s', (name) => {
    expect(help).toContain(`/hit-em-with-the-docs:${name}`);
  });

  it.each(['reconcile', 'graph', 'secrets'])('topic %s', (topic) => {
    expect(help).toMatch(new RegExp(`^- \`${topic}\``, 'm'));
  });

  it('frontmatter contract names sources and external_refs', () => {
    expect(help).toContain('external_refs');
    expect(help).toMatch(/`sources`/);
  });
});
