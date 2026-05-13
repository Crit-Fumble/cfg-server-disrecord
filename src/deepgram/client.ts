/**
 * Deepgram Streaming Client — WebSocket connection for real-time transcription.
 *
 * One instance per speaker per transcription session. Accepts raw PCM audio
 * buffers and emits transcript events.
 *
 * Usage:
 *   const stream = createDeepgramStream({ apiKey }, { model: 'nova-3', sampleRate: 48000 })
 *   stream.on('transcript', (ev) => logger.info(ev.transcript))
 *   stream.send(pcmBuffer)
 *   await stream.close()
 */

import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import type { DeepgramStreamOptions, DeepgramResult, DeepgramUtteranceEnd, TranscriptEvent } from './types.js'

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen'
const KEEPALIVE_INTERVAL_MS = 8_000 // Deepgram closes idle connections after ~12s

/**
 * Build the Deepgram Live WebSocket URL from a caller's options. Pure — no
 * network, no side effects. Exported so unit tests can lock in the
 * auto-force rules (notably `interim_results=true` when `utterance_end_ms`
 * is set, which otherwise causes a 400 on the WebSocket handshake).
 */
export function buildDeepgramUrl(options: DeepgramStreamOptions = {}): string {
  // Deepgram requires interim_results=true whenever utterance_end_ms is
  // set — the UtteranceEnd message is only delivered on interim-result
  // channels, and sending the combo with interim_results=false returns
  // HTTP 400 on the WebSocket handshake. Auto-force it here so callers
  // can't accidentally break the streaming connection by omitting the
  // flag. Caller-visible behavior is unchanged: TranscriptionCapability
  // only acts on `isFinal` results, so the extra interim events are
  // dropped on arrival.
  const wantsUtteranceEnd = options.utteranceEndMs != null
  const interimResults = wantsUtteranceEnd ? true : (options.interimResults ?? false)

  const params = new URLSearchParams({
    model: options.model ?? 'nova-3',
    language: options.language ?? 'en',
    encoding: options.encoding ?? 'linear16',
    sample_rate: String(options.sampleRate ?? 48_000),
    channels: String(options.channels ?? 1),
    punctuate: String(options.punctuate ?? true),
    interim_results: String(interimResults),
  })

  if (options.smartFormat) params.set('smart_format', 'true')
  if (wantsUtteranceEnd) params.set('utterance_end_ms', String(options.utteranceEndMs))
  if (options.endpointing === false) {
    params.set('endpointing', 'false')
  } else if (options.endpointing != null) {
    params.set('endpointing', String(options.endpointing))
  }
  for (const kw of options.keywords ?? []) {
    params.append('keywords', kw)
  }
  for (const kt of options.keyterms ?? []) {
    params.append('keyterms', kt)
  }
  if (options.vadEvents) params.set('vad_events', 'true')

  return `${DEEPGRAM_WS_URL}?${params}`
}

/**
 * Max bytes of PCM we'll buffer while the WebSocket is still CONNECTING.
 * At 48 kHz × 2 bytes × 1 channel (96 KB/s) this covers 5 seconds of audio —
 * more than enough to absorb a worst-case WebSocket handshake (~500 ms) and
 * still have headroom for slow networks. If a connect takes longer than 5s
 * the oldest buffered frames are dropped to prevent unbounded growth; the
 * speaker loses some early audio but the process stays bounded.
 */
const MAX_CONNECT_BUFFER_BYTES = 480 * 1024

export interface DeepgramStreamEvents {
  transcript: (event: TranscriptEvent) => void
  utteranceEnd: (event: DeepgramUtteranceEnd) => void
  error: (error: Error) => void
  close: (code: number, reason: string) => void
  open: () => void
}

export class DeepgramStreamingClient extends EventEmitter {
  private ws: WebSocket | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private _closed = false
  private _totalDurationSec = 0
  private readonly signalHandler = () => {
    void this.close()
  }

  /**
   * Audio frames received via `send()` before the WebSocket opens. The
   * caller (`TranscriptionCapability.onSpeakerData`) pushes frames the
   * instant the speaker starts talking, which is typically BEFORE the
   * handshake finishes — ~10–25 frames (200–500 ms) land here. Drained
   * to the socket in the `'open'` handler. Without this buffer, every
   * short utterance at stream-open time loses its leading half-second
   * of audio and Deepgram either fragments or misses the transcript
   * entirely, which is exactly the symptom we hit in the Phase A test
   * pass: "short phrases being lost, long lag after the first line."
   */
  private connectBuffer: Buffer[] = []
  private connectBufferBytes = 0

