/**
 * PcmCapture — silent capture of per-speaker PCM audio to temp files.
 *
 * Each consenting speaker's audio is written to a separate raw PCM file on
 * disk. Non-consenting speakers are silently skipped. After the session the
 * post-processor mixes all per-speaker files into a single MP3.
 *
 * Ported from cfg-core-server's `RecordingCapability` (~900 lines), split on
 * the way in to stay under the 800-line cap:
 *   - silence padding         → pcm-silence-pad.ts
 *   - late-joiner consent flow → ../consent/consent-manager.ts
 *
 * This file keeps the disk-write engine: per-speaker WriteStreams, chunk
 * rotation, ring-buffer backpressure, global cap enforcement.
 *
 * Consent is queried, not owned: PcmCapture reads consent state from a
 * {@link ConsentManager} and registers as a listener so a late `Allow`
 * click opens that speaker's stream immediately.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { RecordingRingBuffer } from './ring-buffer.js'
import {
  createSilencePadState,
  padSilenceAndAppend,
  PCM_BYTES_PER_MS,
  type SilencePadState,
} from './pcm-silence-pad.js'
import type { ConsentManager } from '../consent/consent-manager.js'
import type { Logger } from '../logger.js'

/** Per-speaker in-memory PCM cap. 20 MB ≈ 210 s of 48 kHz mono s16le. */
const MAX_PER_SPEAKER_BYTES = 20 * 1024 * 1024

/** Global in-memory PCM cap across all speakers. Hard ceiling. */
const MAX_TOTAL_BUFFER_BYTES = 80 * 1024 * 1024

/**
 * Rolling-chunk threshold. 64 MB ≈ 11 minutes of audio per chunk at 96 KB/s.
 * Salvageability win over single growing files. Tunable via env if disk
 * pressure forces a smaller value.
 */
const DEFAULT_CHUNK_BYTES = 64 * 1024 * 1024

export interface PcmCaptureParams {
  recordingId: string
  /** Directory the per-speaker .pcm chunk files are written into. */
  tempDir: string
  /** Consent source. Speakers absent from it are dropped (not written). */
  consent: ConsentManager
  /** Rolling-chunk size in bytes. Defaults to 64 MB. */
  chunkBytes?: number
  logger: Logger
}

export interface RecordingResult {
  /** Temp directory containing per-speaker .pcm files. */
  tempDir: string
  /** userId → ordered list of absolute paths to that speaker's PCM chunk files. */
  speakerFiles: Map<string, string[]>
  /** Total speakers that were recorded (consented + actually spoke). */
  speakerCount: number
}

export class PcmCapture {
  private readonly recordingId: string
  private readonly tempDir: string
  private readonly consent: ConsentManager
  private readonly chunkBytes: number
  private readonly logger: Logger

  private readonly speakerStreams = new Map<string, WriteStream>()
  private readonly speakerFiles = new Map<string, string[]>()
  private readonly speakerChunkBytes = new Map<string, number>()
  private readonly speakerChunkIndex = new Map<string, number>()
  private readonly speakerBuffers = new Map<string, RecordingRingBuffer>()
  private readonly backpressured = new Set<string>()
  private readonly endPending = new Set<string>()
  private readonly brokenSpeakers = new Set<string>()
  private readonly pad: SilencePadState = createSilencePadState()
  private globalDropCount = 0

  /** When true, incoming frames are discarded without writing. Pause/resume. */
  public paused = false

  constructor(params: PcmCaptureParams) {
    this.recordingId = params.recordingId
    this.tempDir = params.tempDir
    this.consent = params.consent
    this.chunkBytes = params.chunkBytes ?? DEFAULT_CHUNK_BYTES
    this.logger = params.logger
    mkdirSync(this.tempDir, { recursive: true })
    // A late `Allow` click pre-opens that speaker's stream so audio from a
    // user already talking at consent time is captured from that moment.
    this.consent.onConsent((userId) => {
      if (!this.brokenSpeakers.has(userId)) this.openStream(userId)
    })
    this.consent.onDecline((userId) => this.closeSpeakerStream(userId))
  }

  setPaused(paused: boolean): void {
    this.paused = paused
  }

  onSpeakerStart(userId: string): void {
    if (this.paused) return
    if (this.consent.isConsented(userId)) this.openStream(userId)
  }

