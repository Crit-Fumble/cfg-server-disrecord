/**
 * NOTE ON `--forceExit` (in the `test` script, not here):
 *
 * `@snazzah/davey` — the DAVE voice-E2EE native addon pulled in transitively by
 * `@discordjs/voice` — registers a `CustomGC` handle on load that keeps the Node
 * process alive after the suite finishes. Jest reports it under
 * `--detectOpenHandles` as:
 *
 *     ●  CustomGC
 *          at requireNative (node_modules/@snazzah/davey/index.js:184:25)
 *
 * Locally the runner still exits; in CI, with no TTY, the job HUNG — two runs
 * sat at 45m and 2h30m, and because they never concluded they never reported
 * failure, so CI was gating nothing at all (disrecord#13).
 *
 * The handle is inside a third-party native module we do not control and cannot
 * unref, and the voice stack is loaded transitively by code under test, so
 * mocking it away would mean mocking most of the recording path.
 *
 * `--forceExit` ALONE WAS NOT ENOUGH — verified in CI, not assumed. The run
 * still hung: every suite reported PASS, then nine minutes of silence with no
 * jest summary line, ending in `Terminate orphan process (npm test)`. Jest was
 * blocked waiting on a WORKER child that would not exit, which happens before
 * results are reported and therefore before `--forceExit` can act.
 *
 * Hence `--runInBand` too: with no worker children there is nothing to wait on,
 * and the force-exit fires in-process. The suite's real runtime is about a
 * second, so serial execution costs nothing here.
 *
 * The job also carries `timeout-minutes: 10` so a DIFFERENT future hang fails
 * fast and loudly instead of silently burning runner hours.
 *
 * @type {import('jest').Config}
 */
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
    // `jose` ships as ESM-only `.js`; transform it (ecmascript parser) so the
    // control-API JWT decode path (control/auth.ts) loads under jest.
    '^.+\\.js$': ['@swc/jest', {
      jsc: {
        parser: { syntax: 'ecmascript' },
        target: 'es2022',
      },
    }],
  },
  transformIgnorePatterns: ['/node_modules/(?!jose/)'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  clearMocks: true,
}
