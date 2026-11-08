# Naming standard

One naming standard for the TypeScript code in `src/` (and the tests that import it): snake_case identifiers, one name per concept, one meaning per verb, full words. It exists so a reader can predict a name without opening the file, and so a search for a concept finds every use.

The standard changes names in code only. It never changes a serialized or external name (see "What never changes").

The per-folder renames that apply this standard live in the plan, not here; this page is the rule they follow. The short form agents load every session is `.claude/rules/naming.md`.

## Casing

| Kind | Style | Example |
|---|---|---|
| Functions, methods, parameters, local variables | `snake_case` | `find_git_top`, `docs_root` |
| Module-level non-constant bindings | `snake_case` | `plugin_config_schema`, `logger` |
| Internal object properties (never serialized) | `snake_case` | `{ docs_root, repo_root }` |
| Classes, interfaces, type aliases, enums, enum members | `PascalCase` | `LedgerEntry`, `GraphVerdict` |
| Module-level constants | `UPPER_SNAKE_CASE` | `ARCHIVE_DIR`, `DEFAULT_DOCS_ROOT` |
| Files and folders | kebab-case (unchanged) | `fix-legacy-layout.ts` |

Acronyms are words: `parse_json`, `load_yaml`, `is_url`, never `parseJSON`. Zod schemas are module-level bindings, so `plugin_config_schema`; the keys inside them are serialized names and keep their spelling.

## What never changes

A name that is written to disk, printed for another program, or owned by a library keeps its current spelling, even when it is camelCase or abbreviated:

- CLI `--json` output keys.
- Everything under `.hewtd/`: the ledger, graph, caches, reports, and the entries in review JSON files.
- Plugin config keys, and the keys of every zod schema that validates them.
- Frontmatter keys.
- The `gaps` and `graph` JSON schemas (`schemas/`).
- Commander option keys (`opts.docsPath` as commander delivers it) and command names.
- Any object passed to or returned by a third-party library, and the library's own method names.
- User-visible text: log lines, error messages, report headings.

When it is unclear whether a property is serialized, keep it and record it in the plan notes. Renaming it later is cheap; breaking a stored file is not.

Types stay PascalCase even when their fields are serialized: only the field spellings are frozen, not the type name.

## Short names and abbreviations

- A single letter is allowed only as a loop index (`i`, `j`) and as the two parameters of a sort comparator (`a`, `b`).
- Every other parameter, callback parameter and local is a word. Name a callback parameter by the singular of what it iterates: `docs.map((doc) => ...)`, `files.filter((file) => ...)`, `matches.map((match) => ...)`.
- Allowed abbreviations: `id`, `url`, `json`, `yaml`, `sql`, `regex`, `max`, `min`, `index`, `dir`. Anything else is spelled out: `config` not `cfg`, `options` not `opts`, `frontmatter` not `fm`, `knowledge_base` not `kb`, `error` not `err`, `reference` not `ref`, `working_dir` not `cwd`, `extension` not `ext`, `message` not `msg`, `source` not `src`, `environment` not `env`, `package_info` not `pkg` (`package` is reserved).
- Names of imported modules and library symbols keep the library's spelling (`fs`, `path`).
- Do not shorten to dodge a collision. If two things want one name, one of them is the wrong concept: give both their qualified glossary names.

## Glossary

One canonical name per concept. When a concept needs a qualifier (which report, which config section), the qualifier comes first and the concept name last: `secrets_config`, `ledger_entry`, `review_entry`.