  constructor(
    private readonly apiKey: string,
    private readonly options: DeepgramStreamOptions = {},
  ) {
    super()
  }

  /** Connect to Deepgram WebSocket. Resolves when the connection is open. */
  async connect(): Promise<void> {
    if (this._closed) throw new Error('DeepgramStreamingClient is closed')
    if (this.ws) return

    const url = buildDeepgramUrl(this.options)

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, { headers: { Authorization: `Token ${this.apiKey}` } })

      this.ws.on('open', () => {
        this.startKeepalive()
        // Drain any frames that arrived while the handshake was in
        // progress. Done BEFORE emitting 'open' / resolving the promise
        // so the caller never sees a moment where `readyState === OPEN`
        // and the connect buffer still has content.
        this.drainConnectBuffer()
        this.emit('open')
        resolve()
      })

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'Results') {
            this.handleResult(msg as DeepgramResult)
          } else if (msg.type === 'UtteranceEnd') {
            this.emit('utteranceEnd', msg as DeepgramUtteranceEnd)
          }
        } catch {
          // Ignore non-JSON messages (keepalive acks, etc.)
        }
      })

      this.ws.on('error', (err: Error) => {
        this.stopKeepalive()
        this.emit('error', err)
        reject(err)
      })

      this.ws.on('close', (code: number, reason: Buffer) => {
        this.stopKeepalive()
        this.ws = null
        const reasonStr = reason.toString()
        this.emit('close', code, reasonStr)
      })
    })
  }

  /**
   * Send raw PCM audio data to Deepgram.
   *
   * Three-way state machine:
   *   - `_closed`              → drop (caller has torn down the stream).
   *   - WS not yet OPEN        → buffer into `connectBuffer` so early
   *                              frames during the handshake aren't lost.
   *   - WS OPEN                → write directly.
   */
  send(pcmBuffer: Buffer): void {
    if (this._closed) return
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // CONNECTING (or not yet initialized) — buffer for drain on 'open'.
      // Enforce the byte cap by dropping oldest frames when over budget,
      // so a wedged handshake can't leak memory forever.
      this.connectBuffer.push(pcmBuffer)
      this.connectBufferBytes += pcmBuffer.length
      while (this.connectBufferBytes > MAX_CONNECT_BUFFER_BYTES && this.connectBuffer.length > 1) {
        const dropped = this.connectBuffer.shift()!
        this.connectBufferBytes -= dropped.length
      }
      return
    }
    this.ws.send(pcmBuffer)
  }

  /**
   * Flush everything buffered during connect into the now-open socket.
   * Invoked from the WS `'open'` handler, before the `open` event is
   * emitted to external listeners — by the time anyone sees the stream
   * as open, the backlog is already on the wire.
   */
  private drainConnectBuffer(): void {
    if (this.connectBuffer.length === 0) return
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const frames = this.connectBuffer
    this.connectBuffer = []
    this.connectBufferBytes = 0
    for (const frame of frames) {
      this.ws.send(frame)
    }
  }

  /** Gracefully close the connection. Sends CloseStream message first. */
  async close(): Promise<void> {
    if (this._closed) return
    this._closed = true
    this.stopKeepalive()

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Deepgram expects a JSON close message to flush final results
      this.ws.send(JSON.stringify({ type: 'CloseStream' }))
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.ws?.terminate()
          resolve()
        }, 3_000)
        this.ws!.on('close', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }

    this.ws = null
  }

  /** Flush pending transcription results without closing the connection. */
  finalize(): void {
    if (this._closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ type: 'Finalize' }))
  }

  get closed(): boolean {
    return this._closed
  }

  get totalDurationSec(): number {
    return this._totalDurationSec
  }

  private handleResult(result: DeepgramResult): void {
    const alt = result.channel?.alternatives?.[0]
    if (!alt || !alt.transcript) return

    this._totalDurationSec = result.start + result.duration

    const event: TranscriptEvent = {
      transcript: alt.transcript,
      confidence: alt.confidence,
      isFinal: result.is_final,
      speechFinal: result.speech_final,
      durationSec: this._totalDurationSec,
      words: alt.words,
    }
    this.emit('transcript', event)
  }

  private startKeepalive(): void {
    this.keepaliveTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }))
      }
    }, KEEPALIVE_INTERVAL_MS)
    this.keepaliveTimer.unref()
    process.on('SIGINT', this.signalHandler)
    process.on('SIGTERM', this.signalHandler)
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
    process.off('SIGINT', this.signalHandler)
    process.off('SIGTERM', this.signalHandler)
  }
}
