/**
 * Integration test config — runs against the Dev Den Discord server
 * (guild 1153767296867770378). Requires real credentials in env:
 *   - RESESH_DISCORD_TOKEN
 *   - DEEPGRAM_API_KEY (for the platform-key Deepgram tests)
 *   - CORE_SERVER_URL
 *   - CORE_SERVER_AUTH_SECRET
 *
 * Skipped if RESESH_INTEGRATION_TESTS_ENABLED is not 'true'.
 * Run: RESESH_INTEGRATION_TESTS_ENABLED=true npm run test:integration
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/integration/**/*.test.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^(\\.\\.?/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['@swc/jest', {
      jsc: {
        parser: { syntax: 'typescript' },
        target: 'es2022',
      },
    }],
  },
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  // Integration tests can be slow — Discord gateway connect + voice
  // handshake routinely take 5-10s.
  testTimeout: 60_000,
  // Run integrations serially so two parallel suites don't fight over
  // the same bot identity's gateway connection.
  maxWorkers: 1,
}
