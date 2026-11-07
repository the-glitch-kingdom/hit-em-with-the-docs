# Hit 'Em With The Docs

> A self-managing documentation system that keeps your docs organized, accurate, and easy to find.

[![npm version](https://img.shields.io/npm/v/@theglitchking/hit-em-with-the-docs.svg)](https://www.npmjs.com/package/@theglitchking/hit-em-with-the-docs)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Action](https://img.shields.io/badge/GitHub-Action-blue?logo=github)](https://github.com/marketplace/actions/hit-em-with-the-docs)

> [!IMPORTANT]
> You still need to remember to use this plugin when creating documentation! As projects grow, documentation needs to be created and maintained. You'll need to invoke this plugin or ask an LLM to create documentation for your features, workflows, or infrastructure. This plugin must be invoked to create, update, or maintain your docs.

> [!NOTE]
> **2.16.0** adds `reconcile.related_repos` (summarize and cross-link, never copy), atomic `--apply` and fewer false "missing" references; see the [CHANGELOG](./CHANGELOG.md).
>
> **2.15.0 — `/reconcile`.** Check existing docs against the code in scoped, resumable batches: `hewtd reconcile <scope>` triages (deterministic, no LLM), the `/hit-em-with-the-docs:reconcile` slash command judges, and `--apply` writes only what you accept. Optional agent-team mode for big jobs, an outside-the-tree lane, a ledger under `.hewtd/`, and a `moved_from` frontmatter field. See [`docs/reconcile.md`](./docs/reconcile.md) and the [CHANGELOG](./CHANGELOG.md).
>
> **2.14.0 — follow-ups.** `integrate` now refuses a file already inside the docs tree at a path other than its target (use `maintain --fix` / `metadata-sync`). Commands find `.documentation` from any subdirectory. `fix-retrieval-fields` drops filler. `hewtd index` rebuilds KB indexes and stamps old reports. `OVERVIEW_MISSING` fires per flow, not per domain. See [CHANGELOG](./CHANGELOG.md).
>
> **2.5.0 — INDEX/REGISTRY regeneration fix.** `integrate` could only append a row to an INDEX.md that already had a table, so the *first* document into any domain was never registered — and the failure was silently swallowed. `integrate` and `maintain` now rebuild domain + root `INDEX.md`/`REGISTRY.md` from the documents on disk via the real generators. New `hewtd index` (alias `reindex`) command regenerates all indexes on demand; `maintain` self-heals them every run; `audit` gains an `index-drift` rule that `--strict` gates CI on. Closes [#7](https://github.com/TheGlitchKing/hit-em-with-the-docs/issues/7). See [CHANGELOG](./CHANGELOG.md#250--2026-05-16).
>
> **2.4.0 — `migrate-incident` path bug fix + recovery command.** `migrate-incident` now correctly writes to `<vault-root>/incidents/<slug>/` (the location `hewtd maintain`'s incidents-index generator scans). In 2.3.0 the target was derived from the source flat file's parent dir, which silently bypassed the canonical layout when the flat file lived at the vault root. New `hewtd fix-legacy-layout` command relocates 2.3.0-buggy folders and rewrites fact `provenance:` refs. Idempotent, dry-run supported. See [CHANGELOG](./CHANGELOG.md#240--2026-05-15).
>
> **New in 2.3.0:** the knowledge-base primitives layer. Three new tiers (`fact`, `incident-narrative`, `incident-facts`) for citable atomic claims and immutable postmortems, plus an optional `symptoms:` frontmatter field on any-tier playbooks for symptom→playbook routing with `cites:` to facts. Three new deterministic indexes (`facts/INDEX.md`, `incidents/INDEX.md`, `symptoms/INDEX.md`) auto-generate on `hewtd maintain` when a vault root exists. Five new CLI commands: `find-citers`, `audit-facts [--run-verify]`, `extract-facts`, `cite`, `migrate-incident`. New `audit --strict` flag for CI gating. New `/hit-em-with-the-docs:help` slash command for LLM orientation. Four authoring templates at `templates/knowledge-base/`. Full reference: [`docs/knowledge-base-primitives.md`](./docs/knowledge-base-primitives.md). Agent guide: [`docs/LLM-GUIDE.md`](./docs/LLM-GUIDE.md).
>
> **New in 2.2.0:** the `tier` enum gains a `"plan"` value for [persistent-planning](https://github.com/TheGlitchKing/persistent-planning) lg-mode artifacts (phase / task / atom / notes documents), and the `version` and `status` fields are now conditionally relaxed for plan-tier docs (plans use lifecycle status, not semver). Existing tiers (guide / standard / example / reference / admin) are unchanged. See [`docs/plan-tier-frontmatter.md`](./docs/plan-tier-frontmatter.md) for the full reference.

---

## Summary

When projects get bigger, documentation becomes a mess. Important information gets lost across many files, links break when you move things around, and nobody knows if the docs are still correct. Hit 'Em With The Docs fixes these problems by organizing everything into 15 clear categories, automatically checking your links, and making sure every document has the right information tags. The system watches your docs and fixes common problems without you having to do it manually. Everything stays organized and up-to-date so your team can find what they need fast.

---

## Operational Summary

The plugin creates a special folder called `.documentation` in your project with 15 organized sections called "domains" - things like security, API docs, database guides, and testing information. When you add a document, the system reads it and figures out which category it belongs in based on keywords and content. Each document gets special information tags (metadata) added to the top - things like the title, what category it's in, when it was last updated, and how long it takes to read. This metadata helps both you and the system understand what each document is about.

The system includes automated tools that check your documentation for problems. It scans through all your files looking for broken links between documents, makes sure the metadata is complete, checks that files are named correctly, and verifies they're in the right folders. You can run these checks yourself whenever you want, or set them up to run automatically in your build process using GitHub Actions. The plugin can also look through your actual source code to find patterns (like how you structure your classes or handle errors) and automatically create documentation from what it discovers. Everything works with markdown files and gives you a health score from 0 to 100 so you know how good your documentation is.

---

## Features

- **Organized Structure**: Automatically creates 15 specialized categories for different types of documentation
- **Smart Classification**: Reads your documents and automatically puts them in the right category
- **Metadata Management**: Tracks 22 different pieces of information about each document (title, status, tags, last update, etc.)
- **Link Checking**: Finds and reports broken links between documents
- **Auto-Fixing**: Automatically repairs common problems like missing metadata
- **Pattern Discovery**: Scans your code to find and document coding patterns
- **Health Reports**: Generates reports showing the overall quality of your documentation with a 0-100 score
- **GitHub Integration**: Works as a GitHub Action for automated checks on every commit
- **CLI Tool**: Full command-line interface for all operations
- **Search Functionality**: Quick search across all documentation
- **Claude Code Plugin**: Integrates with Claude Code so AI can read and help maintain your docs
- **Sister Plugin Companion**: When [`semantic-pages`](https://github.com/TheGlitchKing/semantic-pages) is also installed, a **read-only** MCP server is auto-wired over `./.documentation/` so Claude can semantically search your docs without risking accidental writes (hewtd stays the sole writer of the tree)

---

## Sister Plugin: semantic-pages

`hit-em-with-the-docs` is the canonical **writer** of `./.documentation/` — it scaffolds the 15-domain structure, classifies incoming docs, maintains the 22-field metadata schema, checks links, and produces health reports. By design, it treats `./.documentation/` as a tree it owns.

[`semantic-pages`](https://github.com/TheGlitchKing/semantic-pages) is the canonical **reader**. It's a local MCP server that indexes any folder of markdown into a vector database + knowledge graph, exposing semantic search, wikilink traversal, and CRUD tools to Claude Code.

When both plugins are installed together, `semantic-pages` auto-detects hewtd via Claude Code's plugin registry and stands up a **second, read-only** MCP instance pointed at `./.documentation/`. The read-only mode suppresses all 7 write tools (`create_note`, `update_note`, `delete_note`, `move_note`, `update_frontmatter`, `manage_tags`, `rename_tag`) so Claude can search and read the docs tree but can't race hewtd over writes. Your personal scratch vault at `./.claude/.vault/` stays fully read/write.

### Behavior matrix

| `hit-em-with-the-docs` | `semantic-pages` | Result |
|---|---|---|
| ✗ | ✗ | nothing |
| ✓ | ✗ | hewtd CLI only; `.documentation/` managed but not indexed |
| ✗ | ✓ | single MCP at `./.claude/.vault` (read/write) |
| ✓ | ✓ | `./.claude/.vault` (r/w) **+** `./.documentation` (read-only) |

### How it's wired

`semantic-pages` ships a `SessionStart` hook that runs at the start of every Claude Code session and reconciles the project's `.mcp.json`. If hewtd is enabled in `~/.claude/settings.json` **and** `./.documentation/` exists in the current project, it adds a `semantic-pages` MCP entry pointed at `./.documentation` with `--read-only`. If either condition stops being true, it idempotently cleans up. See the [semantic-pages Sister Plugin docs](https://github.com/TheGlitchKing/semantic-pages#sister-plugin-hit-em-with-the-docs) for the full auto-wiring behavior.

### Why we don't do it from hewtd's side

hewtd does **not** ship any MCP configuration, declare semantic-pages as a dependency, or write to `.mcp.json`. Installing hewtd alone gives you a CLI-only tool with no MCP server — your project stays clean. The auto-wire only kicks in when a user has explicitly installed both plugins, signaling they want Claude to semantically index the hewtd-managed tree. The wiring logic lives entirely on the semantic-pages side.

### Install both

```bash
# Inside a Claude Code session
/plugin marketplace add TheGlitchKing/hit-em-with-the-docs
/plugin install hit-em-with-the-docs@hit-em-with-the-docs-marketplace

/plugin marketplace add TheGlitchKing/semantic-pages
/plugin install semantic-pages@semantic-pages-marketplace
```

Next session start, `./.claude/.vault/` is created, `.mcp.json` is wired, and Claude has 14 read tools on `./.documentation/` plus 21 full tools on `./.claude/.vault/`.

---

## Quick Start

### 1. Installation Methods

#### Method A: NPM Installation

##### Global Installation (Recommended for regular use)

This installs the tool on your computer so you can use it in any project.

**Step 1**: Open your terminal or command prompt

**Step 2**: Type this command and press Enter:
```bash
npm install -g @theglitchking/hit-em-with-the-docs
```

**Step 3**: Wait for the installation to complete. You'll see some messages about downloading packages.

**Step 4**: Test that it worked by typing:
```bash
hewtd --version
```

**Step 5**: You should see a version number like `2.0.0`. If you do, it's installed correctly!

**To enable the plugin in your project**:
```bash
# Go to your project folder
cd /path/to/your/project

# Create the documentation structure
hewtd init

# You should see a new .documentation folder with 15 categories inside
```

##### Update management *(2.1.0+)*

Every install ships with an update policy that controls what happens at the start of each Claude Code session when a newer version is available on npm. The default is conservative — a one-liner nudge, no automatic changes.

```bash
# Show installed / latest / policy / hook state
hewtd status

# Opt into automatic updates on session start
hewtd policy auto

# One-liner notification only (default)
hewtd policy nudge

# Silence the update check entirely
hewtd policy off

# Force an update right now
hewtd update
```

Slash-command parity: `/hit-em-with-the-docs:status`, `/hit-em-with-the-docs:policy <mode>`, `/hit-em-with-the-docs:update`.

Policy resolution order: `HIT_EM_WITH_THE_DOCS_UPDATE_POLICY` env var → `<project>/.claude/hit-em-with-the-docs.json` → default `nudge`.

See [CHANGELOG.md](./CHANGELOG.md) for the full 2.1.0 release notes and env-var opt-outs.

##### NPX Method (No installation needed)

This lets you use the tool without installing it permanently.

**Step 1**: Open your terminal in your project folder

**Step 2**: Run any command by putting `npx @theglitchking/hit-em-with-the-docs` before it:
```bash
npx @theglitchking/hit-em-with-the-docs init
```

**Step 3**: The first time you run it, NPX will download the tool (this takes a few seconds)

**Step 4**: After that, it runs your command automatically

**Use this method when**: You want to try the tool without installing it, or you only need it occasionally.

##### Project Installation (For team projects)

This installs the tool only for one specific project.

**Step 1**: Open your terminal in your project folder

**Step 2**: Type this command:
```bash
npm install --save-dev @theglitchking/hit-em-with-the-docs
```

**Step 3**: Add a script to your `package.json` file:
```json
{
  "scripts": {
    "docs": "hewtd",
    "docs:check": "hewtd maintain --quick",
    "docs:fix": "hewtd maintain --quick --fix"
  }
}
```

**Step 4**: Now you can use it with npm commands:
```bash
npm run docs init          # Create documentation structure
npm run docs:check         # Check documentation health
npm run docs:fix           # Fix documentation problems
```

**To enable the plugin**:
```bash
npm run docs init
```

#### Method B: Claude Code Plugin Installation

This method installs it as a plugin for Claude Code so Claude can help manage your documentation.

**Step 1**: Open Claude Code

**Step 2**: Type this command in your conversation:
```
/plugin install TheGlitchKing/hit-em-with-the-docs
```

**Step 3**: Wait for Claude to confirm the installation

**Step 4**: The plugin is now installed! Claude can now use special `/docs` commands.

**To enable and initialize in your project**:

Ask Claude in conversation:
```
Please initialize hit-em-with-the-docs in this project
```

Or use the command:
```
/docs init
```

Claude will create the `.documentation` folder with all 15 categories for you.

---

### 2. How to Use

#### CLI Commands

These commands run in your terminal and manage your documentation.

| Command | Description |
|---------|-------------|
| `hewtd init` | Create the documentation structure with 15 categories |
| `hewtd maintain` | Run full health check and fix problems |
| `hewtd integrate <file>` | Add a document to the system |
| `hewtd list` | Show all 15 documentation categories |
| `hewtd domain list\|add\|remove` | Manage custom domains beyond the built-in 15 |
| `hewtd search <query>` | Search for content in your docs |
| `hewtd metadata-sync` | Update document information tags |
| `hewtd link-check` | Find broken links between documents |
| `hewtd audit` | Check documentation quality and compliance |
| `hewtd report <type>` | Generate health, audit, or link reports |
| `hewtd discover` | Scan code for patterns and create docs |
| `hewtd archive <file>` | Retire a doc into `archive/` (reversible, link-safe) |
| `hewtd unarchive <file>` | Restore an archived doc to where it came from |
| `hewtd archive-candidates` | List docs that may warrant archiving (advisory) |
| `hewtd fix-retrieval-fields [--apply]` | Move `summary`/`description` into `purpose`, merge `keywords` into `tags` (dry run by default) |

##### Command Examples and Details

**`hewtd init` - Set up documentation**

**How to use it**:
```bash
# Basic setup in current folder
hewtd init

# Set up in a custom location
hewtd init --path ./docs

# Replace existing structure
hewtd init --force
```

**When to use it**: First time setting up documentation in a project.

**What to use it on**: Your project root folder (it creates a `.documentation` folder there).

**What to expect**: Creates 53 files and folders organized into 15 categories like security, api, database, testing, etc. Each category gets an INDEX.md (table of contents) and REGISTRY.md (quick list).

---

**`hewtd maintain` - Check and fix your docs**

**How to use it**:
```bash
# Full check (looks at everything)
hewtd maintain

# Quick check (skips link checking, much faster)
hewtd maintain --quick

# Quick check and auto-fix problems
hewtd maintain --quick --fix

# Full check with auto-fix
hewtd maintain --fix
```

**When to use it**:
- Before committing code changes
- Once a week for regular maintenance
- Before releasing a new version
- When you've added lots of new documentation

**What to use it on**: Your entire `.documentation` folder.

**What to expect**:
- You'll see a health score from 0 to 100 (aim for 80+)
- A list of issues found (broken links, missing metadata, misplaced files)
- If you use `--fix`, it automatically fixes what it can
- A detailed report saves to `.documentation/reports/maintenance-[date].md`
- Takes 5-30 seconds depending on how many docs you have

**Example output**:
```
✓ Metadata completeness: 95%
✓ Link health: 100%
✓ Naming compliance: 87%
⚠ Found 3 issues
✓ Fixed 3 issues
Health Score: 92/100
```

---

**`hewtd integrate <file>` - Add documents to the system**

**How to use it**:
```bash
# Add a single document (it will ask which category)
hewtd integrate ./my-guide.md

# Preview where it would go without moving it
hewtd integrate ./my-guide.md --dry-run

# Automatic mode (uses best guess, no questions)
hewtd integrate ./my-guide.md --auto

# Add multiple documents at once
for file in old-docs/*.md; do
  hewtd integrate "$file" --auto
done
```

A file already inside the docs tree at a path different from its target is
refused ("already in the docs tree"; nothing is written): use
`hewtd maintain --fix` or `hewtd metadata-sync` for it. All commands find
`.documentation` by walking up from the current directory (stopping at the
git root); an explicit `-p` is taken as given.

**When to use it**: When you have markdown files outside the `.documentation` folder that you want to organize.

**What to use it on**: Individual markdown (.md) files or a folder of markdown files.

**What to expect**:
- The tool reads your document's content
- It suggests which category it belongs in (like "security" or "api")
- It adds metadata to the top of the file
- It moves the file to the correct folder
- In auto mode, it does this without asking questions

---

**`hewtd list` - Show all categories**

**How to use it**:
```bash
hewtd list
```

**When to use it**: When you need a quick reminder of what categories are available.

**What to expect**: A table showing all 15 categories with descriptions:
```
┌─────────────────┬──────────┬────────────────────────────┐
│ Domain          │ Priority │ Description                │
├─────────────────┼──────────┼────────────────────────────┤
│ security        │ 9        │ Security and auth docs     │
│ api             │ 8        │ API endpoints              │
│ database        │ 8        │ Database schema            │
└─────────────────┴──────────┴────────────────────────────┘
```

---

**`hewtd search <query>` - Find information**

**How to use it**:
```bash
# Search all docs
hewtd search "authentication"

# Search only security docs
hewtd search "authentication" --domain security

# Search with multiple words
hewtd search "user login flow"
```

**When to use it**: When you need to find where specific information is documented.

**What to use it on**: Any topic, concept, or keyword you want to find.

**What to expect**: A list of files containing your search term, showing:
- File path
- Number of matches
- Preview of matching lines
- Sorted by relevance

---

**`hewtd metadata-sync` - Fix document information**

**How to use it**:
```bash
# Check all documents (preview only)
hewtd metadata-sync

# Fix all missing metadata
hewtd metadata-sync --fix

# Fix only security documents
hewtd metadata-sync --domain security --fix

# Preview exactly what --fix would rewrite, without writing
hewtd metadata-sync --fix --dry-run
```

> [!WARNING]
> `--fix` **writes to every markdown file it finds** under `--path`, stamping the
> full frontmatter block onto each one. That is the intended behavior inside a
> documentation tree and vandalism outside it, so `--fix` refuses to write
> anywhere outside your project's documentation root (see
> [Documentation root](#documentation-root)). Reads and `--dry-run` are
> unrestricted.
>
> Scope it before you run it: `--path` sets the root and `--domain` narrows to
> one folder. `--dry-run` reports what would change and writes nothing.

**When to use it**:
- After manually editing lots of files
- When documents are missing metadata
- As part of regular maintenance

**What to use it on**: The entire `.documentation` folder or specific categories.

**What to expect**:
- Checks every document for complete metadata
- Adds missing information like word count and reading time
- Shows you how many documents were updated
- With `--fix`, it automatically adds missing metadata

---

**`hewtd link-check` - Find broken links**

**How to use it**:
```bash
# Check all documents
hewtd link-check

# Check only API docs
hewtd link-check --domain api

# Generate detailed report
hewtd link-check --report
```

**When to use it**:
- Before releasing a new version
- After moving or renaming files
- Monthly as part of regular maintenance
- When you suspect broken links

**What to use it on**: Your entire documentation or specific categories.

**What to expect**:
- List of all broken links found
- Which file contains each broken link
- What line number the link is on
- Saves detailed report to `.documentation/reports/links-[date].md`

---

**`hewtd audit` - Check quality**

**How to use it**:
```bash
# Audit everything
hewtd audit

# Show only problems
hewtd audit --issues-only

# Audit specific category
hewtd audit --domain database

# Generate full report
hewtd audit --report
```

**When to use it**:
- Establishing a baseline for your docs
- During code reviews
- Before important releases

**What to use it on**: The entire documentation system to measure quality.

**What to expect**:
- Quality score from 0-100
- List of issues:
  - Files in wrong folders
  - Incorrect file names (should be kebab-case)
  - Missing required metadata
  - Empty documents
- Recommendations for fixes

---

**`hewtd report <type>` - Generate reports**

**How to use it**:
```bash
# Health report (overall score and stats)
hewtd report health

# Audit report (quality issues)
hewtd report audit

# Links report (link topology and broken links)
hewtd report links

# JSON format for automation
hewtd report health --format json
```

**When to use it**:
- Weekly metrics for your team
- Dashboards showing documentation health
- Stakeholder updates
- Tracking improvement over time

**What to use it on**: Your documentation system.

**What to expect**: Detailed markdown or JSON report saved to `.documentation/reports/` with:
- Health score and trends
- Statistics (document count, word count, etc.)
- Issues found and severity
- Recommendations for improvement

---

**`hewtd discover` - Find code patterns**

**How to use it**:
```bash
# Find all patterns in your code
hewtd discover patterns

# Find problematic patterns
hewtd discover anti-patterns

# Extract coding standards
hewtd discover standards

# Analyze dependencies
hewtd discover dependencies

# Only scan TypeScript files
hewtd discover patterns --language typescript

# Scan specific folder
hewtd discover patterns --root ./src
```

**When to use it**:
- Creating architecture documentation
- Onboarding new developers
- Documenting coding standards
- Understanding project dependencies

**What to use it on**: Your source code folders (automatically skips node_modules, dist, and other build folders).

**What to expect**:
- Creates markdown files with discovered patterns
- Shows code examples with file locations
- Identifies common architectural patterns (Singleton, Factory, Repository, etc.)
- Lists anti-patterns to avoid
- Documents dependencies and their versions

---

#### Claude Code Commands

When the plugin is installed in Claude Code, these commands let Claude help manage your documentation.

| Command | Description |
|---------|-------------|
| `/docs load <domain>` | Load a specific category of docs so Claude can answer questions about it |
| `/docs list` | Show all 15 documentation categories |
| `/docs search <query>` | Search through all documentation |
| `/docs stats` | Display statistics (health score, doc count, recent updates) |
| `/docs maintain` | Run health check and fix issues |
| `/docs integrate <file>` | Add a document to the documentation system |
| `/discover` | Scan code for patterns and create documentation |

##### Claude Command Examples and Details

**`/docs load <domain>` - Give Claude access to specific docs**

**How to use it**:
```
/docs load security
```

**When to use it**:
- Before asking Claude questions about a specific topic
- When you want Claude to reference your existing documentation
- Before asking Claude to update or create documentation in a category

**What to use it on**: Any of the 15 domain names (security, api, database, testing, etc.).

**What to expect**:
- Claude loads all documents from that category into its context
- Claude can now answer detailed questions about those docs
- Claude can reference specific files and sections
- Claude can suggest improvements or updates

**Example conversation**:
```
You: /docs load security
Claude: I've loaded the security documentation. I can see you have 12 documents covering authentication, authorization, encryption, and security best practices. What would you like to know?

You: How do we handle OAuth tokens?
Claude: Based on your security docs, OAuth tokens are stored in httpOnly cookies and have a 1-hour expiration. The implementation is in security/oauth-implementation.md...
```

---

**`/docs list` - See what documentation exists**

**How to use it**:
```
/docs list
```

**When to use it**: When you want to know what documentation categories are available.

**What to expect**: Claude shows you all 15 categories with descriptions and document counts.

---

**`/docs search <query>` - Find specific information**

**How to use it**:
```
/docs search "authentication flow"
```

**When to use it**:
- Before writing new documentation (check if it already exists)
- When you can't remember where something is documented
- To find all places a topic is mentioned

**What to expect**: Claude shows you which files contain your search term and can read those files for you.

**Example**:
```
You: /docs search "API rate limiting"
Claude: Found "API rate limiting" in 3 files:
1. api/rate-limiting.md (6 matches)
2. security/api-security.md (2 matches)
3. troubleshooting/api-errors.md (1 match)

Would you like me to load these files and explain the rate limiting implementation?
```

---

**`/docs stats` - Check documentation health**

**How to use it**:
```
/docs stats
```

**When to use it**:
- Quick health check before committing
- To see how much documentation exists
- To check recent changes
- Before starting a documentation cleanup session

**What to expect**: Claude shows you:
- Health score (0-100)
- Total number of documents
- Documents by category
- Recently updated files
- Issues found (broken links, missing metadata)

---

**`/docs maintain` - Fix documentation problems**

**How to use it**:
```
/docs maintain
```

**When to use it**:
- Before committing changes
- Weekly maintenance
- After adding lots of new documentation
- When you notice issues

**What to expect**: Claude runs the maintenance system and reports:
- Issues found
- Issues automatically fixed
- Updated health score
- Suggestions for manual fixes

---

**`/docs integrate <file>` - Organize a document**

**How to use it**:
```
/docs integrate ./new-guide.md
```

**When to use it**: When you have a markdown file that needs to be added to the documentation system.

**What to expect**: Claude reads the file, determines the best category, adds metadata, and moves it to the correct location.

---

**`/discover` - Generate docs from code**

**How to use it**:
```
/discover patterns
/discover anti-patterns
/discover standards
/discover dependencies
```

**When to use it**:
- Creating architecture documentation
- Onboarding guides for new developers
- When you need to document existing patterns

**What to expect**: Claude scans your code, identifies patterns, and creates documentation files with code examples.

---

## Common Workflows

### Quick Daily Check (30 seconds)
```bash
# Before committing changes
hewtd maintain --quick
```

### Adding New Documentation (2 minutes)
```bash
# Step 1: Write your doc (use any editor)
vim my-new-guide.md

# Step 2: Add it to the system
hewtd integrate my-new-guide.md

# Step 3: Quick health check
hewtd maintain --quick --fix
```

### Weekly Maintenance (5 minutes)
```bash
# Auto-fix all issues
hewtd maintain --quick --fix

# Review the report
cat .documentation/reports/maintenance-*.md

# Or just look at the health score
hewtd report health
```

### Before Releasing (10 minutes)
```bash
# Step 1: Full check with link validation
hewtd maintain --fix

# Step 2: Generate health report
hewtd report health

# Step 3: Make sure score is above 80
# If not, check the report for issues

# Step 4: Commit changes
git add .documentation
git commit -m "docs: update and fix documentation"
```

### Migrating Existing Docs (30 minutes)
```bash
# Step 1: Create structure
hewtd init

# Step 2: Preview where files will go
for file in old-docs/*.md; do
  hewtd integrate "$file" --dry-run
done

# Step 3: If preview looks good, integrate them all
for file in old-docs/*.md; do
  hewtd integrate "$file" --auto
done

# Step 4: Fix any issues
hewtd maintain --fix

# Step 5: Check results
hewtd report health
```

---

## Technical Details

### Architecture Overview

Hit 'Em With The Docs is built with TypeScript and organized into several core modules:

```
src/
├── cli/                      # Command-line interface
│   └── index.ts             # Main CLI entry point and command definitions
│
├── core/                     # Core business logic
│   ├── audit/               # Quality auditing
│   │   ├── auditor.ts       # Main audit orchestrator
│   │   ├── naming.ts        # File naming convention checks
│   │   └── placement.ts     # Document placement validation
│   │
│   ├── discover/            # Code pattern discovery
│   │   ├── patterns.ts      # Pattern detection (Singleton, Factory, etc.)
│   │   ├── anti-patterns.ts # Anti-pattern detection
│   │   ├── standards.ts     # Coding standard extraction
│   │   └── dependencies.ts  # Dependency analysis
│   │
│   ├── domains/             # Domain classification system
│   │   ├── definitions.ts   # 15 domain definitions with keywords
│   │   ├── classifier.ts    # Smart classification algorithm
│   │   └── loader.ts        # Domain loading and caching
│   │
│   ├── integrate/           # Document integration
│   │   ├── integrator.ts    # Main integration orchestrator
│   │   ├── analyzer.ts      # Content analysis for classification
│   │   └── mover.ts         # File movement and organization
│   │
│   ├── links/               # Link checking and tracking
│   │   ├── checker.ts       # Link validation
│   │   ├── parser.ts        # Markdown link extraction
│   │   ├── resolver.ts      # Relative path resolution
│   │   └── topology.ts      # Link graph and backlinks
│   │
│   ├── maintain/            # Maintenance orchestration
│   │   ├── orchestrator.ts  # Main maintenance coordinator
│   │   ├── health.ts        # Health score calculation
│   │   └── scheduler.ts     # Maintenance scheduling
│   │
│   └── metadata/            # Metadata management
│       ├── sync.ts          # Metadata synchronization
│       ├── validator.ts     # Metadata validation
│       └── generator.ts     # Auto-generation of computed fields
│
├── generators/               # Scaffold and template generation
│   ├── scaffold.ts          # Documentation structure creation
│   └── templates/           # Document templates
│
├── reports/                  # Report generation
│   ├── health.ts            # Health reports
│   ├── audit.ts             # Audit reports
│   ├── links.ts             # Link topology reports
│   └── formatters/          # Output formatters (markdown, JSON)
│
└── utils/                    # Shared utilities
    ├── files.ts             # File system operations
    ├── markdown.ts          # Markdown parsing and manipulation
    └── logger.ts            # Logging and output formatting
```

### Lifecycle enforcement (2.8.0+)

hewtd's policy is now **binding on an agent**, not merely documented. A
`PreToolUse` hook — run by the harness, not the model — **denies** the two
destructive violations: hand-editing a generated `INDEX.md`/`REGISTRY.md` (it is
rebuilt from disk; edits are discarded) and `rm`-ing a doc under
`.documentation/` (use `hewtd archive` — reversible and link-safe). It **warns**,
without blocking, on `status: deprecated` without archiving and on starting a
rival `docs/` folder.

It **fails open**: no `.documentation/` tree, or any internal error, and it allows
everything silently. Both rules are opt-out via an `enforcement` block in
`.claude/hit-em-with-the-docs.json`. A `SessionStart` brief and a model-invocable
skill round it out — no `CLAUDE.md` is written or modified.

**Full reference: [docs/enforcement.md](docs/enforcement.md).**

### Indexing: what counts as a document

`INDEX.md` and `REGISTRY.md` are **generated** — `index`, `maintain`, and
`integrate` rebuild them from disk, so a row you add by hand is overwritten on
the next run.

Domain folders are walked **recursively**, so a document at any depth inside a
domain is indexed (`standards/backend/foo.md` appears in `standards/INDEX.md` as
`backend/foo.md`). Never indexed: the generated `INDEX.md`/`REGISTRY.md`
themselves; anything under `archive/`, `drafts/`, `reports/`, `_templates/`,
`node_modules/`, or a nested `.documentation/`; and the vault's `facts/`,
`incidents/`, and `symptoms/` subtrees, which have their own generators.

Recursive indexing landed in **2.7.1**. Before that the walk was flat and every
document in a subfolder was invisible to the whole system — so the first
`index`/`maintain` run after upgrading will add a row for each one.

**Full contract, and the troubleshooting ladder for "my doc isn't in the index":
[docs/indexing.md](docs/indexing.md).**

### File Structure

When you run `hewtd init`, it creates this structure:

```
.documentation/
├── INDEX.md                  # Main navigation hub (links to all domains)
├── REGISTRY.md               # Complete list of all documents (auto-generated)
├── README.md                 # Getting started guide for contributors
│
├── security/                 # Security documentation (priority: 9)
│   ├── INDEX.md             # Security domain table of contents
│   ├── REGISTRY.md          # Quick reference for security docs
│   ├── *.md                 # Individual security documents
│   └── auth/                # Subfolders are indexed too (2.7.1+)
│       └── *.md             # → listed as auth/<name>.md
│
├── api/                      # API documentation (priority: 8)
│   ├── INDEX.md
│   ├── REGISTRY.md
│   └── *.md
│
├── database/                 # Database documentation (priority: 8)
│   ├── INDEX.md
│   ├── REGISTRY.md
│   └── *.md
│
├── testing/                  # Testing documentation (priority: 7)
├── architecture/             # Architecture docs (priority: 7)
├── standards/                # Coding standards (priority: 10)
├── devops/                   # DevOps/infrastructure (priority: 8)
├── quickstart/               # Onboarding guides (priority: 9)
├── features/                 # Feature docs (priority: 6)
├── procedures/               # Step-by-step procedures (priority: 6)
├── workflows/                # Process documentation (priority: 5)
├── troubleshooting/          # Debug guides (priority: 6)
├── agents/                   # AI agent docs (priority: 5)
├── backups/                  # Backup/recovery (priority: 4)
├── plans/                    # Planning docs (priority: 3)
│
├── archive/                  # Deprecated docs — EXCLUDED from all scans
├── drafts/                   # Work-in-progress
└── reports/                  # Generated reports
    ├── maintenance-YYYYMMDD-HHMMSS.md
    ├── audit-YYYYMMDD-HHMMSS.md
    └── links-YYYYMMDD-HHMMSS.md
```

#### Archived / deprecated docs (`archive/`)

`.documentation/archive/` is the parking lot for retired documentation. hewtd
**excludes the entire `archive/` subtree from every scan** — `audit`,
`link-check`, `metadata-sync`, `integrate` duplicate-detection, the link graph,
and `search`. Archived docs are never validated against the frontmatter schema,
never appear in any INDEX.md/REGISTRY.md, and won't break audit/link-check with
stale frontmatter. `init` scaffolds the folder with a README explaining the
convention. `archive` is a reserved name and cannot be registered as a domain.

##### The archival process (2.7.0+)

The `archive/` folder shipped in 2.6.0 as a passive convention — you moved files
into it by hand. **2.7.0** turns it into an actual workflow: three commands, a
config block, and an audit nudge, all built around two principles. First,
**propose, don't impose** — detection is advisory, a human always executes the
move, and nothing is ever auto-archived. Second, **reversible and link-safe** —
archiving records where a doc came from so restore is lossless, and a link guard
keeps you from silently breaking the active corpus.

There's a deliberate stance baked into how candidates are detected, too. hewtd
**does not** use access-recency (it has no read telemetry) and **does not** treat
age alone as an archive signal. Docs aren't code: an unchanged foundational doc is
often the most important one in the tree, not the most disposable. The only
objective recency signal available is git-last-touched, and even that is advisory
and gated behind "this doc is also orphaned."

**`hewtd archive <file>`** retires a doc. It moves the file into
`archive/<same-domain-subpath>/` (so `api/old.md` lands at `archive/api/old.md`),
stamps lifecycle frontmatter (`status: archived`, `archived_on`, `archived_from`,
and `archived_reason` when you pass a reason), and regenerates the indexes so the
doc cleanly leaves its domain INDEX. It prefers `git mv` to preserve history and
falls back to a plain move when you're not in a git repo.

```bash
# Preview first — moves nothing
hewtd archive api/old-endpoints.md --dry-run

# Retire it, recording why
hewtd archive api/old-endpoints.md -r "Replaced by the v2 endpoint reference"
```

The **link guard** is on by default: if active docs still link to the target,
`archive` refuses and lists each offending link so you can fix them first. Pass
`--force` to archive anyway (those inbound links become dangling):

```bash
hewtd archive api/old-endpoints.md --force
```

**`hewtd unarchive <file>`** is the lossless reverse. It restores the doc to the
path recorded in `archived_from`, sets `status: active`, and strips the
`archived_*` fields. It refuses if the restore target already exists, so it never
clobbers a doc you've since recreated.

```bash
hewtd unarchive archive/api/old-endpoints.md --dry-run
hewtd unarchive archive/api/old-endpoints.md
```

**`hewtd archive-candidates`** is advisory and **read-only** — it never moves
anything. It lists docs that may warrant archiving, each with a score and the
reasons behind it:

```bash
hewtd archive-candidates
hewtd archive-candidates --json
```

The candidate signals, ranked:

1. **`status: deprecated`** — a strong, explicit signal. Qualifies a doc on its
   own.
2. **`superseded_by:` frontmatter** — also strong and explicit. Qualifies alone.
3. **Orphaned** (zero inbound links) — a weaker signal on its own.
4. **Stale** — git-last-touched (or `last_updated` as a fallback when git is
   unavailable) older than `candidate_after_days`. Age **only** contributes when
   the doc is *also* orphaned; it never qualifies a doc by itself.

##### `archive` config block

Tune detection in `.claude/hit-em-with-the-docs.json` under an `archive` key. All
four keys are optional; the defaults are conservative on purpose:

```json
{
  "archive": {
    "honor_status_deprecated": true,
    "candidate_after_days": 365,
    "require_orphaned": true,
    "auto": false
  }
}
```

- `honor_status_deprecated` (default `true`) — treat `status: deprecated` as a
  qualifying candidate signal.
- `candidate_after_days` (default `365`) — the staleness threshold in days.
- `require_orphaned` (default `true`) — gate the age signal behind "also
  orphaned." Set it `false` to let age qualify a doc on its own (not
  recommended).
- `auto` (default `false`) — nothing is ever auto-archived. This is the
  propose-don't-impose default; archiving is always a human decision.

##### Audit nudge: `deprecated-not-archived`

`status: deprecated` and archiving are different steps. Marking a doc
`deprecated` flags intent while keeping it live, indexed, and linkable; archiving
physically retires it. To keep `deprecated` from being a dead-end label, the
auditor now raises an **INFO** issue (`deprecated-not-archived`) for any doc left
at `status: deprecated` in an active domain folder, suggesting
`hewtd archive <file>`. That's what finally makes `status: deprecated`
actionable.

### Domain System

The system organizes documentation into 15 specialized domains with different priorities (1-10 scale, higher = more important):

| Domain | Priority | Category | Description | Keywords |
|--------|----------|----------|-------------|----------|
| `standards` | 10 | development | Coding standards and conventions | standards, conventions, style guide, best practices |
| `security` | 9 | core | Security, authentication, authorization | security, auth, encryption, oauth, jwt, permissions |
| `quickstart` | 9 | features | Setup and onboarding guides | quickstart, setup, installation, getting started |
| `devops` | 8 | core | Deployment and infrastructure | devops, deployment, ci/cd, docker, kubernetes |
| `database` | 8 | core | Database schema and queries | database, schema, sql, migrations, orm |
| `api` | 8 | core | API endpoints and specifications | api, endpoint, rest, graphql, http |
| `testing` | 7 | development | Test strategies and patterns | testing, unit test, integration, e2e |
| `architecture` | 7 | development | System design and patterns | architecture, design, patterns, structure |
| `features` | 6 | features | Feature implementation guides | features, implementation, functionality |
| `procedures` | 6 | features | Step-by-step operations | procedures, steps, operations, how-to |
| `troubleshooting` | 6 | advanced | Debugging guides | troubleshooting, debug, errors, solutions |
| `workflows` | 5 | features | Process documentation | workflows, process, pipelines |
| `agents` | 5 | advanced | AI agent documentation | agents, ai, automation, bots |
| `backups` | 4 | advanced | Backup and recovery | backups, recovery, restore |
| `plans` | 3 | advanced | Planning and roadmaps | plans, roadmap, future, planning |

**Priority System**: Claude Code and other integrations load higher-priority domains first. This ensures critical documentation (like security and API docs) is available before less-critical content.

**Categories**:
- **core**: Essential infrastructure (security, database, APIs, devops)
- **development**: Development practices (testing, standards, architecture)
- **features**: Feature-specific documentation (features, procedures, workflows, quickstart)
- **advanced**: Specialized content (troubleshooting, agents, backups, plans)

#### Custom Domains (2.6.0+)

The 15 domains above are **built-in** — they're part of the compiled contract and are always present. Beyond those, you can register your own **custom domains** at runtime (no recompile) via the `hewtd domain` command. Custom domains are stored in your project's `.claude/hit-em-with-the-docs.json` under a `domains: []` array:

```json
{
  "domains": [
    {
      "id": "ml-pipeline",
      "name": "ML Pipeline",
      "description": "Model training and inference pipeline docs",
      "keywords": ["ml", "model", "training", "inference", "pipeline"],
      "loadPriority": 6,
      "category": "features"
    }
  ]
}
```

Entry fields: `id` (kebab-case; can't collide with a built-in), `name`, `description`, `keywords` (at least one — they drive auto-classification in `hewtd integrate`), `loadPriority` (1-10), and `category` (one of `core`, `development`, `features`, `advanced`). You normally don't hand-edit this file — use the commands below.

**`hewtd domain list`** — list built-in + custom domains, marked by kind:

```bash
hewtd domain list
hewtd domain list --json
```

**`hewtd domain add <id>`** — validate, write the config entry, scaffold `.documentation/<id>/` (with INDEX.md/REGISTRY.md), and refresh the root indexes. Keywords are required.

```bash
# Preview first (writes nothing) — shows the proposed config entry + folder
hewtd domain add ml-pipeline -k "ml,model,training,inference,pipeline" --dry-run

# Apply it
hewtd domain add ml-pipeline \
  -n "ML Pipeline" \
  -d "Model training and inference pipeline docs" \
  -k "ml,model,training,inference,pipeline" \
  -c features \
  --load-priority 6

# Then refresh indexes everywhere
hewtd maintain
```

Guardrails: a built-in id is rejected, duplicate custom ids are rejected, non-kebab-case ids are rejected, empty keywords are rejected, and a bad `category` is rejected.

**`hewtd domain remove <id>`** (alias `rm`) — remove a custom domain from config. This is **non-destructive**: it never deletes the folder or the docs inside it. Any docs in `.documentation/<id>/` simply become *orphaned* (left on disk, no longer a recognized domain), and the command reports how many. Built-in domains cannot be removed.

```bash
# Preview — reports how many docs would be orphaned
hewtd domain remove ml-pipeline --dry-run

# Apply
hewtd domain remove ml-pipeline
```

In Claude Code, the `/hit-em-with-the-docs:domain` slash command wraps these and adds a confirm step before `add` (dry-run preview) and `remove` (orphaned-doc count) apply.

### Metadata Schema

Every document includes YAML frontmatter with up to 22 fields:

#### Required Fields (Must be present)
```yaml
---
title: "Document Title"                    # Human-readable title
tier: guide                                # guide|standard|example|reference|admin
domains: [primary-domain]                  # Which category/categories it belongs to
status: active                             # draft|active|deprecated|archived (extensible)
---
```

#### Auto-Generated Fields (System fills these in)
```yaml
word_count: 1234                          # Calculated from content
estimated_read_time: "5 minutes"          # Based on 200 words/minute
last_validated: '2024-01-15'              # Date of last metadata sync
backlinks: []                             # Generated by link checker
```

#### Optional Fields (You can add these)
```yaml
# Discovery and Organization
purpose: "One-sentence description"        # What this doc is about
tags: [security, auth, api]               # Searchable tags
audience: [developers, devops]            # Who should read this
related_docs: [./other-doc.md]            # Related documentation
keywords: [keyword1, keyword2]            # Search keywords

# Lifecycle Management
last_updated: '2024-01-15'                # When content was last changed
version: '1.0.0'                          # Document version
review_frequency: monthly                 # How often to review (monthly|quarterly|annually)

# Ownership
author: "John Doe"                        # Original author
maintainer: "Platform Team"               # Current maintainer
contributors: ["Jane", "Bob"]             # Additional contributors

# Implementation Tracking
implementation_status: complete           # planned|in_progress|complete
tested: true                              # Whether examples are tested
production_ready: true                    # Ready for production use
load_priority: 8                          # Override default domain priority (1-10)

# Additional Context
prerequisites: ["setup.md", "auth.md"]    # Required reading
difficulty: intermediate                  # beginner|intermediate|advanced
```

### Retrieval fields (2.12.0+)

Write `title`, `purpose`, `symptoms` and `tags` on every doc so search tools
can find it. `hewtd audit` raises advisory `RETRIEVAL_*` warnings for gaps;
they never fail the audit. Generated files carry `generated: true`, and
`INDEX.md` tables have a Purpose column. Config keys in
`.claude/hit-em-with-the-docs.json`: a `retrieval` block (`purpose_min_words`,
`generic_titles`, `oversized_chars`, `oversized_headings`, `near_duplicate`,
`near_duplicate_min_chars`, `disabled`) and `reports_dir` (default
`<docs root>/reports`). `hewtd report health` adds a Retrieval Coverage table.
Full standard, codes and fixes: [docs/retrieval-fields.md](docs/retrieval-fields.md).

### Overview docs (2.13.0+)

A doc with `kind: overview` (start from `templates/overview.template.md`) links
every stage of a cross-cutting flow. `hewtd audit` raises advisory
`OVERVIEW_MISSING` and `OVERVIEW_STALE_LINKS` warnings for flows of
`min_cluster_size` or more docs; they never change the exit code. Config in
`.claude/hit-em-with-the-docs.json`: an `overview` block (`min_cluster_size` 5,
`min_link_coverage` 0.6, `backlinks` true, `disabled` []). `hewtd report
health` shows overview coverage. **`hewtd maintain --fix` now edits doc
bodies**, adding `Part of: [Title](...)` back-links to cluster members; set
`overview.backlinks` to `false` to turn it off.

### Documentation root

`docs_root` in `.claude/hit-em-with-the-docs.json` declares where this project's
documentation lives. It defaults to `.documentation`, so most projects never set it:

```json
{
  "docs_root": "mydocs"
}
```

This is the single source of truth for the question, and commands that **write**
consult it. `metadata-sync --fix` stamps frontmatter into every markdown file it
finds, so before writing it confirms the target is the declared root or inside it;
otherwise it refuses. Pointed at a source tree, `--fix` would otherwise rewrite
hundreds of files that are not documentation.

The check is deliberately a *declaration* rather than a guess. An earlier cut asked
"does this directory look like a docs tree?" by testing for domain-named folders —
which any repository with a top-level `api/` or `testing/` satisfies by accident.
Nothing satisfies a declaration by accident.

A tree scaffolded somewhere other than the declared root still works: `hewtd init -p
docs` writes `docs/INDEX.md`, and a root `INDEX.md` is accepted as a positive marker
because hewtd is what writes it.

### Custom Status Vocabulary

`status` is validated against a vocabulary. Four values are **built-in** and always
valid: `draft`, `active`, `deprecated`, `archived`.

A project that has adopted its own lifecycle words can declare them in
`.claude/hit-em-with-the-docs.json` under a `status: []` array:

```json
{
  "status": ["complete", "current", "in_progress"]
}
```

Those values then pass validation in `integrate`, `audit`, and `metadata-sync`, and
`hewtd init` scaffolds the full vocabulary into the generated metadata guide.

The list is **additive — it extends the built-ins, it cannot replace them.** That is
deliberate: the built-ins are load-bearing, not a style preference. `hewtd archive`
writes `status: archived`, `hewtd unarchive` writes `status: active`, the deprecation
nudge in `audit` keys on `status: deprecated`, and every generated `INDEX.md` /
`REGISTRY.md` is emitted with `status: active`. A replace-mode config would let a
project invalidate hewtd's own output with its own settings.

Values must be lowercase, separated by `-` or `_`. A malformed entry is dropped with
the rest of the config still loading — the config loader never throws. A status
outside the active vocabulary is still rejected, and the error names both the active
set and the file to declare more in:

```
status must be one of draft|active|deprecated|archived|complete|current for
non-lifecycle-tracked tiers (declare extra values in
.claude/hit-em-with-the-docs.json "status")
```

> [!NOTE]
> `status` and `implementation_status` are different fields with different
> vocabularies. `complete` is a built-in *`implementation_status`* value
> (`planned|in_progress|complete|deprecated`) and is a common source of drift onto
> `status`. If you want `complete` on `status`, declare it — the two fields do not
> share a vocabulary.

**Lifecycle-tracked tiers are unaffected.** `plan`, `fact`, `incident-narrative`, and
`incident-facts` carry their own per-tier status enums and never consult this
vocabulary.

### Classification Algorithm

The domain classifier uses a sophisticated keyword-based scoring system with fuzzy matching:

#### Step 1: Content Extraction
```typescript
// src/core/domains/classifier.ts
function extractKeywords(document: Document): string[] {
  // Extract from title (weighted 3x)
  const titleWords = tokenize(document.title);

  // Extract from content (weighted 1x)
  const contentWords = tokenize(document.content);

  // Remove stop words (the, and, or, etc.)
  return removeStopWords([...titleWords, ...contentWords]);
}
```

#### Step 2: Domain Scoring
```typescript
function scoreDomain(keywords: string[], domain: Domain): number {
  let score = 0;

  for (const keyword of keywords) {
    for (const domainKeyword of domain.keywords) {
      // Exact match: +10 points
      if (keyword === domainKeyword) {
        score += 10;
      }
      // Fuzzy match (Levenshtein distance < 3): +5 points
      else if (levenshteinDistance(keyword, domainKeyword) < 3) {
        score += 5;
      }
    }
  }

  return score;
}
```

#### Step 3: Confidence Calculation
```typescript
function calculateConfidence(scores: Map<Domain, number>): Confidence {
  const topScore = Math.max(...scores.values());
  const totalScore = Array.from(scores.values()).reduce((a, b) => a + b, 0);

  // Confidence = (top score / total score) * 100
  const confidence = (topScore / totalScore) * 100;

  return {
    topDomain: getTopDomain(scores),
    confidence: Math.round(confidence),
    suggestions: getTopN(scores, 3) // Top 3 suggestions
  };
}
```

**Example**:
```
Document title: "OAuth 2.0 Authentication Guide"
Keywords extracted: [oauth, authentication, guide, security, token]

Scoring:
- security domain: oauth(10) + authentication(10) + security(10) = 30
- api domain: oauth(5) + authentication(5) = 10
- quickstart domain: guide(10) = 10

Top domain: security (60% confidence)
Suggestions: [security, api, quickstart]
```

### Link Tracking System

The link checker maintains a complete topology of your documentation:

#### Link Extraction
```typescript
// src/core/links/parser.ts
function extractLinks(markdown: string): Link[] {
  // Matches: [text](./path.md) and [text](./path.md#anchor)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;

  const links: Link[] = [];
  let match;

  while ((match = linkRegex.exec(markdown)) !== null) {
    links.push({
      text: match[1],      // Link text
      target: match[2],    // Link target
      line: getLineNumber(markdown, match.index)
    });
  }

  return links;
}
```

#### Link Resolution
```typescript
// src/core/links/resolver.ts
function resolveLink(sourceFile: string, target: string): ResolvedLink {
  // Handle relative paths
  if (target.startsWith('./') || target.startsWith('../')) {
    const absolute = path.resolve(path.dirname(sourceFile), target);

    // Remove anchor
    const [filePath, anchor] = absolute.split('#');

    return {
      sourceFile,
      targetFile: filePath,
      anchor,
      exists: fs.existsSync(filePath)
    };
  }

  // Handle absolute paths within .documentation
  if (target.startsWith('/')) {
    const absolute = path.join(DOCS_ROOT, target);
    return { /* ... */ };
  }

  // External links (http://, https://)
  return { isExternal: true, target };
}
```

#### Topology Building
```typescript
// src/core/links/topology.ts
interface LinkTopology {
  forward: Map<string, string[]>;   // file -> [linked files]
  backward: Map<string, string[]>;  // file -> [files that link to it]
  broken: BrokenLink[];             // List of broken links
  orphaned: string[];               // Files with no incoming links
}

function buildTopology(documents: Document[]): LinkTopology {
  const topology: LinkTopology = {
    forward: new Map(),
    backward: new Map(),
    broken: [],
    orphaned: []
  };

  // Build forward links
  for (const doc of documents) {
    const links = extractLinks(doc.content);
    const resolved = links.map(link => resolveLink(doc.path, link.target));

    topology.forward.set(doc.path, resolved.map(r => r.targetFile));

    // Track broken links
    for (const link of resolved) {
      if (!link.exists) {
        topology.broken.push({ source: doc.path, target: link.target });
      }
    }
  }

  // Build backward links (backlinks)
  for (const [source, targets] of topology.forward) {
    for (const target of targets) {
      if (!topology.backward.has(target)) {
        topology.backward.set(target, []);
      }
      topology.backward.get(target)!.push(source);
    }
  }

  // Find orphaned documents
  for (const doc of documents) {
    if (!topology.backward.has(doc.path)) {
      topology.orphaned.push(doc.path);
    }
  }

  return topology;
}
```

### Maintenance Orchestration

The maintenance system coordinates multiple checks and generates a comprehensive health score:

```typescript
// src/core/maintain/orchestrator.ts
async function runMaintenance(options: MaintenanceOptions): Promise<MaintenanceReport> {
  const report: MaintenanceReport = {
    timestamp: new Date(),
    healthScore: 0,
    issues: [],
    fixed: [],
    statistics: {}
  };

  // Step 1: Metadata Sync (40% of health score)
  console.log('Step 1: Metadata Sync');
  const metadataResults = await syncMetadata(options);
  report.statistics.metadataCompliance = metadataResults.compliance;
  report.healthScore += metadataResults.compliance * 0.4;

  // Step 2: Link Check (30% of health score) - optional in quick mode
  if (!options.quick) {
    console.log('Step 2: Link Check');
    const linkResults = await checkLinks(options);
    report.statistics.linkHealth = linkResults.health;
    report.healthScore += linkResults.health * 0.3;
    report.statistics.brokenLinks = linkResults.broken.length;
  }

  // Step 3: Audit (30% of health score)
  console.log('Step 3: Audit');
  const auditResults = await runAudit(options);
  const namingScore = auditResults.namingCompliance;
  const placementScore = auditResults.placementAccuracy;
  report.statistics.namingCompliance = namingScore;
  report.statistics.placementAccuracy = placementScore;
  report.healthScore += (namingScore * 0.2) + (placementScore * 0.1);

  // Step 4: Generate Report
  console.log('Step 4: Generate Report');
  await writeReport(report, options);

  return report;
}
```

**Health Score Breakdown**:
- **Metadata Completeness (40%)**: How many required fields are filled in
- **Link Health (30%)**: Percentage of valid links (skipped in quick mode)
- **Naming Compliance (20%)**: Files following kebab-case convention
- **Placement Accuracy (10%)**: Files in correct domains

**Target Scores**:
- 90-100: Excellent (production-ready)
- 80-89: Good (acceptable for production)
- 70-79: Fair (needs improvement)
- Below 70: Poor (requires immediate attention)

### GitHub Action Integration

The GitHub Action wraps the CLI for automated checks:

```yaml
# .github/workflows/docs-check.yml
name: Documentation Health

on:
  push:
    paths:
      - '.documentation/**'
  pull_request:
    paths:
      - '.documentation/**'
  schedule:
    - cron: '0 16 * * 5'  # Every Friday at 4 PM UTC

jobs:
  docs-health:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check Documentation
        uses: TheGlitchKing/hit-em-with-the-docs@v2
        with:
          command: maintain           # Command to run
          mode: quick                 # quick|full|fix
          docs-path: .documentation   # Path to docs
          fail-on-error: true         # Fail if issues found
          fail-threshold: 80          # Minimum health score

      - name: Upload Report
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: docs-report
          path: .documentation/reports/
```

**Available Inputs**:
- `command`: CLI command (maintain, audit, link-check, report)
- `mode`: Execution mode (quick, full, fix)
- `docs-path`: Path to documentation folder (default: .documentation)
- `domain`: Filter by specific domain
- `fail-on-error`: Whether to fail if issues found (default: false)
- `fail-threshold`: Minimum health score to pass (0-100)

**Outputs**:
- `health-score`: Overall quality score (0-100)
- `total-documents`: Number of documents found
- `issues-found`: Number of problems detected
- `issues-fixed`: Number of auto-fixed issues (only in fix mode)
- `broken-links`: Number of broken links
- `metadata-compliance`: Metadata completeness percentage
- `report-path`: Path to generated report

### Edge Cases and Handling

#### Duplicate Documents
```typescript
// Detected during integration
if (documentExists(targetPath)) {
  if (options.force) {
    // Overwrite existing
    overwriteDocument(targetPath, document);
  } else {
    // Prompt user
    const action = await prompt('Document exists. Merge or keep separate?');
    if (action === 'merge') {
      mergeDocuments(existing, document);
    }
  }
}
```

#### Missing Metadata
```typescript
// Auto-generate with defaults
const metadata = {
  title: inferTitleFromContent(document),
  tier: 'guide',  // Default tier
  domains: [classifyDomain(document)],
  status: 'draft',  // Default status
  word_count: countWords(document),
  estimated_read_time: calculateReadTime(document),
  last_validated: new Date().toISOString()
};
```

#### Circular Links
```typescript
// Not flagged as errors (useful for navigation)
function detectCircularLinks(topology: LinkTopology): CircularPath[] {
  const circles = [];

  for (const [source, targets] of topology.forward) {
    for (const target of targets) {
      if (topology.forward.get(target)?.includes(source)) {
        circles.push({ from: source, to: target, type: 'bidirectional' });
      }
    }
  }

  // Log for information only
  console.log(`Found ${circles.length} bidirectional links (not an error)`);
  return circles;
}
```

#### Large Files
```typescript
// Warn about oversized documents
const MAX_SIZE = 50_000; // 50 KB

if (document.size > MAX_SIZE) {
  console.warn(`⚠️ ${document.path} is ${formatSize(document.size)}`);
  console.warn('   Consider splitting into multiple documents');
  issues.push({
    type: 'oversized',
    file: document.path,
    size: document.size,
    suggestion: 'Split into smaller documents'
  });
}
```

#### Empty Documents
```typescript
// Flag in audit, exclude from health score
if (document.content.trim().length === 0) {
  issues.push({
    type: 'empty',
    file: document.path,
    severity: 'warning',
    suggestion: 'Add content or remove file'
  });

  // Don't include in health score calculation
  excludeFromHealthScore(document);
}
```

### Configuration

Create `.hewtd.config.json` in your project root for customization:

```json
{
  "docsPath": ".documentation",

  "domains": {
    "custom-domain": {
      "description": "Custom domain for specific docs",
      "keywords": ["custom", "specific", "domain"],
      "loadPriority": 5,
      "category": "features"
    }
  },

  "metadata": {
    "requiredFields": ["title", "tier", "domains", "status"],
    "autoGenerate": ["word_count", "estimated_read_time", "last_validated"],
    "customFields": {
      "team": { "type": "string", "description": "Owning team" },
      "jira_ticket": { "type": "string", "pattern": "^[A-Z]+-\\d+$" }
    }
  },

  "audit": {
    "namingConvention": "kebab-case",
    "maxFileSize": 50000,
    "allowedTiers": ["guide", "standard", "example", "reference", "admin"],
    "requiredDomains": ["security", "api", "testing"]
  },

  "discover": {
    "excludePaths": ["node_modules", "dist", "build", "vendor", ".git"],
    "languages": ["typescript", "javascript", "python", "go", "java"],
    "patterns": {
      "enabled": true,
      "minOccurrences": 2
    },
    "antiPatterns": {
      "enabled": true,
      "severity": "warning"
    }
  },

  "links": {
    "checkExternal": false,
    "ignorePatterns": ["http://localhost", "*.example.com", "*.test"],
    "allowedProtocols": ["http", "https", "mailto"],
    "checkAnchors": true
  },

  "reports": {
    "outputPath": ".documentation/reports",
    "format": "markdown",
    "includeTimestamp": true,
    "retention": {
      "days": 90,
      "maxReports": 50
    }
  },

  "maintenance": {
    "autoFix": true,
    "quickMode": {
      "skipLinkCheck": true,
      "skipExternalLinks": true
    },
    "schedule": {
      "daily": "0 9 * * *",    // 9 AM daily
      "weekly": "0 16 * * 5"   // 4 PM Friday
    }
  }
}
```

### Performance Considerations

#### Large Repositories
- **Streaming**: Files read in chunks, not loaded entirely into memory
- **Parallel Processing**: Uses worker threads for document processing
- **Concurrency Limits**: Configurable max concurrent operations
- **Quick Mode**: Skips expensive operations (link checking) for speed
- **Caching**: Metadata cached during operations, invalidated on changes

#### Memory Usage
- **Incremental Processing**: Documents processed one at a time
- **Link Topology**: Built incrementally to avoid loading all links at once
- **Report Streaming**: Large reports streamed to disk instead of buffered
- **Garbage Collection**: Explicit cleanup after major operations

#### CI/CD Optimization
```yaml
# Fast checks (30-60 seconds)
- name: Quick Check
  run: hewtd maintain --quick

# Thorough checks (2-5 minutes) - scheduled only
- name: Full Check
  if: github.event.schedule
  run: hewtd maintain --fix

# Conditional failure
- name: Check with Threshold
  run: hewtd maintain --fail-threshold 70
```

**Recommended Strategies**:
- **PR Checks**: Use `--quick` mode (fast, catches most issues)
- **Daily Scheduled**: Use full mode with `--fix` (thorough)
- **Release Checks**: Use full mode with strict threshold (80+)
- **Use fail-threshold**: Allow gradual improvement (start at 60, increase over time)

---

## Requirements

- **Node.js**: Version 20.0.0 or higher
- **npm**: Version 8.0.0 or higher (comes with Node.js)
- **Operating System**: Linux, macOS, or Windows (with WSL2)
- **Git**: Version 2.0+ (for GitHub Action)

---

## Troubleshooting

### Installation Issues

**Problem**: `npm install` fails with permission errors

**Solution**:
```bash
# Don't use sudo! Instead, fix npm permissions:
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc

# Now install again
npm install -g @theglitchking/hit-em-with-the-docs
```

**Problem**: `hewtd: command not found` after installation

**Solution**:
```bash
# Check if npm bin is in your PATH
npm config get prefix

# Add it to your PATH
export PATH="$(npm config get prefix)/bin:$PATH"

# Add to your shell profile (~/.bashrc or ~/.zshrc)
echo 'export PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.bashrc
```

### Usage Issues

**Problem**: "No .documentation folder found"

**Solution**: Run `hewtd init` to create the structure first

**Problem**: Health score is very low (below 50)

**Solution**:
```bash
# Auto-fix as much as possible
hewtd maintain --fix

# Check the report for remaining issues
cat .documentation/reports/maintenance-*.md

# Common issues:
# - Missing metadata: hewtd metadata-sync --fix
# - Broken links: hewtd link-check and fix manually
# - Wrong file names: Rename to kebab-case (my-file.md)
```

**Problem**: `hewtd integrate` doesn't put file in the right category

**Solution**:
```bash
# Don't use --auto, let it ask you
hewtd integrate ./my-file.md

# Or move it manually after integration
mv .documentation/wrong-domain/file.md .documentation/right-domain/
```

---

## Migration from v1.x to v2.0

If you're upgrading from the old unscoped package, see [MIGRATION.md](./MIGRATION.md) for detailed instructions.

**Quick Migration Steps**:
```bash
# Uninstall old version
npm uninstall -g hit-em-with-the-docs

# Install new scoped version
npm install -g @theglitchking/hit-em-with-the-docs

# Verify
hewtd --version  # Should show 2.0.0 or higher

# Everything else works the same!
```

---

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for:
- Setting up development environment
- Running tests
- Code style guidelines
- Submitting pull requests

---

## License

MIT License - see [LICENSE](./LICENSE) file for details.

---

## Support

- **GitHub Issues**: [Report bugs or request features](https://github.com/TheGlitchKing/hit-em-with-the-docs/issues)
- **GitHub Discussions**: [Ask questions or share ideas](https://github.com/TheGlitchKing/hit-em-with-the-docs/discussions)
- **NPM Package**: [@theglitchking/hit-em-with-the-docs](https://www.npmjs.com/package/@theglitchking/hit-em-with-the-docs)
- **Changelog**: [View version history](https://github.com/TheGlitchKing/hit-em-with-the-docs/releases)

---

**Made with ❤️ by TheGlitchKing**

[NPM](https://www.npmjs.com/package/@theglitchking/hit-em-with-the-docs) | [GitHub](https://github.com/TheGlitchKing/hit-em-with-the-docs) | [Issues](https://github.com/TheGlitchKing/hit-em-with-the-docs/issues)
