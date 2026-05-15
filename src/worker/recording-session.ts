/**
 * RecordingSession — per-session orchestrator that fans out per-speaker PCM
 * audio to Deepgram and emits finalized transcripts via callback.
 *
 * Ported from cfg-core-server's TranscriptionCapability (#119), trimmed of
 * CFG-internal coupling: no MessageBatcher (caller handles output), no SSE
 * publish (caller hooks via callback), no perf-burst instrumentation (added
 * later if needed). Carries the cfg-core-server#63 fix forward — streams
 * stay open across silence, only torn down on `stop()` or mid-session decline.
 *
 * The session-level concerns (Discord voice connection, opus → PCM decode,
 * speaker subscribe/unsubscribe) live in voice-receiver.ts and call this
 * class's onSpeakerStart/onSpeakerData/onSpeakerEnd methods.
 */

import { createDeepgramStream, type DeepgramStreamingClient } from '../deepgram/index.js'
import type { DeepgramWord } from '../deepgram/types.js'
import type { Logger } from '../logger.js'

/** Deepgram expects PCM at this sample rate (matches Discord Opus output). */
export const OPUS_SAMPLE_RATE = 48_000

/**
 * Deepgram fragmentation-biased tuning — locked in cfg-core-server (#359)
 * after the 2026-04 session analysis. Don't touch without a real session test.
 */
export const DEEPGRAM_STREAM_TUNING = {
  /** Hold mid-thought pauses inside the same utterance longer. */
  utteranceEndMs: 4000,
  /** VAD endpoint sensitivity at real sentence boundaries. */
  endpointing: 500,
  /** Deepgram per-frame speech-detection telemetry; not consumed yet. */
  vadEvents: true,
} as const

export interface TranscriptFinalEvent {
  speakerId: string
  speakerName: string
  transcript: string
  isRedacted: boolean
  startSec: number
  endSec: number
  words: DeepgramWord[]
}

export interface RecordingSessionParams {
  /** Deepgram API key. Null disables transcription entirely. */
  deepgramApiKey: string | null
  /** Defaults to 'nova-3'. */
  deepgramModel?: string
  /** Defaults to 'en'. */
  language?: string
  keywords?: string[]
  keyterms?: string[]
  /** Resolve a Discord user ID to a display name. Cached per-session. */
  resolveSpeakerName: (userId: string) => Promise<string>
  /** Called once per finalized transcript (consented + redacted placeholders). */
  onTranscriptFinal: (event: TranscriptFinalEvent) => void | Promise<void>
  /**
   * Consent set. When provided, speakers NOT in the set are redacted — a
   * single `[redacted]` placeholder is emitted per turn instead of opening
   * a Deepgram stream. When null/undefined, no redaction (all speakers
   * transcribed verbatim).
   */
  consentedUserIds?: Set<string>
  logger?: Logger
}

export class RecordingSession {
  /**
   * Pause flag. Public for legacy tests; callers should prefer `setPaused()`
   * so they get the side-effect cleanup (flush in-flight bursts, close
   * Deepgram streams). `onSpeakerData` short-circuits on `paused` regardless
   * of how it was set.
   */
  public paused = false

  private readonly deepgramApiKey: string | null
  private readonly deepgramModel: string
  private readonly language: string
  private readonly keywords: string[]
  private readonly keyterms: string[]
  private readonly resolveSpeakerName: (userId: string) => Promise<string>
  private readonly onTranscriptFinal: (event: TranscriptFinalEvent) => void | Promise<void>
  private readonly consentedUserIds: Set<string> | null
  private readonly logger: Logger | null

  private readonly speakerStreams = new Map<string, DeepgramStreamingClient>()
  private readonly speakerNames = new Map<string, string>()
  private readonly streamOpenedAtMs = new Map<string, number>()

  /**
   * Speakers whose current turn is being redacted (not transcribed). Set on
   * onSpeakerStart for a non-consenter, consumed on onSpeakerEnd to emit
   * exactly one placeholder. `sawData` gates the placeholder so start-then-
   * immediate-end glitches don't emit empty redacted markers.
   */
  private readonly redactedInFlight = new Map<string, { sawData: boolean; startSec: number }>()

  /**
   * Last `[redacted]` emit timestamp per speaker, in session seconds. Used
   * to coalesce a single human "speech run" — Discord fires speaker-end on
   * every brief pause, which would emit one `[redacted]` line per burst
   * (visible as `[redacted]: [redacted]\n[redacted]: [redacted]\n…` in the
   * thread). We suppress redundant markers within `REDACTION_COALESCE_SEC`
   * of the previous one so callers see one line per actual run of speech.
   */
  private readonly lastRedactedEmitSec = new Map<string, number>()

  /**
   * Seconds of silence before a non-consenter's next burst is treated as a
   * new redaction run (and gets its own `[redacted]` marker). Tuned to
   * match Discord's typical speaker-end debounce (~1-2s) plus headroom —
   * anything inside this window collapses to the existing marker.
   */
  private static readonly REDACTION_COALESCE_SEC = 10

  private sessionStartedAtMs: number | null = null

