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

/**
 * Strip any credential-shaped params before logging the URL. The current
 * code path doesn't put the key in the URL (we use the Authorization
 * header), but a future caller might, and this is defense-in-depth.
 */
function redactDeepgramUrlForLog(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.has('access_token')) parsed.searchParams.set('access_token', '[redacted]')
    if (parsed.searchParams.has('token')) parsed.searchParams.set('token', '[redacted]')
    return parsed.toString()
  } catch {
    return '[unparseable-url]'
  }
}
// Deepgram closes idle WebSocket connections after a ~10-12s inactivity
// timeout. The 2026-05-12 prod session log shows 9 mid-session closes
// across a 2-hour D&D session — every silence longer than ~10s triggered
// a reconnect, each costing 1-3s of WS handshake on the next utterance
// before audio could resume streaming. See cfg-core-server #63.
//
// 4s gives 6-8s of headroom against the 10-12s timeout, comfortably
// absorbing network jitter. Lower (3s) is also documented by Deepgram
// but felt unnecessarily chatty; 4s is the sweet spot in practice.
const KEEPALIVE_INTERVAL_MS = 4_000

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
  // Nova-3 does not support the `keywords` parameter — it requires
  // `keyterm` (singular, repeated) instead. Sending `keywords` with
  // `model=nova-3` causes Deepgram to reject the WebSocket handshake
  // with HTTP 400, which silently bricks transcription for every
  // campaign-bound session (composeTranscriptionKeywords always
  // produces single-word boosts in the `keywords` channel for D&D-style
  // proper-noun sets). For Nova-3 we fold any `keywords` into the
  // keyterm list with the `:boost` suffix stripped — Nova-3's keyterm
  // boost is fixed at the API level and doesn't honor per-term weights.
  //
  // See https://developers.deepgram.com/docs/keyterm and
  // https://developers.deepgram.com/docs/keywords (which calls out the
  // Nova-3 exclusion explicitly).
  const model = options.model ?? 'nova-3'
  const isNova3 = model === 'nova-3'
  const collectedKeyterms: string[] = []
  for (const kw of options.keywords ?? []) {
    if (isNova3) {
      // Strip the `:boost` suffix (last :digits) and trim. Empty entries
      // are dropped so an accidental trailing comma in the keyword list
      // doesn't produce an empty `keyterm=` that Deepgram will also
      // reject as 400.
      const bare = kw.replace(/:\d+$/, '').trim()
      if (bare) collectedKeyterms.push(bare)
    } else {
      params.append('keywords', kw)
    }
  }
  for (const kt of options.keyterms ?? []) {
    const trimmed = kt.trim()
    if (trimmed) collectedKeyterms.push(trimmed)
  }
  // Dedupe case-insensitively before emitting so the URL stays compact
  // and Deepgram doesn't see duplicate boosts (no functional issue, but
  // wasted bytes on long campaign sets).
  const seen = new Set<string>()
  for (const term of collectedKeyterms) {
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    params.append('keyterm', term)
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

      // Capture Deepgram's response body on a failed handshake. The
      // default `ws` library swallows the body — it only surfaces
      // "Unexpected server response: 400", which is useless for
      // debugging which URL parameter Deepgram is rejecting. With
      // `unexpected-response`, we read the body ourselves and attach it
      // to the error before propagating, so the actual Deepgram
      // diagnostic ("model X does not support parameter Y", "invalid
      // value for Z", etc.) lands in our logs.
      this.ws.on('unexpected-response', (_req, res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 2000)
          const wsErr = new Error(
            `Deepgram handshake rejected (HTTP ${res.statusCode}): ${body || '<empty body>'} | url=${redactDeepgramUrlForLog(url)}`,
          )
          this.stopKeepalive()
          // Mirror the close-without-open lifecycle so callers see a
          // single failure surface (error → reject → emit 'error').
          this.emit('error', wsErr)
          reject(wsErr)
        })
        res.on('error', () => {
          const wsErr = new Error(
            `Deepgram handshake rejected (HTTP ${res.statusCode}): <body read failed> | url=${redactDeepgramUrlForLog(url)}`,
          )
          this.stopKeepalive()
          this.emit('error', wsErr)
          reject(wsErr)
        })
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