  onSpeakerData(userId: string, pcmMono: Buffer): void {
    if (this.paused) return
    if (!this.consent.isConsented(userId)) return

    this.rotateChunkIfNeeded(userId)
    if (!this.speakerStreams.has(userId)) this.openStream(userId)
    const stream = this.speakerStreams.get(userId)
    if (!stream || stream.destroyed) return

    // Pad with leading silence so the file's byte position tracks the
    // global wall-clock — see pcm-silence-pad.ts.
    const padded = padSilenceAndAppend(this.pad, userId, pcmMono)
    if (padded.length === 0) return

    if (!this.backpressured.has(userId)) {
      const ok = stream.write(padded)
      this.speakerChunkBytes.set(userId, (this.speakerChunkBytes.get(userId) ?? 0) + padded.length)
      if (ok) return
      this.backpressured.add(userId)
      stream.once('drain', () => this.handleDrain(userId))
      return
    }

    const buffer = this.speakerBuffers.get(userId)
    if (!buffer) return
    buffer.push(padded)
    this.speakerChunkBytes.set(userId, (this.speakerChunkBytes.get(userId) ?? 0) + padded.length)
    this.enforceGlobalCap()
  }

  onSpeakerEnd(userId: string): void {
    if (this.backpressured.has(userId)) {
      this.endPending.add(userId)
      return
    }
    this.closeSpeakerStream(userId)
  }

  /**
   * Close all open streams + flush ring buffers. Call before reading
   * getResult() so the on-disk .pcm files are complete.
   */
  async onSessionStop(): Promise<void> {
    const openCount = this.speakerStreams.size
    const backpressuredCount = this.backpressured.size

    for (const [userId, stream] of this.speakerStreams) {
      const buffer = this.speakerBuffers.get(userId)
      if (buffer && !buffer.isEmpty) {
        await Promise.race([
          buffer.drainTo(stream),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]).catch(() => {})
        buffer.clear()
      }
      if (!stream.destroyed) stream.end()
    }

    this.speakerStreams.clear()
    this.speakerBuffers.clear()
    this.backpressured.clear()
    this.endPending.clear()

    this.logger.info(
      { openCount, backpressuredCount, globalDropCount: this.globalDropCount },
      'pcm-capture session stop',
    )

    const PCM_BYTES_PER_SEC = 48_000 * 1 * 2
    for (const [userId, chunks] of this.speakerFiles) {
      const tracked = this.pad.bytesWritten.get(userId) ?? 0
      let onDisk = 0
      for (const path of chunks) {
        try {
          onDisk += (await stat(path)).size
        } catch {
          /* missing chunk */
        }
      }
      this.logger.info(
        {
          userId,
          chunkCount: chunks.length,
          trackedSeconds: +(tracked / PCM_BYTES_PER_SEC).toFixed(2),
          onDiskSeconds: +(onDisk / PCM_BYTES_PER_SEC).toFixed(2),
        },
        'pcm-capture per-speaker inventory at session stop',
      )
    }
  }

  /** Recording result for post-processing. Call after onSessionStop(). */
  getResult(): RecordingResult {
    return {
      tempDir: this.tempDir,
      speakerFiles: new Map(this.speakerFiles),
      speakerCount: this.speakerFiles.size,
    }
  }

  /** Number of speakers that have produced at least one chunk file. */
  get speakerCount(): number {
    return this.speakerFiles.size
  }

  /**
   * Current wall-clock byte offset on the shared padded timeline (0 before the
   * first frame). Real-time chunking (#131) windows every speaker at the SAME
   * offset via this value, so they stay mutually aligned — see
   * pcm-silence-pad.ts for why byte position tracks wall-clock.
   */
  timelineByteNow(): number {
    const started = this.pad.sessionStartedAtMs
    if (started == null) return 0
    const bytes = Math.floor((Date.now() - started) * PCM_BYTES_PER_MS)
    return bytes % 2 === 0 ? bytes : bytes - 1
  }

