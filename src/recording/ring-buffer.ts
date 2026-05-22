/**
 * RecordingRingBuffer — bounded in-memory queue for PCM chunks under
 * WriteStream backpressure.
 *
 * Ported verbatim from cfg-core-server's `services/recording/recording-buffer.ts`,
 * with the logger swapped for this repo's pino instance.
 *
 * A 2-hour 5-speaker session can generate 3.5 GB of PCM in the hot path.
 * When disk writes fall behind the audio rate, we must either block the
 * event loop (bad), buffer unboundedly (worse), or drop the oldest audio
 * with a counter. This class does the last option:
 *
 *   - push(buf)     — append; drop oldest whole chunks until under maxBytes
 *   - shiftOldest() — pop oldest chunk (for external global-cap relief)
 *   - drainTo(ws)   — flush buffered chunks to a WriteStream respecting
 *                     `write()===false` + 'drain' backpressure
 */

import { once } from 'node:events'
import { logger as rootLogger } from '../logger.js'

const logger = rootLogger.child({ module: 'ring-buffer' })

export interface RingBufferLogger {
  warn(event: string, data: Record<string, unknown>): void
}

export interface RecordingRingBufferOptions {
  /** Hard cap on buffered bytes. push() drops oldest whole chunks above this. */
  maxBytes: number
  /** Session id for structured logs. */
  sessionId: string
  /** Speaker (Discord user) id for structured logs. */
  speakerId: string
  /** Optional structured logger. Defaults to the module pino logger. */
  logger?: RingBufferLogger
}

const defaultLogger: RingBufferLogger = {
  warn: (event, data) => {
    logger.warn(data, event)
  },
}

export class RecordingRingBuffer {
  private readonly chunks: Buffer[] = []
  private readonly logger: RingBufferLogger
  private _bytes = 0
  private _dropCount = 0
  private _droppedBytes = 0
  private _draining = false

  constructor(private readonly opts: RecordingRingBufferOptions) {
    this.logger = opts.logger ?? defaultLogger
  }

  get byteLength(): number {
    return this._bytes
  }
  get dropCount(): number {
    return this._dropCount
  }
  get droppedBytes(): number {
    return this._droppedBytes
  }
  get length(): number {
    return this.chunks.length
  }
  get isEmpty(): boolean {
    return this.chunks.length === 0
  }
  get maxBytes(): number {
    return this.opts.maxBytes
  }

  /**
   * Append a chunk. If the buffer exceeds maxBytes, drop oldest whole
   * chunks until under the cap. Each drop is logged and counted.
   */
  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this._bytes += chunk.length
    while (this._bytes > this.opts.maxBytes && this.chunks.length > 0) {
      const dropped = this.chunks.shift()!
      this._bytes -= dropped.length
      this._droppedBytes += dropped.length
      this._dropCount++
      this.logger.warn('recording-buffer.drop-oldest', {
        sessionId: this.opts.sessionId,
        speakerId: this.opts.speakerId,
        droppedBytes: dropped.length,
        totalBuffered: this._bytes,
        dropCount: this._dropCount,
      })
    }
  }

  /**
   * Remove and return the oldest buffered chunk, or undefined if empty.
   * Counts as a drop (used by the global-cap relief path in pcm-capture.ts).
   */
  shiftOldest(): Buffer | undefined {
    const chunk = this.chunks.shift()
    if (!chunk) return undefined
    this._bytes -= chunk.length
    this._droppedBytes += chunk.length
    this._dropCount++
    return chunk
  }

  /**
   * Flush queued chunks into a writable stream, waiting on 'drain' events
   * whenever write() signals backpressure. Safe to call repeatedly; a
   * second concurrent call is a no-op.
   */
  async drainTo(stream: NodeJS.WritableStream): Promise<void> {
    if (this._draining) return
    this._draining = true
    try {
      while (this.chunks.length > 0) {
        const chunk = this.chunks.shift()!
        this._bytes -= chunk.length
        const ok = stream.write(chunk)
        if (!ok) {
          await once(stream, 'drain')
        }
      }
    } finally {
      this._draining = false
    }
  }

  /** Drop everything. Used during teardown. */
  clear(): void {
    this.chunks.length = 0
    this._bytes = 0
  }
}
