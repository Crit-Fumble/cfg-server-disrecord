/**
 * Audio Splitter — pause detection, split-point planning, and MP3 chunking.
 *
 * Ported verbatim from cfg-core-server's `services/recording/audio-splitter.ts`,
 * with the logger swapped for this repo's pino instance. Used by
 * thread-poster.ts to split long recordings into Discord-uploadable parts.
 */

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ffmpegPath, FFMPEG_TIMEOUT_MS, runFfmpeg } from './ffmpeg.js'
import { logger as rootLogger } from '../logger.js'
import type { CaptionEntry } from './caption-types.js'

const logger = rootLogger.child({ module: 'audio-splitter' })

/**
 * Max bytes per MP3 part when chunking a long recording. Discord's tier-0
 * (no boost) upload cap is 10 MiB; we target 9 MiB per chunk.
 */
export const DISCORD_MAX_PART_BYTES = 9 * 1024 * 1024

/** Lowest segment length we'll accept from the bitrate math. */
export const MIN_SEGMENT_SECONDS = 30

/** Fraction of the target segment length searched for a natural pause. */
const PAUSE_SEARCH_WINDOW_FRAC = 0.4

/** Minimum pause duration (seconds) that counts as "natural" for split alignment. */
const MIN_PAUSE_FOR_SPLIT_SEC = 0.8

/** ffmpeg silencedetect parameters for split-point detection. */
const SILENCEDETECT_NOISE_DB = -30
const SILENCEDETECT_DURATION_SEC = 0.8

/** Represents an interval of silence in the mixed MP3, in seconds. */
export interface PauseRange {
  startSec: number
  endSec: number
  durationSec: number
}

/**
 * Compute natural-pause intervals from caption data. A gap between
 * `captions[i].endSec` and `captions[i+1].startSec` longer than
 * `MIN_PAUSE_FOR_SPLIT_SEC` becomes a candidate breakpoint.
 */
export function findPausesFromCaptions(captions: CaptionEntry[]): PauseRange[] {
  if (captions.length < 2) return []
  const pauses: PauseRange[] = []
  for (let i = 0; i < captions.length - 1; i++) {
    const gapStart = captions[i].endSec
    const gapEnd = captions[i + 1].startSec
    const gapDuration = gapEnd - gapStart
    if (gapDuration >= MIN_PAUSE_FOR_SPLIT_SEC) {
      pauses.push({ startSec: gapStart, endSec: gapEnd, durationSec: gapDuration })
    }
  }
  return pauses
}

/**
 * Run ffmpeg's silencedetect filter over the mixed MP3 and parse stderr
 * for `silence_start` / `silence_end` pairs.
 */
export async function findPausesFromSilenceDetect(
  sourcePath: string,
  recordingId: string,
): Promise<PauseRange[]> {
  return new Promise<PauseRange[]>((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-nostdin',
      '-i',
      sourcePath,
      '-af',
      `silencedetect=noise=${SILENCEDETECT_NOISE_DB}dB:d=${SILENCEDETECT_DURATION_SEC}`,
      '-f',
      'null',
      '-',
    ]
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })

    let stderrBuf = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8')
      if (stderrBuf.length > 256 * 1024) {
        stderrBuf = stderrBuf.slice(-256 * 1024)
      }
    })

    const killTimer = setTimeout(() => {
      logger.error({ recordingId, timeoutMs: FFMPEG_TIMEOUT_MS }, 'silencedetect timeout — killing')
      child.kill('SIGKILL')
    }, FFMPEG_TIMEOUT_MS)

    child.once('error', (err) => {
      clearTimeout(killTimer)
      reject(err)
    })

    child.once('close', (code) => {
      clearTimeout(killTimer)
      if (code !== 0) {
        reject(new Error(`silencedetect exited with code=${code}`))
        return
      }

      const pauses: PauseRange[] = []
      let pendingStart: number | null = null
      const lines = stderrBuf.split('\n')
      for (const line of lines) {
        const startMatch = line.match(/silence_start:\s*([0-9.]+)/)
        if (startMatch) {
          pendingStart = Number(startMatch[1])
          continue
        }
        const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/)
        if (endMatch && pendingStart !== null) {
          const endSec = Number(endMatch[1])
          const durationSec = Number(endMatch[2])
          pauses.push({ startSec: pendingStart, endSec, durationSec })
          pendingStart = null
        }
      }
      resolve(pauses)
    })
  })
}

/**
 * Plan breakpoints for a pause-aligned split. Walks the timeline in
 * `targetSegmentSec`-sized chunks, looks backwards for the longest pause,
 * and cuts there (or at the hard target if no pause found).
 */
export function planSplitPoints(totalDurationSec: number, targetSegmentSec: number, pauses: PauseRange[]): number[] {
  if (totalDurationSec <= targetSegmentSec) return []

  const breakpoints: number[] = []
  const searchBack = targetSegmentSec * PAUSE_SEARCH_WINDOW_FRAC
  let cursor = 0

  for (let iter = 0; iter < 200; iter++) {
    const hardTarget = cursor + targetSegmentSec
    if (hardTarget >= totalDurationSec) break

    const searchStart = cursor + (targetSegmentSec - searchBack)
    let best: PauseRange | null = null
    for (const p of pauses) {
      const mid = (p.startSec + p.endSec) / 2
      if (mid < searchStart || mid > hardTarget) continue
      if (best === null || p.durationSec > best.durationSec) best = p
    }

    const breakpoint = best !== null ? (best.startSec + best.endSec) / 2 : hardTarget
    breakpoints.push(Number(breakpoint.toFixed(3)))
    cursor = breakpoint
  }

  return breakpoints
}

/**
 * Split a finalized MP3 into sequential parts using explicit breakpoints.
 * Parts land in `tempDir` as `part-00.mp3`, `part-01.mp3`, …
 */
export async function splitMp3AtBreakpoints(
  sourcePath: string,
  tempDir: string,
  breakpoints: number[],
  recordingId: string,
): Promise<string[]> {
  if (breakpoints.length === 0) {
    return [sourcePath]
  }

  const pattern = join(tempDir, 'part-%02d.mp3')
  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-i',
    sourcePath,
    '-f',
    'segment',
    '-segment_times',
    breakpoints.join(','),
    '-c',
    'copy',
    '-reset_timestamps',
    '1',
    '-y',
    pattern,
  ]

  await runFfmpeg(args, recordingId)

  const parts: string[] = []
  for (let i = 0; i < 100; i++) {
    const candidate = join(tempDir, `part-${String(i).padStart(2, '0')}.mp3`)
    try {
      await stat(candidate)
      parts.push(candidate)
    } catch {
      break
    }
  }

  if (parts.length === 0) {
    throw new Error('ffmpeg segment produced no output files')
  }
  return parts
}