| Concept | Canonical name | Never | Example |
|---|---|---|---|
| The repository root the user ran the command in (holds `package.json`, `.hewtd/`) | `repo_root` | `projectRoot`, `root`, `repoRoot`, `workingDir`, `projectRootDir` | `find_stale_docs(repo_root)` |
| The git top-level directory of the repo that holds the docs (`git rev-parse --show-toplevel`); name it only where it can differ from `repo_root` (nested docs repo, monorepo) | `git_top` | `top`, `gitRoot`, `repoRoot` (in git helpers) | `const git_top = find_git_top(docs_root) ?? repo_root` |
| The absolute docs folder (`.documentation` by default) | `docs_root` | `docsPath`, `docsDir`, `docsRoot`, `rootPath` (docs sense), `docsAbs` | `load_ledger(docs_root)` |
| The semantic vault root | `vault_root` | `vaultRoot`, `vaultPath`, `vaultAbs` | `resolve_vault_root(config)` |
| A doc's path relative to `docs_root`, posix separators | `doc_path` | `rel`, `docRel`, `relPath`, `relFile`, `docPath` (absolute) | `domain/guide.md` |
| A path relative to `git_top` (or `repo_root` when they match), posix separators | `repo_path` | `rel`, `repoRel`, `relOf` | `.documentation/domain/guide.md` |
| The docs folder expressed as a `repo_path` | `docs_repo_path` | `docsRel`, `docsRelPath` | `.documentation` |
| Any absolute path; qualify when more than one is in scope | `abs_path`, `<thing>_abs_path` | `abs`, `fileAbs`, `ownerAbs`, `fromAbs`, `toAbs` | `file_abs_path` |
| A path whose base is not yet decided, only inside a function that resolves it | `file_path` | `filePath` used for relative paths | |
| Plugin configuration object (`PluginConfig`) | `config` | `cfg`, `conf`, `pluginCfg` | `config.reconcile.secrets` |
| A config section | `<section>_config` | `secretsCfg`, `retrievalCfg`, `cfg` | `secrets_config`, `retrieval_config`, `overview_config` |
| Function options bag | `options`; qualified `<verb>_options` when two are in scope | `opts`, `o`, `citeOpts`, `integrateOpts` | `cite_options` |
| The ledger (`.hewtd/ledger.json` contents) | `ledger` | `led` | |
| One ledger record | `ledger_entry` | `led`, `rec`, `entry` (unqualified) | |
| One reviewer-written review record | `review_entry` | `rev`, `o`, `entry` | |
| One line of a generated report | `report_entry` | `entry` | |
| A related repository declared in config (`related_repos`) | `sibling_repo` (list: `sibling_repos`) | `sib`, `sibs`, `related`, `relatedRoots`, `repo` | |
| Frontmatter object / raw frontmatter text | `frontmatter` / `frontmatter_text` | `fm`, `fmLines`, `data` (for frontmatter) | |
| A thing being considered for action (archive, keep) | `candidate` (list: `candidates`) | `cand`, `cands` | |
| A secret or personal-data hit | `finding` (list: `findings`) | `hit`, `f`, `r.finding` as `r` | |
| A thing pointing at another doc or symbol | `reference` (list: `references`) | `ref`, `refs` | |
| A search or regex match | `match` (list: `matches`) | `hit`, `hits`, `m` | |
| A function's outcome object | `<thing>_result` (bare `result` only when the function returns a `*Result` of its own name) | `res`, `out`, `r` | `audit_result` |
| A scratch list that becomes the return value | `found`, `lines`, `parts` (what it holds) | `out`, `acc` | |
| Raw unparsed text | `raw_text` | `raw`, `str`, `s` | |
| A shell or git working directory | `working_dir` | `cwd` | `run_git(working_dir, args)` |
| A heading's slug | `anchor` | `slug` for anchors, `id` | |
| An error value | `error` | `err`, `e`, `ex` | |
| A file extension | `extension` | `ext` | |
| Today's date string | `today` | `now` for a date | |

Use the TypeScript type as the tiebreaker: a `RelatedRepo` is a `sibling_repo`, a `SecretFinding` is a `finding`.

## Verb list

The first word of every function names what it does. Each verb has one meaning; a function that does not fit any verb is probably two functions. Pick the verb by what the function does, not by what is nearby.

### Getting things

| Verb | Meaning | Not |
|---|---|---|
| `get_` | Return something already in memory or derivable from arguments. No I/O. | `retrieve_`, `obtain_`, anything that touches disk |
| `load_` | Read from disk and parse into a value. | `read_` for parsed data, `open_` |
| `read_` | Return raw file text, unparsed. | `slurp_` |
| `fetch_` | Network request. Reserved: nothing in `src/` uses it today. | |
| `find_` | Search; returns the match, or `undefined`/null/empty when there is none. | `lookup_`, `locate_`, `suggest_`, `pick_` |
| `list_` | Enumerate entries of a directory, glob or collection. | `walk_`, `collect_`, `all_` |
| `scan_` | Walk text or files looking for matches, returning what it saw. | `analyze_`, `sweep_` |
| `detect_` | Infer a category or property from signals; may return undefined when unsure. | `guess_`, `infer_` |
| `count_` | Return a number of things. | `size_`, `tally_` |
| `extract_` | Pull a part out of text or a structure (pure). | `collect_`, `pull_`, `derive_` |
| `resolve_` | Map a reference to the thing it points at, or compute a canonical location (a path, link, import, repo). | `locate_`, `to_` |
| `parse_` | Text to structure. | `tokenize_`, `split_`, `decode_` |

