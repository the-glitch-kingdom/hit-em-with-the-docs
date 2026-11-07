import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    // CI runners have no git identity; reconcile --apply commits in fixture repos.
    env: { GIT_AUTHOR_NAME: 'hewtd-test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'hewtd-test', GIT_COMMITTER_EMAIL: 'test@example.com' },
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules',
        'dist',
        'tests',
        'templates',
        '**/*.d.ts',
        '**/*.config.ts',
      ],
      thresholds: {
        global: {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