  constructor(params: RecordingSessionParams) {
    this.deepgramApiKey = params.deepgramApiKey
    this.deepgramModel = params.deepgramModel ?? 'nova-3'
    this.language = params.language ?? 'en'
    this.keywords = params.keywords ?? []
    this.keyterms = params.keyterms ?? []
    this.resolveSpeakerName = params.resolveSpeakerName
    this.onTranscriptFinal = params.onTranscriptFinal
    this.consentedUserIds = params.consentedUserIds ?? null
    this.logger = params.logger ?? null
  }

  /** Wall-clock anchor for all caption startSec values, lazily set. */
  private getSessionStartedAtMs(): number {
    if (this.sessionStartedAtMs === null) {
      this.sessionStartedAtMs = Date.now()
    }
    return this.sessionStartedAtMs
  }

  /**
   * Toggle pause. When paused:
   *   - `onSpeakerData` short-circuits (no audio to Deepgram, no audio
   *     would land in a future mp3 mix)
   *   - any in-flight redaction trackers are cleared so a paused-during
   *     burst doesn't emit a delayed `[redacted]` marker on resume
   *   - live Deepgram streams are left open (avoids 1-3s reconnect cost
   *     on resume — they just receive no frames while paused)
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    if (paused) {
      // Discard any partial redacted turns — we can't honestly mark them
      // and the next post-pause burst will start a fresh tracker anyway.
      this.redactedInFlight.clear()
    }
  }

  async onSpeakerStart(userId: string): Promise<void> {
    // Pause gate: ignore all speaker activity while paused. The worker
    // honoring this matches the legacy in-process pause: no transcripts,
    // no audio, no `[redacted]` markers from the pause window.
    if (this.paused) return

    // Redaction gate: non-consenters never get a Deepgram stream. Track them
    // so onSpeakerEnd can emit a [redacted] placeholder (vs silently dropping).
    if (this.consentedUserIds != null && !this.consentedUserIds.has(userId)) {
      if (!this.redactedInFlight.has(userId)) {
        const startSec = (Date.now() - this.getSessionStartedAtMs()) / 1000
        this.redactedInFlight.set(userId, { sawData: false, startSec })
      }
      return
    }

    // No Deepgram key → transcription is disabled for this session.
    // Treat consenters as a no-op (audio still captured upstream for the
    // mixdown / recording-only path; we just don't transcribe).
    if (!this.deepgramApiKey) return

    const existing = this.speakerStreams.get(userId)
    if (existing && !existing.closed) return

    const deepgramStream = createDeepgramStream(this.deepgramApiKey, {
      model: this.deepgramModel,
      language: this.language,
      encoding: 'linear16',
      sampleRate: OPUS_SAMPLE_RATE,
      channels: 1,
      smartFormat: true,
      utteranceEndMs: DEEPGRAM_STREAM_TUNING.utteranceEndMs,
      endpointing: DEEPGRAM_STREAM_TUNING.endpointing,
      vadEvents: DEEPGRAM_STREAM_TUNING.vadEvents,
      keywords: this.keywords.length > 0 ? this.keywords : undefined,
      keyterms: this.keyterms.length > 0 ? this.keyterms : undefined,
    })

    this.speakerStreams.set(userId, deepgramStream)
    this.getSessionStartedAtMs()
    this.streamOpenedAtMs.set(userId, Date.now())

    if (!this.speakerNames.has(userId)) {
      this.speakerNames.set(userId, await this.resolveSpeakerName(userId))
    }
    const speakerName = this.speakerNames.get(userId)!

    deepgramStream.on('transcript', (ev) => {
      if (!ev.isFinal || !ev.transcript.trim()) return

      // Globalize per-speaker timestamps once, so all consumers see the
      // same time origin. Deepgram words[i].start is relative to per-
      // speaker stream open; we offset by (streamOpened - sessionStart).
      const streamOpenedAtMs = this.streamOpenedAtMs.get(userId) ?? Date.now()
      const speakerOffsetSec = (streamOpenedAtMs - this.getSessionStartedAtMs()) / 1000
      const globalStartSec =
        ev.words.length > 0 ? speakerOffsetSec + ev.words[0].start : speakerOffsetSec
      const endSec =
        ev.words.length > 0
          ? speakerOffsetSec + ev.words[ev.words.length - 1].end
          : (Date.now() - this.getSessionStartedAtMs()) / 1000

      void this.emit({
        speakerId: userId,
        speakerName,
        transcript: ev.transcript,
        isRedacted: false,
        startSec: globalStartSec,
        endSec: Math.max(endSec, globalStartSec + 0.1),
        words: ev.words,
      })
    })

    deepgramStream.on('error', (err) => {
      this.logger?.error({ err, userId }, 'deepgram stream error')
    })

    deepgramStream.on('close', (code, reason) => {
      this.logger?.info({ userId, code, reason }, 'deepgram WS closed — next utterance will reopen')
      this.speakerStreams.delete(userId)
    })

    try {
      await deepgramStream.connect()
    } catch (err) {
      this.logger?.error({ err, userId }, 'failed to connect to deepgram')
      this.speakerStreams.delete(userId)
    }
  }

  onSpeakerData(userId: string, pcmMono: Buffer): void {
    if (this.paused) return

    const stream = this.speakerStreams.get(userId)
    if (stream && !stream.closed) {
      stream.send(pcmMono)
      return
    }

    // Frame for an unconsented speaker — note that real audio arrived so
    // onSpeakerEnd emits the placeholder.
    const inFlight = this.redactedInFlight.get(userId)
    if (inFlight) inFlight.sawData = true

    // Consent flipped mid-burst race: addConsentedUser called but the
    // next onSpeakerStart hasn't fired yet. Open the stream now; current
    // frame is dropped during handshake but subsequent frames land OK.
    if (this.consentedUserIds != null && this.consentedUserIds.has(userId)) {
      this.redactedInFlight.delete(userId)
      void this.onSpeakerStart(userId)
    }
  }

  async onSpeakerEnd(userId: string): Promise<void> {
    if (this.paused) return
    const inFlight = this.redactedInFlight.get(userId)
    if (inFlight) {
      this.redactedInFlight.delete(userId)
      if (inFlight.sawData) {
        const endSec = (Date.now() - this.getSessionStartedAtMs()) / 1000
        await this.emitRedactedIfDistinct(userId, inFlight.startSec, endSec)
      }
    }

    // Keep the Deepgram WS open across silence — the keepalive frame holds
    // it open on Deepgram's side, and closing-then-reopening on per-utterance
    // basis cost 1-3s of reconnect handshake on the next utterance
    // (cfg-core-server#63 — visible 9× in 2026-05-12 prod log).
  }

  /**
   * Promote a late-consenting user to an open Deepgram stream. If they had an
   * in-flight unconsented turn, emit the redacted placeholder first.
   */
  async addConsentedUser(userId: string): Promise<void> {
    if (this.consentedUserIds == null) return
    const inFlight = this.redactedInFlight.get(userId)
    this.redactedInFlight.delete(userId)
    if (inFlight?.sawData) {
      const nowSec = (Date.now() - this.getSessionStartedAtMs()) / 1000
      await this.emitRedactedIfDistinct(userId, inFlight.startSec, nowSec)
    }
    this.consentedUserIds.add(userId)
    const existing = this.speakerStreams.get(userId)
    if (existing && !existing.closed) return
    await this.onSpeakerStart(userId)
  }

