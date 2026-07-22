/**
 * Scratch telemetry — measures PCM footprint and free space before the mix.
 *
 * Exists so an ENOSPC during the mix is visible in the logs as a capacity
 * problem rather than looking identical to a container kill (cs#205).
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  measureScratchUsage,
  logScratchUsage,
  logScratchUsageBeforeMix,
} from '../../../src/recording/scratch-telemetry.js'

function fakeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never
}

describe('measureScratchUsage', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scratch-telemetry-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('sums the PCM footprint across every speaker file', async () => {
    const a = join(dir, 'a.pcm')
    const b = join(dir, 'b.pcm')
    await writeFile(a, Buffer.alloc(1024))
    await writeFile(b, Buffer.alloc(2048))

    const usage = await measureScratchUsage(dir, [a, b])

    expect(usage.pcmBytes).toBe(3072)
    expect(usage.speakerFiles).toBe(2)
  })

  it('reports real free/total bytes for the scratch filesystem', async () => {
    const usage = await measureScratchUsage(dir, [])

    expect(usage.totalBytes).toBeGreaterThan(0)
    expect(usage.freeBytes).toBeGreaterThan(0)
    expect(usage.freeBytes as number).toBeLessThanOrEqual(usage.totalBytes as number)
  })

  // Telemetry must never be the thing that breaks a wrap-up.
  it('skips files that no longer exist instead of throwing', async () => {
    const present = join(dir, 'present.pcm')
    await writeFile(present, Buffer.alloc(512))

    const usage = await measureScratchUsage(dir, [present, join(dir, 'gone.pcm')])

    expect(usage.pcmBytes).toBe(512)
    expect(usage.speakerFiles).toBe(1)
  })

  it('returns nulls rather than throwing when the directory is unreadable', async () => {
    const usage = await measureScratchUsage(join(dir, 'does-not-exist'), [])

    expect(usage.freeBytes).toBeNull()
    expect(usage.totalBytes).toBeNull()
    expect(usage.projectedHeadroomBytes).toBeNull()
  })
})

describe('logScratchUsageBeforeMix', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scratch-telemetry-log-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('logs at info when there is headroom', async () => {
    const logger = fakeLogger()

    await logScratchUsageBeforeMix('rec-1', dir, [], logger)

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ recordingId: 'rec-1', tempDir: dir }),
      expect.stringContaining('scratch usage before mix'),
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  // The condition cs#205 needs surfaced: a session whose PCM footprint has
  // grown past what the scratch filesystem can absorb the mix output into.
  it('warns when the projected mix output exceeds the space left', () => {
    const logger = fakeLogger()

    logScratchUsage(
      'rec-1',
      dir,
      {
        pcmBytes: 3_700_000_000,
        speakerFiles: 6,
        freeBytes: 300_000_000,
        totalBytes: 4_000_000_000,
        projectedHeadroomBytes: -440_000_000,
      },
      logger,
    )

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ recordingId: 'rec-1', pcmBytes: 3_700_000_000 }),
      expect.stringContaining('scratch space may be exhausted'),
    )
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('treats unmeasurable free space as non-exhausted rather than alarming', () => {
    const logger = fakeLogger()

    logScratchUsage(
      'rec-1',
      dir,
      {
        pcmBytes: 1024,
        speakerFiles: 1,
        freeBytes: null,
        totalBytes: null,
        projectedHeadroomBytes: null,
      },
      logger,
    )

    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalled()
  })
})
