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

import { createDeepgramStream, type DeepgramStreamingClient, type DeepgramTokenProvider } from '../deepgram/index.js'
import type { DeepgramWord } from '../deepgram/types.js'
import type { Logger } from '../logger.js'

/** Deepgram expects PCM at this sample rate (matches Discord Opus output). */
export const OPUS_SAMPLE_RATE = 48_000

/**
 * Deepgram fragmentation-biased tuning. Originally 4000ms in cfg-core-server
 * (#359 / 2026-04) — chosen to keep complex multi-sentence thoughts grouped
 * — but tuned down to 1500ms after live-test feedback that the 4s wait
 * before a final transcript made the live thread captions feel unresponsive.
 * 1.5s is comfortably past natural in-sentence breaths while still feeling
 * snappy when the speaker stops to think. WS connections stay open across
 * utterances (cfg-core-server#63), so finalizing more often is purely a
 * segmentation choice — the language model's session-level context is
 * unaffected.
 */
export const DEEPGRAM_STREAM_TUNING = {
  utteranceEndMs: 1500,
  /**
   * Trailing-silence threshold (ms) before Deepgram emits the final
   * transcript for a speech segment. Higher = more chance for soft
   * trailing words to register before the segment closes; too high
   * delays final delivery. 1000ms is a good compromise — earlier 500ms
   * was clipping the last 1–2 words off sentences that trailed off
   * softly. Stay under utteranceEndMs so the UtteranceEnd message
   * still fires after the final.
   */
  endpointing: 1000,
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

/**
 * Interim (in-progress) transcript event — fired as the speaker is talking,
 * before Deepgram finalizes the utterance. The text rewrites itself as more
 * audio arrives; consumers should expect to *replace* their last interim
 * render for the same speaker rather than append. Each utterance from a
 * given speaker emits a stream of interims followed by exactly one final.
 */
export interface TranscriptInterimEvent {
  speakerId: string
  speakerName: string
  transcript: string
  isRedacted: boolean
}

export interface RecordingSessionParams {
  /**
   * Deepgram token provider — resolves the websocket credential per speaker
   * (platform mints a grant token, byok returns the static key). Null
   * disables transcription entirely (record-only).
   */
  deepgramTokenProvider: DeepgramTokenProvider | null
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
   * Optional: called for each interim (non-final) transcript update so
   * consumers can render in-progress captions. Redacted speakers do NOT
   * fire this callback (their final fires as a [redacted] placeholder).
   * The same utterance can fire many interims followed by exactly one
   * final — consumers should treat each interim as a replacement for the
   * prior one keyed on speakerId.
   */
  onTranscriptInterim?: (event: TranscriptInterimEvent) => void
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

  private readonly deepgramTokenProvider: DeepgramTokenProvider | null
  private readonly deepgramModel: string
  private readonly language: string
  private readonly keywords: string[]
  private readonly keyterms: string[]
  private readonly resolveSpeakerName: (userId: string) => Promise<string>
  private readonly onTranscriptFinal: (event: TranscriptFinalEvent) => void | Promise<void>
  private readonly onTranscriptInterim: ((event: TranscriptInterimEvent) => void) | null
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

  /**
   * Per-speaker delayed-Finalize timers. Discord's voice receiver only
   * emits opus frames while a user is actively speaking — during silence
   * NO frames flow to Deepgram, so Deepgram's `utterance_end_ms` (which
   * measures silence WITHIN the audio stream) never trips, and the
   * interim live caption sits open across arbitrary wall-clock silence.
   * The next speech burst from the same user (potentially minutes
   * later) gets appended to the same utterance.
   *
   * We close the loop by scheduling a Finalize when Discord's
   * `speaking end` fires. Two cancel conditions:
   *
   *   1. SAME user speaks again within the window  → cancel (continuation)
   *   2. ANOTHER user takes the floor              → fire immediately
   *      (turn-taking — another speaker grabbing the floor is the natural
   *      end of the previous speaker's sentence)
   *
   * Calling Finalize doesn't distort timing: Deepgram emits the pending
   * final with the original word timestamps from when the audio arrived.
   */
  private readonly pendingFinalizeTimers = new Map<string, NodeJS.Timeout>()

  private sessionStartedAtMs: number | null = null

  constructor(params: RecordingSessionParams) {
    this.deepgramTokenProvider = params.deepgramTokenProvider
    this.deepgramModel = params.deepgramModel ?? 'nova-3'
    this.language = params.language ?? 'en'
    this.keywords = params.keywords ?? []
    this.keyterms = params.keyterms ?? []
    this.resolveSpeakerName = params.resolveSpeakerName
    this.onTranscriptFinal = params.onTranscriptFinal
    this.onTranscriptInterim = params.onTranscriptInterim ?? null
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

    // Turn-taking finalize bookkeeping (see pendingFinalizeTimers docs):
    //   - SAME user speaking again → cancel their pending finalize (continuation)
    //   - DIFFERENT user taking the floor → fire OTHER speakers' pending
    //     finalizes immediately (their sentence naturally ends when someone
    //     else starts talking).
    const myTimer = this.pendingFinalizeTimers.get(userId)
    if (myTimer) {
      clearTimeout(myTimer)
      this.pendingFinalizeTimers.delete(userId)
    }
    for (const [otherUserId, timer] of this.pendingFinalizeTimers) {
      clearTimeout(timer)
      this.pendingFinalizeTimers.delete(otherUserId)
      const otherStream = this.speakerStreams.get(otherUserId)
      if (otherStream && !otherStream.closed) {
        try {
          otherStream.finalize()
        } catch (err) {
          this.logger?.warn({ err, otherUserId }, 'turn-take finalize threw')
        }
      }
    }

    // Redaction gate: non-consenters never get a Deepgram stream. Track them
    // so onSpeakerEnd can emit a [redacted] placeholder (vs silently dropping).
    if (this.consentedUserIds != null && !this.consentedUserIds.has(userId)) {
      if (!this.redactedInFlight.has(userId)) {
        const startSec = (Date.now() - this.getSessionStartedAtMs()) / 1000
        this.redactedInFlight.set(userId, { sawData: false, startSec })
      }
      return
    }

    // No token provider → transcription is disabled for this session.
    // Treat consenters as a no-op (audio still captured upstream for the
    // mixdown / recording-only path; we just don't transcribe).
    if (!this.deepgramTokenProvider) return

    const existing = this.speakerStreams.get(userId)
    if (existing && !existing.closed) return

    const deepgramStream = createDeepgramStream(this.deepgramTokenProvider, {
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
      const text = ev.transcript.trim()
      if (!text) return

      // Interim: fire to the optional callback for live caption rendering
      // (consented speakers only — redacted users shouldn't have their
      // in-progress text leak even briefly). Then fall through; finals
      // continue to flow on the same event channel.
      if (!ev.isFinal) {
        const isConsented = this.consentedUserIds == null || this.consentedUserIds.has(userId)
        if (this.onTranscriptInterim && isConsented) {
          try {
            this.onTranscriptInterim({
              speakerId: userId,
              speakerName,
              transcript: text,
              isRedacted: false,
            })
          } catch (err) {
            this.logger?.warn({ err, userId }, 'onTranscriptInterim threw')
          }
        }
        return
      }

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
    //
    // Schedule a Deepgram Finalize after utteranceEndMs of wall-clock
    // silence so Deepgram emits a real final for this utterance even if
    // the speaker never speaks again (no audio = no Deepgram-side silence
    // detection). Cancelled in onSpeakerStart on resume, or fired early
    // when another speaker takes the floor.
    const stream = this.speakerStreams.get(userId)
    if (stream && !stream.closed) {
      const existing = this.pendingFinalizeTimers.get(userId)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        this.pendingFinalizeTimers.delete(userId)
        const s = this.speakerStreams.get(userId)
        if (s && !s.closed) {
          try {
            s.finalize()
          } catch (err) {
            this.logger?.warn({ err, userId }, 'silence-window finalize threw')
          }
        }
      }, DEEPGRAM_STREAM_TUNING.utteranceEndMs)
      timer.unref()
      this.pendingFinalizeTimers.set(userId, timer)
    }
  }

  /**
   * Promote a late-consenting user to an open Deepgram stream. If they had an
   * in-flight unconsented turn, emit the redacted placeholder first.
   *
   * Order matters: flip `consentedUserIds` SYNCHRONOUSLY before any await.
   * Live session bug — the user reliably starts speaking again the moment
   * they click Allow, and onSpeakerStart (called by voice-capture) checks
   * `consentedUserIds.has(userId)` to decide whether to gate as redacted
   * or open a Deepgram stream. If the consent flip happens AFTER an await
   * (e.g. after `emitRedactedIfDistinct`), that next burst gets a second
   * [redacted] cue and never transcribes. Flipping first closes the race.
   */
  async addConsentedUser(userId: string): Promise<void> {
    if (this.consentedUserIds == null) return
    this.consentedUserIds.add(userId)

    const inFlight = this.redactedInFlight.get(userId)
    this.redactedInFlight.delete(userId)
    if (inFlight?.sawData) {
      const nowSec = (Date.now() - this.getSessionStartedAtMs()) / 1000
      await this.emitRedactedIfDistinct(userId, inFlight.startSec, nowSec)
    }
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

    // Clear any pending speech-end finalize timers — we're closing the
    // streams below anyway, and the Drain step below fires Finalize on
    // every still-open stream as part of stop().
    for (const timer of this.pendingFinalizeTimers.values()) clearTimeout(timer)
    this.pendingFinalizeTimers.clear()

    // ── Drain: ask Deepgram to flush pending finals BEFORE closing ──────────
    // Deepgram only emits a final transcript for an in-progress utterance
    // when `utterance_end_ms` of silence elapses OR a CloseStream / Finalize
    // is received. If the user clicks Stop right after speech, the in-flight
    // utterance hasn't hit its silence threshold and CloseStream's
    // flush-then-close race can drop the final before our `transcript`
    // handler sees it — the VTT then comes out missing that last utterance
    // even though the user heard themselves speak it. Sending Finalize
    // first, then giving the WS a short grace window before close, gives
    // Deepgram time to deliver pending finals on the same connection.
    for (const s of this.speakerStreams.values()) {
      if (!s.closed) s.finalize()
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 800))

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