### Making things

| Verb | Meaning | Not |
|---|---|---|
| `build_` | Assemble a value in memory from parts. | `make_`, `construct_`, `compose_`, `record_`, `seed_`, `plan_` |
| `generate_` | Produce file content, usually from a template, and return it. | `emit_`, `gen_` |
| `render_` | Structure to a multi-line block of text (markdown, report, index). | `stringify_`, `serialize_` |
| `format_` | One value to a short display string. | `fmt_`, `humanize_`, `pad_`, `stamp_` |
| `compute_` | A number or derived value from inputs (pure). | `calculate_`, `calc_`, `measure_` |
| `normalize_` | Clean a value into its canonical text form; same type in and out. | `clean_`, `canonicalize_` |
| `escape_` | Escape text for a target syntax. | |
| `classify_` | Pick one value from a closed set. | |
| `with_` | Return a modified copy, never mutating the input. | `set_` on pure functions, `update_`, `rewrite_`, `patch_` |
| `merge_` | Combine two structures into a new one. | |
| `group_` | Partition a collection into keyed buckets. | |
| `sort_` | Return a deterministically ordered copy. | |
| `compare_` | A comparator returning a number. | `cmp_` |
| `strip_` | Remove a part from text (pure). | `remove_` on text |
| `refine_` | A zod refinement callback. | |

### Touching disk

| Verb | Meaning | Not |
|---|---|---|
| `write_` | Put content on disk (a file's whole content). | `save_`, `store_`, `dump_`, `persist_` |
| `create_` | Make a new file, directory or resource on disk. | `mk_`, `init_` |
| `add_` | Insert an entry into a collection or a config (may write). | `push_`, `append_`, `record_`, `register_` |
| `remove_` | Delete an entry or a file. | `rm_`, `delete_`, `drop_` |
| `move_` | Relocate a file or entry. | |
| `ensure_` | Make a condition true, writing only if it is not already; idempotent. | `maybe_`, `init_` |
| `reset_` | Clear module state (tests, reload). | |

### Checking

| Verb | Meaning | Not |
|---|---|---|
| `is_`, `has_`, `can_` | Return a boolean and nothing else. | `looks_like_`, `needs_`, `matches_`, `in_`, `exists`, `ok` |
| `check_` | Return a result or a list of issues; never throws for bad input. | `audit_`, `analyze_`, `evaluate_`, `verify_`, `inspect_` |
| `validate_` | Throw, or return errors, against a schema or a rule. | `assert_` |

### Commands and jobs

These name a CLI command or a hook action; a function with the verb implements that command.

| Verb | Meaning |
|---|---|
| `run_` | Execute an external process or a whole job (`run_git`, `run_maintenance`). |
| `discover_` | Repo-wide mining that returns a report (`discover_patterns`). |
| `apply_` | Carry out reviewed decisions on disk. |
| `sync_` | Bring files into agreement with another source. |
| `integrate_`, `migrate_`, `archive_`, `unarchive_`, `fix_`, `regenerate_`, `rollback_`, `triage_`, `install_`, `uninstall_`, `export_` | The command of that name. |

### Rules of use

- `get_` never does I/O. If it reads disk or runs git, it is `load_`, `find_` or `list_`.
- `is_`/`has_`/`can_` return a boolean and do nothing else.
- `generate_` returns content; if it also puts it on disk, it is `write_`. A function that only writes is `write_`.
- `render_` takes a structure and returns a block; `format_` takes one value and returns a short string.
- A nested helper follows the same list. A tiny closure inside a function still starts with a verb (`add_finding`, `find_root`).
- Logger methods are named for the log level they print (`debug`, `info`, `warn`, `error`, `success`, `header`, `subheader`, `list`, `table`, `progress`, `newline`, `configure`). This is the one place a function may start with a non-verb.

## Applying it

Renames are made through the TypeScript language service (find-rename-locations), never by regex, so only compiler-resolved references change and strings, comments and serialized keys are left alone. A rename that would collide with a name already in scope is not forced: the colliding concept is given its qualified glossary name instead.

New code follows this page from the start. Tooling that enforces it runs locally only (`npm run lint:naming`) and is not part of CI.