  /** Live snapshot of each speaker's ordered chunk file paths (safe to call mid-session). */
  snapshotSpeakerFiles(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const [userId, paths] of this.speakerFiles) out.set(userId, [...paths])
    return out
  }

  /** Remove the temp directory. Call after post-processing is complete. */
  async cleanup(): Promise<void> {
    try {
      await rm(this.tempDir, { recursive: true, force: true })
    } catch (err) {
      this.logger.error({ err, tempDir: this.tempDir }, 'pcm-capture cleanup failed')
    }
  }

  private openStream(userId: string): void {
    if (this.speakerStreams.has(userId)) return
    if (this.brokenSpeakers.has(userId)) return

    const chunkIndex = this.speakerChunkIndex.get(userId) ?? 0
    const chunkSuffix = String(chunkIndex).padStart(3, '0')
    const filePath = join(this.tempDir, `${userId}-${chunkSuffix}.pcm`)
    const stream = createWriteStream(filePath, { flags: 'a' })
    stream.on('error', (err) => {
      const alreadyBroken = this.brokenSpeakers.has(userId)
      this.brokenSpeakers.add(userId)
      this.speakerBuffers.get(userId)?.clear()
      this.backpressured.delete(userId)
      this.endPending.delete(userId)
      const liveStream = this.speakerStreams.get(userId)
      if (liveStream && !liveStream.destroyed) liveStream.destroy()
      this.speakerStreams.delete(userId)
      if (!alreadyBroken) {
        this.logger.error(
          { err, userId, recordingId: this.recordingId, brokenSpeakerCount: this.brokenSpeakers.size },
          'pcm-capture WriteStream error — speaker muted from recording',
        )
      }
    })
    this.speakerStreams.set(userId, stream)

    // Track each chunk path ONCE — openStream is called on every
    // speaker-start cycle, but a reopen of the same append-mode file must
    // not duplicate the path (which would replay the audio N times in the mix).
    const existing = this.speakerFiles.get(userId) ?? []
    if (existing[existing.length - 1] !== filePath) {
      existing.push(filePath)
      this.speakerFiles.set(userId, existing)
    }
    this.speakerChunkBytes.set(userId, 0)
    this.speakerBuffers.set(
      userId,
      new RecordingRingBuffer({
        maxBytes: MAX_PER_SPEAKER_BYTES,
        sessionId: this.recordingId,
        speakerId: userId,
      }),
    )
  }

  private rotateChunkIfNeeded(userId: string): void {
    const chunkBytes = this.speakerChunkBytes.get(userId) ?? 0
    if (chunkBytes < this.chunkBytes) return
    const stream = this.speakerStreams.get(userId)
    if (stream && !stream.destroyed) stream.end()
    this.speakerStreams.delete(userId)
    this.speakerBuffers.delete(userId)
    this.backpressured.delete(userId)
    this.endPending.delete(userId)
    this.speakerChunkIndex.set(userId, (this.speakerChunkIndex.get(userId) ?? 0) + 1)
    this.speakerChunkBytes.set(userId, 0)
  }

  private handleDrain(userId: string): void {
    const stream = this.speakerStreams.get(userId)
    const buffer = this.speakerBuffers.get(userId)
    if (!stream || !buffer) {
      this.backpressured.delete(userId)
      return
    }
    void buffer
      .drainTo(stream)
      .catch((err) => this.logger.error({ err, userId }, 'pcm-capture drainTo failed'))
      .finally(() => {
        this.backpressured.delete(userId)
        if (this.endPending.has(userId)) {
          this.endPending.delete(userId)
          this.closeSpeakerStream(userId)
        }
      })
  }

  private closeSpeakerStream(userId: string): void {
    const stream = this.speakerStreams.get(userId)
    if (stream && !stream.destroyed) stream.end()
    this.speakerStreams.delete(userId)
    this.speakerBuffers.delete(userId)
    this.backpressured.delete(userId)
    this.endPending.delete(userId)
    // speakerBytesWritten (pad state) is intentionally retained across
    // close/reopen so silence padding stays aligned on resume.
  }

  private enforceGlobalCap(): void {
    let total = this.totalBuffered()
    if (total <= MAX_TOTAL_BUFFER_BYTES) return

    let droppedFrames = 0
    while (total > MAX_TOTAL_BUFFER_BYTES) {
      let largestId: string | null = null
      let largestBytes = 0
      for (const [id, buf] of this.speakerBuffers) {
        if (buf.byteLength > largestBytes) {
          largestBytes = buf.byteLength
          largestId = id
        }
      }
      if (!largestId || largestBytes === 0) break
      const dropped = this.speakerBuffers.get(largestId)!.shiftOldest()
      if (!dropped) break
      droppedFrames++
      total -= dropped.length
    }
    this.globalDropCount += droppedFrames
    this.logger.warn(
      { recordingId: this.recordingId, droppedFrames, totalBuffered: total },
      'pcm-capture global cap enforced',
    )
  }

  private totalBuffered(): number {
    let total = 0
    for (const buf of this.speakerBuffers.values()) total += buf.byteLength
    return total
  }
}
