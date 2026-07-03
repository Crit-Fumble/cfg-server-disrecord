/**
 * ChunkRecorder — real-time mp3 chunking (cfg-core-dev-tools#131).
 *
 * ReSesh's marketed differentiator: while a session is still running, post
 * bite-sized mp3 chunks into the transcript thread on a wall-clock cadence, so
 * players can scroll back and listen to something they missed WITHOUT waiting
 * for the whole session to end.
 *
 * How it reuses the existing pipeline (no new encoder, no live re-mix):
 *   {@link PcmCapture} already writes each speaker's audio to per-speaker `.pcm`
 *   files that are silence-padded so a byte offset maps to a SHARED wall-clock
 *   timeline (see pcm-silence-pad.ts: byte = ms × PCM_BYTES_PER_MS). So a chunk
 *   is just a byte WINDOW of every speaker's stream: cut [startByte, endByte)
 *   out of each speaker's file(s), mix those windows with the SAME
 *   {@link buildFfmpegArgs} the end-of-session mixer uses, and upload the mp3.
 *   Because every speaker is windowed at the same shared byte offset, they stay
 *   mutually aligned inside the chunk — no per-window re-basing needed.
 *
 * Canonical artifact is unchanged: the whole-session mp3 is still produced at
 * stop(). Chunks are an additive live convenience, so they can be slightly
 * lossy at a boundary (the last few unflushed KB of a window may land in the
 * next chunk or only in the final mp3) without losing any audio overall.
 *
 * Disabled by default (`chunkMinutes <= 0`) — every method is a no-op, so an
 * un-configured self-host or CFG session behaves exactly as before.
 */

