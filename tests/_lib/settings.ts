/**
 * Shared test helper: a settings store for suites that don't care about
 * settings but must satisfy `ControlServerParams`.
 *
 * Points at a path under the OS temp dir that is never written — every caller
 * so far passes `settingsReadOnly: true`, and reads of a missing file are the
 * normal first-run case, so no file is created. Suites that DO exercise
 * settings build their own store over a real `mkdtemp` directory.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSettingsStore, type SettingsStore } from '../../src/settings/settings-store.js'

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
} as never

export function testSettingsStore(path?: string): SettingsStore {
  return new FileSettingsStore({
    path: path ?? join(tmpdir(), 'disrecord-test-settings-unused.json'),
    logger: silentLogger,
  })
}
