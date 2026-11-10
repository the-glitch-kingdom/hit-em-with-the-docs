# Contributing to hit-em-with-the-docs

Thank you for your interest in contributing to hit-em-with-the-docs! This document provides guidelines and information for contributors.

## Development Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/hit-em-with-the-docs.git
   cd hit-em-with-the-docs
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

4. Run tests:
   ```bash
   npm test
   ```

## Project Structure

```
hit-em-with-the-docs/
├── src/
│   ├── action/           # GitHub Action entry point
│   ├── cli/              # CLI commands
│   ├── core/             # Core business logic
│   │   ├── metadata/     # Metadata handling
│   │   ├── links/        # Link checking
│   │   ├── audit/        # Auditing
│   │   ├── integrate/    # Document integration
│   │   ├── maintain/     # Maintenance orchestrator
│   │   ├── discover/     # Pattern discovery
│   │   └── domains/      # Domain definitions
│   ├── generators/       # Template generators
│   ├── reports/          # Report generation
│   └── utils/            # Utilities
├── templates/            # Static templates
├── tests/                # Test files
│   ├── unit/
│   ├── integration/
│   └── fixtures/
└── examples/             # Example workflows
```

## Making Changes

1. Create a new branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes following our coding standards:
   - Use TypeScript strict mode
   - Follow existing code patterns
   - Add tests for new functionality
   - Update documentation as needed

3. Run tests and linting:
   ```bash
   npm test
   npm run lint
   ```

4. Commit your changes:
   ```bash
   git commit -m "feat: add your feature description"
   ```

   We use [Conventional Commits](https://www.conventionalcommits.org/) format:
   - `feat:` for new features
   - `fix:` for bug fixes
   - `docs:` for documentation changes
   - `test:` for test changes
   - `refactor:` for code refactoring

5. Push and create a pull request:
   ```bash
   git push origin feature/your-feature-name
   ```

## Testing

- Unit tests are in `tests/unit/`
- Integration tests are in `tests/integration/`
- Test fixtures are in `tests/fixtures/`

Run all tests:
```bash
npm test
```

`tests/unit/help-drift.test.ts` reads the commander program (`src/cli/index.ts`, imported with
`HEWTD_NO_PARSE=1` so it does not parse argv) and the zod `plugin_config_schema`; it needs no
`dist/`. It fails when a CLI command or alias is missing from `commands/help.md`, when a
command-specific flag is in neither `commands/<command>.md` nor near the command's name in some doc,
or when a config key path is in no doc. When it fails, document the missing command, flag or key
(or remove the stale one) and rerun. Importing `src/cli/index.ts` elsewhere needs the same
`HEWTD_NO_PARSE=1`.

CI runs the suite as a 2 Node (20.x, 22.x) x 3 shard matrix (`vitest run --shard=n/3`). Each job
builds once and sets `HEWTD_TEST_PREBUILT=1`, so `tests/global-setup.ts` skips its own rebuild.
Set it yourself only after running `npm run build`; without it the setup rebuilds `dist/`.
Lint runs on shard 1 only; the Build step (`tsc`) is the type check.

Run tests with coverage:
```bash
npm run test:coverage
```

## Adding New Domains

To add a new documentation domain:

1. Add the domain to `src/core/domains/constants.ts`:
   ```typescript
   export const DOMAINS = [
     // ... existing domains
     'your-domain',
   ] as const;

   export const DOMAIN_DEFINITIONS: Record<Domain, DomainDefinition> = {
     // ... existing definitions
     'your-domain': {
       id: 'your-domain',
       name: 'Your Domain',
       description: 'Description of your domain',
       keywords: ['keyword1', 'keyword2'],
       loadPriority: 5,
       category: 'features',
     },
   };
   ```

2. Add tests for the new domain in `tests/unit/domains/constants.test.ts`

3. Update the README.md with the new domain

## Adding New CLI Commands

1. Create the command in `src/cli/index.ts`:
   ```typescript
   program
     .command('your-command')
     .description('Command description')
     .option('-o, --option', 'Option description')
     .action(async (options) => {
       // Implementation
     });
   ```

2. Add tests in `tests/unit/` or `tests/integration/`

## Reporting Issues

When reporting issues, please include:
- A clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node.js version)
- Relevant logs or error messages

## Pull Request Guidelines

- Keep PRs focused on a single change
- Include tests for new functionality
- Update documentation as needed
- Ensure all tests pass
- Follow existing code style

## Code of Conduct

Please be respectful and constructive in all interactions. We are committed to providing a welcoming and inclusive environment for all contributors.

## Questions?

If you have questions, feel free to:
- Open a GitHub issue
- Start a discussion in GitHub Discussions

Thank you for contributing!
