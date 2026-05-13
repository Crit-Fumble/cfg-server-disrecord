/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/unit/**/*.test.ts', '**/src/**/__tests__/**/*.test.ts'],
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
  clearMocks: true,
}
