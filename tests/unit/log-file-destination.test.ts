/**
 * Worker log file destination.
 *
 * Diagnostic plumbing, so the contract is mostly about what it must NOT do:
 * never throw, never grow without bound, and never be the reason a recording
 * fails. It exists because AutoRemove takes the container's logs with it
 * (cfg-core-server#205).
 */
import { mkdtemp, rm, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLogFileDestination } from '../../src/log-file-destination.js'

const ENV_KEYS = [
  'OUTPUT_DIR',
  'DISRECORD_LOG_TO_FILE',
  'DISRECORD_LOG_FILE_MAX_BYTES',
  'DISRECORD_INSTALLATION_ID',
]

describe('openLogFileDestination', () => {
  let dir: string
  let saved: Record<string, string | undefined>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'worker-logs-test-'))
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    for (const k of ENV_KEYS) delete process.env[k]
    process.env.OUTPUT_DIR = dir
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('writes into a _logs dir under the output volume', async () => {
    const dest = openLogFileDestination()

    expect(dest).not.toBeNull()
    expect(dest?.path).toContain(join(dir, '_logs'))
    // The stream is lazy — the file appears on first write.
    dest?.stream.write('{"msg":"open"}\n')
    await new Promise((r) => setTimeout(r, 20))
    expect(await readdir(join(dir, '_logs'))).toHaveLength(1)
  })

  // Underscore prefix keeps it from ever colliding with a recordingId dir the
  // output sink writes alongside it.
  it('names the file by installation and boot so a restart cannot overwrite it', () => {
    process.env.DISRECORD_INSTALLATION_ID = 'inst-42'

    const a = openLogFileDestination()
    const b = openLogFileDestination()

    expect(a?.path).toContain('worker-inst-42-')
    expect(a?.path).not.toBe(b?.path)
  })

  it('actually persists written lines', async () => {
    const dest = openLogFileDestination()
    dest?.stream.write('{"msg":"hello"}\n')
    await new Promise((r) => setTimeout(r, 20))

    expect(await readFile(dest!.path, 'utf-8')).toContain('hello')
  })

  it('is disabled by DISRECORD_LOG_TO_FILE=0', () => {
    process.env.DISRECORD_LOG_TO_FILE = '0'

    expect(openLogFileDestination()).toBeNull()
  })

  // The worker must survive an unwritable volume — stdout-only is a fine
  // degraded mode; a crash is not.
  it('returns null rather than throwing when the volume is unwritable', async () => {
    // Point OUTPUT_DIR at a path UNDER a regular file. `mkdirSync` there fails
    // with ENOTDIR synchronously on every platform.
    //
    // This used to be '/proc/nonexistent-cannot-create'. That relied on /proc
    // being unwritable — but /proc only exists on Linux, and there `mkdirSync`
    // on it does not fail fast, it BLOCKS THE EVENT LOOP. On the Linux CI runner
    // that hung the entire jest process forever: every suite reported PASS, then
    // no summary and no exit, so the job never concluded and CI silently gated
    // nothing (disrecord#13). macOS has no /proc, took a different branch, and
    // passed — which is why this could only be reproduced in a linux/amd64
    // container, never locally. A file-as-parent path is unwritable identically
    // everywhere and removes the platform split.
    const filePath = join(dir, 'not-a-directory')
    await writeFile(filePath, 'x')
    process.env.OUTPUT_DIR = join(filePath, 'sub')

    expect(() => openLogFileDestination()).not.toThrow()
    expect(openLogFileDestination()).toBeNull()
  })

  it('stops writing once the byte cap is exceeded', async () => {
    process.env.DISRECORD_LOG_FILE_MAX_BYTES = '200'
    const dest = openLogFileDestination()

    for (let i = 0; i < 200; i++) dest?.stream.write(`{"msg":"${'x'.repeat(50)}"}\n`)
    await new Promise((r) => setTimeout(r, 40))

    const size = (await stat(dest!.path)).size
    // Bounded well below what 200 unbounded lines (~11 KB) would have produced.
    expect(size).toBeLessThan(2000)
    expect(await readFile(dest!.path, 'utf-8')).toContain('log file cap reached')
  })

  it('a write after the cap does not throw', async () => {
    process.env.DISRECORD_LOG_FILE_MAX_BYTES = '50'
    const dest = openLogFileDestination()

    dest?.stream.write(`{"msg":"${'x'.repeat(200)}"}\n`)
    await new Promise((r) => setTimeout(r, 20))

    expect(() => dest?.stream.write('{"msg":"after"}\n')).not.toThrow()
  })
})