import { open, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { buildFfmpegArgs, runFfmpeg } from './ffmpeg.js'
import { PCM_BYTES_PER_MS } from './pcm-silence-pad.js'
import type { Logger } from '../logger.js'

/** One speaker chunk file and its current on-disk byte length. */
export interface FileSpan {
  path: string
  size: number
}

/** A byte slice to read from a single file. */
export interface ReadSlice {
  path: string
  offset: number
  length: number
}

/** PCM bytes per second of 48 kHz mono s16le audio (96 B/ms × 1000). */
const PCM_BYTES_PER_SEC = PCM_BYTES_PER_MS * 1000

/** Discord's non-boosted upload cap we split against elsewhere; chunks over it are skipped. */
const DISCORD_MAX_CHUNK_BYTES = 9 * 1024 * 1024

/** Even-align a byte offset DOWN (an s16le sample is 2 bytes). */
export function evenFloor(bytes: number): number {
  const n = Math.max(0, Math.floor(bytes))
  return n % 2 === 0 ? n : n - 1
}

/**
 * Map a byte range [startByte, endByte) of a speaker's CONCATENATED chunk files
 * to per-file read slices. Pure. `files` is in chronological order and each
 * carries its current on-disk `size`; a range past the end of available data is
 * truncated (a speaker silent at the window end just contributes fewer bytes —
 * the mixer's `duration=longest` handles unequal lengths).
 */
export function planWindowReads(files: FileSpan[], startByte: number, endByte: number): ReadSlice[] {
  const slices: ReadSlice[] = []
  if (endByte <= startByte) return slices
  let fileStart = 0 // running byte offset of `file`'s first byte on the concatenated timeline
  for (const file of files) {
    const fileEnd = fileStart + file.size
    const from = Math.max(startByte, fileStart)
    const to = Math.min(endByte, fileEnd)
    if (to > from) slices.push({ path: file.path, offset: from - fileStart, length: to - from })
    fileStart = fileEnd
  }
  return slices
}

export interface ChunkInfo {
  mp3Path: string
  index: number
  startSec: number
  endSec: number
  sizeBytes: number
}

export interface ChunkRecorderParams {
  recordingId: string
  /** Chunk cadence in minutes. `<= 0` disables the recorder entirely. */
  chunkMinutes: number
  /** Scratch dir the window `.pcm` + chunk `.mp3` files are written into. */
  tempDir: string
  /** Live snapshot of each speaker's ordered chunk file paths. */
  getSpeakerFiles: () => Map<string, string[]>
  /** Current wall-clock byte offset on the shared padded timeline (0 before the first frame). */
  timelineByteNow: () => number
  /** Upload one finalized chunk mp3. Best-effort — a throw is logged, not fatal. */
  postChunk: (info: ChunkInfo) => Promise<void>
  logger: Logger
}

export class ChunkRecorder {
  private timer: NodeJS.Timeout | null = null
  private index = 0
  private windowStartByte = 0
  /** Serializes every cut (interval / pause / final) so they never overlap. */
  private chain: Promise<void> = Promise.resolve()
  private readonly enabled: boolean
  private readonly intervalMs: number

  constructor(private readonly p: ChunkRecorderParams) {
    this.enabled = p.chunkMinutes > 0
    this.intervalMs = Math.round(p.chunkMinutes * 60_000)
  }

  /** Arm the wall-clock chunk timer. No-op when disabled. */
  start(): void {
    if (!this.enabled) return
    this.timer = setInterval(() => void this.enqueue('interval'), this.intervalMs)
    this.timer.unref()
    this.p.logger.info({ recordingId: this.p.recordingId, chunkMinutes: this.p.chunkMinutes }, 'chunk recorder armed')
  }

  /** Flush the current window early so paused players get it immediately. */
  async onPause(): Promise<void> {
    if (this.enabled) await this.enqueue('pause')
  }

  /**
   * On resume, advance the window start to NOW so the paused span (materialized
   * as silence in the padded timeline) isn't buried into the next chunk.
   */
  onResume(): void {
    if (this.enabled) this.windowStartByte = this.p.timelineByteNow()
  }

  /** Disarm the timer and flush the trailing window. Call once on stop, BEFORE temp cleanup. */
  async finalize(): Promise<void> {
    if (!this.enabled) return
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    await this.enqueue('final')
  }

  /** Queue a cut behind any in-flight one so cuts never overlap or race the window cursor. */
  private enqueue(reason: string): Promise<void> {
    this.chain = this.chain.then(() => this.cut(reason)).catch(() => {})
    return this.chain
  }

  private async cut(reason: string): Promise<void> {
    const endByte = this.p.timelineByteNow()
    const startByte = this.windowStartByte
    if (endByte <= startByte) return // no new audio since the last cut

    const speakerFiles = this.p.getSpeakerFiles()
    const windowFiles = new Map<string, string[]>()
    try {
      for (const [userId, chunkPaths] of speakerFiles) {
        const spans = await this.fileSpans(chunkPaths)
        const slices = planWindowReads(spans, startByte, endByte)
        if (slices.length === 0) continue
        const outPath = join(this.p.tempDir, `chunk-${pad3(this.index)}-${userId}.pcm`)
        const written = await this.writeSlices(slices, outPath)
        if (written > 0) windowFiles.set(userId, [outPath])
      }

      // Advance the cursor + index BEFORE the mix/upload so a slow post can
      // never re-cut the same window on the next tick.
      const index = this.index
      const startSec = startByte / PCM_BYTES_PER_SEC
      const endSec = endByte / PCM_BYTES_PER_SEC
      this.windowStartByte = endByte
      this.index += 1

      if (windowFiles.size === 0) return // window was pure silence for everyone

      const mp3Path = join(this.p.tempDir, `chunk-${pad3(index)}.mp3`)
      await runFfmpeg(buildFfmpegArgs(windowFiles, mp3Path), `${this.p.recordingId}-chunk-${index}`)
      await this.rmAll(Array.from(windowFiles.values()).flat())

      const sizeBytes = (await stat(mp3Path)).size
      if (sizeBytes > DISCORD_MAX_CHUNK_BYTES) {
        // Chunks are meant to be small; an over-cap chunk is skipped rather than
        // split (the whole-session mp3 still carries this span). Operators keep
        // chunks under the cap by picking a smaller chunkMinutes.
        this.p.logger.warn(
          { recordingId: this.p.recordingId, index, sizeBytes, cap: DISCORD_MAX_CHUNK_BYTES },
          'chunk exceeds Discord upload cap — skipping (covered by the whole-session mp3)',
        )
        await this.rmAll([mp3Path])
        return
      }

      await this.p.postChunk({ mp3Path, index, startSec, endSec, sizeBytes })
      await this.rmAll([mp3Path])
      this.p.logger.info(
        { recordingId: this.p.recordingId, reason, index, startSec, endSec, sizeBytes, speakers: windowFiles.size },
        'chunk finalized + posted',
      )
    } catch (err) {
      this.p.logger.warn({ err, recordingId: this.p.recordingId, reason }, 'chunk cut failed (non-fatal)')
      await this.rmAll(Array.from(windowFiles.values()).flat()).catch(() => {})
    }
  }

  private async fileSpans(paths: string[]): Promise<FileSpan[]> {
    const spans: FileSpan[] = []
    for (const path of paths) {
      try {
        spans.push({ path, size: (await stat(path)).size })
      } catch {
        /* a rotated/absent chunk file — skip */
      }
    }
    return spans
  }

  /** Read the planned slices out of the source PCM files into one contiguous window file. */
  private async writeSlices(slices: ReadSlice[], outPath: string): Promise<number> {
    const out = await open(outPath, 'w')
    let total = 0
    try {
      for (const s of slices) {
        const fh = await open(s.path, 'r')
        try {
          const buf = Buffer.alloc(s.length)
          const { bytesRead } = await fh.read(buf, 0, s.length, s.offset)
          if (bytesRead > 0) {
            await out.write(buf.subarray(0, bytesRead))
            total += bytesRead
          }
        } finally {
          await fh.close()
        }
      }
    } finally {
      await out.close()
    }
    return total
  }

  private async rmAll(paths: string[]): Promise<void> {
    await Promise.all(paths.map((p) => rm(p, { force: true }).catch(() => {})))
  }
}

function pad3(n: number): string {
  return String(n).padStart(3, '0')
}
