/**
 * Scratch-space telemetry for the wrap-up.
 *
 * The mix is the single riskiest moment of a recording: ffmpeg reads every
 * per-speaker PCM file and writes `mixed.mp3` back into the SAME scratch
 * directory, and the silence-trim step then writes another copy alongside it.
 * When that directory is a size-capped tmpfs, a long multi-speaker session can
 * exhaust it — and an ENOSPC there throws inside `processRecording`, which is
 * caught upstream, so the session ends "cleanly" with no output and no obvious
 * error. That failure is indistinguishable after the fact from a container kill
 * once the container (and its logs) are gone.
 *
 * Measuring free space and PCM footprint immediately BEFORE the mix makes the
 * two cases distinguishable in the logs: if free bytes are already near zero,
 * it was capacity, not a race.
 *
 * A previous incarnation of this existed as `[disk-telemetry] tempdir usage`
 * and was lost when recording moved out of core-server.
 */

import { stat, statfs } from 'node:fs/promises'
import type { Logger } from '../logger.js'

export interface ScratchUsage {
  /** Total bytes of the per-speaker PCM inputs to the mix. */
  pcmBytes: number
  /** Per-speaker PCM files successfully measured. */
  speakerFiles: number
  /** Free bytes on the filesystem backing the scratch dir, when obtainable. */
  freeBytes: number | null
  /** Total bytes of that filesystem, when obtainable. */
  totalBytes: number | null
  /**
   * Free bytes minus a conservative estimate of what the mix still has to
   * write. Negative means the mix is predicted to fail on space.
   */
  projectedHeadroomBytes: number | null
}

/**
 * The mix writes an mp3, and the trim step writes a second one before the
 * first is unlinked. Both are far smaller than the raw PCM, but they are not
 * free — budget a fraction of the PCM footprint for the pair.
 */
const MIX_OUTPUT_BUDGET_RATIO = 0.2

/**
 * Measure scratch usage. Never throws — telemetry must not be able to break a
 * wrap-up it exists to explain. Unmeasurable values come back null.
 */
export async function measureScratchUsage(
  tempDir: string,
  speakerFilePaths: string[],
): Promise<ScratchUsage> {
  let pcmBytes = 0
  let measured = 0
  for (const path of speakerFilePaths) {
    try {
      pcmBytes += (await stat(path)).size
      measured++
    } catch {
      // A speaker file that has already been consumed or never opened is not
      // an error here — it simply contributes nothing to the footprint.
    }
  }

  let freeBytes: number | null = null
  let totalBytes: number | null = null
  try {
    const fs = await statfs(tempDir)
    freeBytes = Number(fs.bavail) * Number(fs.bsize)
    totalBytes = Number(fs.blocks) * Number(fs.bsize)
  } catch {
    // statfs is unavailable on some platforms/filesystems; the PCM footprint
    // alone is still worth logging.
  }

  const projectedHeadroomBytes =
    freeBytes === null ? null : Math.round(freeBytes - pcmBytes * MIX_OUTPUT_BUDGET_RATIO)

  return { pcmBytes, speakerFiles: measured, freeBytes, totalBytes, projectedHeadroomBytes }
}

/** True when the mix is predicted to run out of space. */
export function isScratchExhausted(usage: ScratchUsage): boolean {
  return usage.projectedHeadroomBytes !== null && usage.projectedHeadroomBytes <= 0
}

/**
 * Log an already-measured usage. Warns when the mix is predicted to run out of
 * space, so the condition appears in the logs BEFORE the failure it causes.
 */
export function logScratchUsage(
  recordingId: string,
  tempDir: string,
  usage: ScratchUsage,
  logger: Logger,
): void {
  const fields = { recordingId, tempDir, ...usage }
  if (isScratchExhausted(usage)) {
    logger.warn(fields, 'post-process: scratch space may be exhausted — the mix is likely to fail')
  } else {
    logger.info(fields, 'post-process: scratch usage before mix')
  }
}

/** Measure and log scratch usage ahead of the mix. */
export async function logScratchUsageBeforeMix(
  recordingId: string,
  tempDir: string,
  speakerFilePaths: string[],
  logger: Logger,
): Promise<ScratchUsage> {
  const usage = await measureScratchUsage(tempDir, speakerFilePaths)
  logScratchUsage(recordingId, tempDir, usage, logger)
  return usage
}
