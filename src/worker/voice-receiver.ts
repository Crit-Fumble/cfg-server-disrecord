/**
 * VoiceReceiver — SSE consumer for opus frames from core-server.
 *
 * Option B architecture (see core-server's services/disrecord/): the
 * orchestration layer holds the ReSesh bot's Discord connection and the
 * per-guild voice WSS. It subscribes to each speaker's opus stream and
 * forwards frames over SSE on:
 *
 *   GET ${coreServerUrl}/api/internal/disrecord/sessions/:installationId/audio
 *
 * SSE events:
 *   event: speaker-start     data: {"speakerId": "..."}
 *   event: speaker-data      data: {"speakerId": "...", "opus": "<base64>"}
 *   event: speaker-end       data: {"speakerId": "..."}
 *   event: session-end       data: {"reason": "..."}
 *
 * Worker decodes opus → PCM via @discordjs/opus and feeds RecordingSession.
 * Auth: per-session JWT in the Authorization header (CORE_SERVER_TOKEN env).
 * Same token gates both this SSE subscription and the worker's transcript /
 * billing / session-policy callbacks — no separate sessionToken anymore.
 */

import opus from '@discordjs/opus'
import type { Logger } from '../logger.js'
import type { RecordingSession } from './recording-session.js'
import { OPUS_SAMPLE_RATE } from './recording-session.js'

export interface VoiceReceiverParams {
  /** core-server base URL — host the SSE endpoint lives on. */
  coreServerUrl: string
  /** Per-session JWT (CORE_SERVER_TOKEN). */
  token: string
  /** Installation id — used in the audio SSE path; matched against the JWT claim. */
  installationId: string
  /** Where opus frames are decoded and fed. */
  session: RecordingSession
  logger?: Logger
  /** AbortSignal to tear down the SSE subscription. */
  abortSignal?: AbortSignal
}

interface SpeakerStartEvent {
  speakerId: string
}
interface SpeakerDataEvent {
  speakerId: string
  /** base64-encoded opus frame. */
  opus: string
}
interface SpeakerEndEvent {
  speakerId: string
}
interface SessionEndEvent {
  reason: string
}

export class VoiceReceiver {
  private decoder: opus.OpusEncoder
  private aborter: AbortController
  private donePromise: Promise<void> | null = null

  constructor(private readonly params: VoiceReceiverParams) {
    // 48 kHz, mono — matches Deepgram config in RecordingSession.
    this.decoder = new opus.OpusEncoder(OPUS_SAMPLE_RATE, 1)
    this.aborter = new AbortController()
    if (params.abortSignal) {
      params.abortSignal.addEventListener('abort', () => this.aborter.abort())
    }
  }

  /**
   * Open the SSE subscription and start dispatching events to the session.
   * Resolves when the server closes the stream (e.g. session-end event or
   * abort signal). Throws if the initial connect fails.
   */
  async run(): Promise<void> {
    const { coreServerUrl, token, installationId, logger } = this.params
    const url = `${coreServerUrl.replace(/\/$/, '')}/api/internal/disrecord/sessions/${encodeURIComponent(installationId)}/audio`

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${token}`,
      },
      signal: this.aborter.signal,
    })
    if (!res.ok) {
      throw new Error(`SSE connect ${res.status}: ${await res.text().catch(() => '')}`)
    }
    if (!res.body) {
      throw new Error('SSE body missing')
    }
    logger?.info({ installationId }, 'audio SSE connected')

    this.donePromise = this.pump(res.body)
    return this.donePromise
  }

  /** Abort the SSE subscription and wait for run() to settle. */
  async destroy(): Promise<void> {
    this.aborter.abort()
    if (this.donePromise) {
      await this.donePromise.catch(() => undefined)
    }
  }

  /**
   * Read the SSE byte stream, split into events, dispatch.
   *
   * SSE framing (per the WHATWG spec) is line-based with double-newline
   * event terminators. We accumulate a UTF-8 buffer across chunks and
   * split on \n\n.
   */
  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    // Race read() against abort. When the abort fires we cancel the reader,
    // which makes the pending read() resolve/reject and lets the loop exit
    // even if the underlying stream isn't being torn down by an upstream
    // fetch (e.g. unit-test stream).
    const onAbort = () => {
      reader.cancel().catch(() => undefined)
    }
    if (this.aborter.signal.aborted) onAbort()
    else this.aborter.signal.addEventListener('abort', onAbort, { once: true })

    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        if (this.aborter.signal.aborted) break
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          await this.dispatch(rawEvent)
        }
      }
      if (buffer.trim().length > 0 && !this.aborter.signal.aborted) {
        await this.dispatch(buffer)
      }
    } catch (err) {
      if (this.aborter.signal.aborted) {
        this.params.logger?.debug('SSE aborted')
        return
      }
      throw err
    } finally {
      this.aborter.signal.removeEventListener('abort', onAbort)
      reader.releaseLock()
    }
  }

  /** Parse one SSE event block (`event: foo\ndata: {...}`) and dispatch. */
  private async dispatch(rawEvent: string): Promise<void> {
    let eventType: string | null = null
    let data = ''
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim()
      else if (line.startsWith('data:')) {
        // Multiple `data:` lines per event concatenate with newlines (SSE spec).
        data += (data ? '\n' : '') + line.slice(5).trim()
      }
      // ignore comment lines (':') and id: / retry: for now
    }
    if (!eventType || !data) return

    try {
      switch (eventType) {
        case 'speaker-start': {
          const payload = JSON.parse(data) as SpeakerStartEvent
          await this.params.session.onSpeakerStart(payload.speakerId)
          break
        }
        case 'speaker-data': {
          const payload = JSON.parse(data) as SpeakerDataEvent
          const opusBuf = Buffer.from(payload.opus, 'base64')
          try {
            const pcm = this.decoder.decode(opusBuf)
            this.params.session.onSpeakerData(payload.speakerId, pcm)
          } catch (err) {
            this.params.logger?.debug({ err, speakerId: payload.speakerId }, 'opus decode failed (single frame)')
          }
          break
        }
        case 'speaker-end': {
          const payload = JSON.parse(data) as SpeakerEndEvent
          await this.params.session.onSpeakerEnd(payload.speakerId)
          break
        }
        case 'session-end': {
          const payload = JSON.parse(data) as SessionEndEvent
          this.params.logger?.info({ reason: payload.reason }, 'gateway signaled session-end')
          this.aborter.abort()
          break
        }
        default:
          this.params.logger?.debug({ eventType }, 'ignoring unknown SSE event')
      }
    } catch (err) {
      this.params.logger?.warn({ err, eventType }, 'failed to dispatch SSE event')
    }
  }
}