  /** Mid-session opt-out. Closes the user's live stream and gates future turns. */
  addDeclinedUser(userId: string): void {
    if (this.consentedUserIds == null) return
    this.consentedUserIds.delete(userId)
    this.redactedInFlight.delete(userId)
    const stream = this.speakerStreams.get(userId)
    if (stream && !stream.closed) {
      void stream.close().catch((err) => {
        this.logger?.warn({ err, userId }, 'failed to close stream on mid-session decline')
      })
    }
    this.speakerStreams.delete(userId)
  }

  /** Tear down all streams and flush any in-flight redacted turns. */
  async stop(): Promise<void> {
    const stopSec = (Date.now() - this.getSessionStartedAtMs()) / 1000
    for (const [userId, inFlight] of this.redactedInFlight) {
      if (!inFlight.sawData) continue
      await this.emitRedactedIfDistinct(userId, inFlight.startSec, stopSec)
    }
    this.redactedInFlight.clear()
    this.lastRedactedEmitSec.clear()

    const closes = Array.from(this.speakerStreams.values()).map((s) => s.close())
    await Promise.allSettled(closes)
    this.speakerStreams.clear()
  }

  private async emit(event: TranscriptFinalEvent): Promise<void> {
    try {
      await this.onTranscriptFinal(event)
    } catch (err) {
      this.logger?.error({ err, speakerId: event.speakerId }, 'onTranscriptFinal threw')
    }
  }

  /**
   * Emit a `[redacted]` marker for `userId` only if there hasn't been one
   * for the same speaker within `REDACTION_COALESCE_SEC`. Discord's
   * speaker-end fires on every short pause, so without this gate one
   * continuous run of speech becomes a wall of `[redacted]: [redacted]`
   * lines in the transcript thread.
   *
   * When suppressed, we still update `lastRedactedEmitSec` to the new
   * `endSec` so the suppression window slides — i.e. as long as the user
   * keeps talking, no new markers; once they actually go silent for the
   * full window, the next burst gets its own marker.
   */
  private async emitRedactedIfDistinct(userId: string, startSec: number, endSec: number): Promise<void> {
    const lastEmitSec = this.lastRedactedEmitSec.get(userId)
    if (lastEmitSec !== undefined && startSec - lastEmitSec < RecordingSession.REDACTION_COALESCE_SEC) {
      // Slide the window — the user is still in a continuous speech run.
      this.lastRedactedEmitSec.set(userId, endSec)
      return
    }
    this.lastRedactedEmitSec.set(userId, endSec)
    await this.emit({
      speakerId: userId,
      speakerName: '[redacted]',
      transcript: '[redacted]',
      isRedacted: true,
      startSec,
      endSec: Math.max(endSec, startSec + 0.1),
      words: [],
    })
  }
}
