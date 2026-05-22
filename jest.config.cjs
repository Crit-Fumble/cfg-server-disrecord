/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '**/tests/unit/**/*.test.ts',
    '**/tests/integration/**/*.test.ts',
    '**/src/**/__tests__/**/*.test.ts',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // The native opus binding isn't rebuilt in CI; route every import to a
    // JS mock so unit tests that transitively pull in the voice stack run
    // without native bindings. Tests that need richer behavior still call
    // jest.mock('@discordjs/opus') themselves, which overrides this.
    '^@discordjs/opus$': '<rootDir>/__mocks__/@discordjs/opus.js',
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
  clearMocks: true,
}
