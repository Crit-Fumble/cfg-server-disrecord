/**
 * SessionController — per-recording orchestrator for the standalone container.
 *
 * Owns one recording's full lifecycle: a {@link VoiceCapture} (Discord voice
 * connection), a {@link PcmCapture} (mp3-mix disk writer), a
 * {@link RecordingSession} (per-speaker Deepgram transcription), and a
 * {@link ConsentManager} (in-Discord button consent). Replaces core-server's
 * `disrecord/index.ts` role for a single session.
 *
 * Lifecycle:
 *   start()  → mkdir temp → join voice → post initial consent prompt
 *   pause()  → gate audio + transcription
 *   resume() → un-gate
 *   stop()   → leave voice → finalize PCM → mix → VTT → sink → post thread
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Client } from 'discord.js'
import { VoiceCapture } from '../gateway/voice-capture.js'
import { PcmCapture } from './pcm-capture.js'
import { RecordingSession, type TranscriptFinalEvent, type TranscriptInterimEvent } from './recording-session.js'
import { buildDeepgramTokenProvider } from '../deepgram/index.js'
import { ConsentManager } from '../consent/consent-manager.js'
import { processRecording } from './post-process.js'
import { createRecordingThread, postRecording, tempDirOf } from '../discord/thread-poster.js'
import { ConsentSync } from '../phone-home/consent-sync.js'
import type { CoreServerClient } from '../phone-home/core-client.js'
import type { CfgHostedConfig } from '../config.js'
import type { OutputSink } from './output-sink.js'
import type { CaptionEntry } from './caption-types.js'
import type { Logger } from '../logger.js'

/**
 * Periodic CT billing tick cadence. 15 min matches core-server's existing
 * uptime-tick cadence (ported from the legacy `worker.ts`).
 */
const BILLING_TICK_MINUTES = 15

export type SessionStatus = 'starting' | 'recording' | 'paused' | 'stopping' | 'stopped' | 'failed'

export interface SessionControllerParams {
  recordingId: string
  client: Client
  guildId: string
  voiceChannelId: string
  /** Text channel for the thread + consent prompt. Defaults to voice channel. */
  textChannelId: string
  /** Whether live transcription is enabled. */
  transcription: boolean
  /**
   * Deepgram credential mode. `platform` mints grant tokens from core-server;
   * `byok` uses `deepgramKey` directly; `disabled` ⇒ record-only.
   */
  deepgramMode: 'platform' | 'byok' | 'disabled'
  /** Static Deepgram key — used only for `deepgramMode='byok'`. */
  deepgramKey: string | null
  deepgramModel: string
  deepgramLanguage: string
  /** Output sink for the finalized mp3 + VTT. */
  sink: OutputSink
  /** Discord user id of the invoker — pre-consented. */
  invokerUserId?: string
  /**
   * CFG-hosted config. Present ⇒ the controller wires billing ticks,
   * consent-sync, and transcript phone-home. Absent ⇒ pure self-host.
   */
  cfg?: CfgHostedConfig
  /**
   * Phone-home client. Always supplied; it is a no-op client when self-host
   * (see {@link CoreServerClient}). The controller only wires the
   * billing/consent/transcript paths when `cfg` is also present.
   */
  core: CoreServerClient
  logger: Logger
}

export class SessionController {
  public readonly recordingId: string
  public readonly guildId: string
  public readonly voiceChannelId: string
  public readonly startedAt = Date.now()

  private status: SessionStatus = 'starting'
  private readonly logger: Logger
  private readonly params: SessionControllerParams

  private tempDir = ''
  private consent!: ConsentManager
  private pcmCapture!: PcmCapture
  private session!: RecordingSession
  private voice!: VoiceCapture
  private readonly captions: CaptionEntry[] = []
  private threadId: string | null = null

  /** CFG-hosted consent bridge — only constructed when `cfg` is present. */
  private consentSync: ConsentSync | null = null
  /** Billing-tick timer — only armed when `cfg` is present. */
  private billingTimer: NodeJS.Timeout | null = null
  /** Epoch ms of the last billing tick — slides forward across paused windows. */
  private lastBillingTickAt = 0
  /**
   * Whether this session incurs the separate `transcription` surcharge tick.
   * True only when CFG-hosted with `transcriptionCtPerMinute` set (platform
   * Deepgram key) AND transcription is actually active for the session.
   */
  private transcriptionBilled = false
  /**
   * Flipped true the first time a transcript event arrives. Gates the
   * transcription surcharge tick alongside {@link transcriptionBilled} — if
   * the platform Deepgram grant fails (or any other reason transcription
   * silently breaks), no captions ever flow and the user is NOT charged
   * the surcharge. If transcription delivers at any point in the session,
   * the full session bills at the surcharge rate (lenient: they got value).
   */
  private transcriptionDelivered = false

  /**
   * Live-caption interim-message tracking. Each speaker can have ONE
   * in-flight interim message at a time — first interim from a fresh
   * utterance POSTs a new Discord message (italic, "being said"),
   * subsequent interims for the same utterance EDIT that message, and
   * the final REPLACES the italic with the corrected non-italic text
   * and clears the slot so the next utterance posts a fresh message.
   */
  private interimMessageIds = new Map<string, string>()
  /** Per-speaker throttle so we don't spam Discord edits on every interim. */
  private interimLastEditAt = new Map<string, number>()
  /** Last interim text per speaker — avoids edits when nothing actually changed. */
  private interimLastText = new Map<string, string>()
  /** Minimum gap between consecutive edits per speaker (ms). Stays under Discord's 5/5s edit limit. */
  private readonly INTERIM_EDIT_THROTTLE_MS = 800

  constructor(params: SessionControllerParams) {
    this.params = params
    this.recordingId = params.recordingId
    this.guildId = params.guildId
    this.voiceChannelId = params.voiceChannelId
    this.logger = params.logger
  }

  /** Build the pipeline, join voice, and post the initial consent prompt. */
  async start(): Promise<void> {
    const p = this.params
    this.tempDir = await mkdtemp(join(tmpdir(), `disrecord-${this.recordingId}-`))

    this.consent = new ConsentManager({
      recordingId: this.recordingId,
      client: p.client,
      textChannelId: p.textChannelId,
      mirrorChannelId: p.textChannelId !== p.voiceChannelId ? p.voiceChannelId : undefined,
      initialConsented: p.invokerUserId ? [p.invokerUserId] : [],
      logger: this.logger,
    })

    this.pcmCapture = new PcmCapture({
      recordingId: this.recordingId,
      tempDir: this.tempDir,
      consent: this.consent,
      logger: this.logger,
    })

    // Build the Deepgram token provider for this session. When transcription
    // is off for the session the mode collapses to 'disabled' ⇒ null
    // provider ⇒ record-only. Platform mode mints short-lived grant tokens
    // from core-server per per-speaker websocket; byok uses the static key.
    const effectiveMode = p.transcription ? p.deepgramMode : 'disabled'
    const tokenProvider = buildDeepgramTokenProvider({
      mode: effectiveMode,
      staticKey: p.deepgramKey ?? undefined,
      core: p.core,
      logger: this.logger,
    })
    this.session = new RecordingSession({
      deepgramTokenProvider: tokenProvider,
      deepgramModel: p.deepgramModel,
      language: p.deepgramLanguage,
      consentedUserIds: this.consent.consentedIds(),
      resolveSpeakerName: (userId) => this.resolveSpeakerName(userId),
      onTranscriptFinal: (event: TranscriptFinalEvent) => this.onTranscript(event),
      onTranscriptInterim: (event: TranscriptInterimEvent) => this.onInterim(event),
      logger: this.logger,
    })
    // Keep the RecordingSession consent set in sync with the manager.
    this.consent.onConsent((userId) => void this.session.addConsentedUser(userId))
    this.consent.onDecline((userId) => this.session.addDeclinedUser(userId))

    // ── CFG-hosted: seed consent from core-server's session policy ──────────
    // Runs before voice-join so the consent set is populated by the time the
    // first speaker frame arrives. Best-effort — a fetch failure just leaves
    // everyone opt-out until they click the Discord button.
    if (p.cfg) {
      this.consentSync = new ConsentSync({ consent: this.consent, core: p.core, logger: this.logger })
      await this.consentSync.seedFromPolicy()
    }

    this.voice = new VoiceCapture({
      client: p.client,
      guildId: p.guildId,
      voiceChannelId: p.voiceChannelId,
      session: this.session,
      pcmCapture: this.pcmCapture,
      consent: this.consent,
      logger: this.logger,
    })
    await this.voice.join()

    // Look up voice members up front — used for thread invites, the
    // announcement ping list, and the consent-prompt loop below.
    const memberIds = await this.voiceMemberIds(p.client)

    // Create the live thread NOW (private — only the invoker + current
    // voice members get added, so the recording artifact + transcripts
    // are visible only to people who were in the call). When
    // transcription is on, captions stream into it; on stop the mp3 is
    // attached to this same thread instead of creating a new one.
    // Best-effort — `createRecordingThread` returns null on failure and
    // `deliver` falls back to posting in the parent channel.
    const voiceChannelName = await this.voiceChannelName(p.client)
    const threadMembers = Array.from(new Set([p.invokerUserId, ...memberIds].filter((id): id is string => !!id)))
    this.threadId = await createRecordingThread(
      p.client,
      p.textChannelId,
      voiceChannelName,
      p.transcription,
      threadMembers,
      this.logger,
    )

    // Post the session-start announcement INSIDE the (private) thread —
    // pings the invoker + every voice member so they all get a Discord
    // notification pointing at the thread. The invoker is auto-consented
    // (pre-seeded via `initialConsented` above), so this message carries
    // no consent buttons; per-member consent prompts go out below for
    // everyone else in voice.
    if (p.invokerUserId) {
      await this.consent.postSessionStart(p.invokerUserId, this.threadId, p.transcription, memberIds)
    }

    // Prompt everyone currently in the voice channel. The invoker is already
    // in `initialConsented` so they're skipped — only OTHER members see a
    // consent prompt.
    await this.consent.promptInitial(memberIds)

    this.status = 'recording'

    // ── CFG-hosted: arm the pause-aware billing tick ────────────────────────
    // The separate `transcription` surcharge tick fires only when the
    // platform Deepgram key is in use (`transcriptionCtPerMinute` set) AND
    // transcription is actually running for this session. BYOK or disabled
    // transcription ⇒ server uptime only, no surcharge.
    this.transcriptionBilled =
      p.cfg?.transcriptionCtPerMinute != null && effectiveMode === 'platform'
    if (p.cfg) this.startBillingTimer()

    this.logger.info(
      { recordingId: this.recordingId, guildId: this.guildId, transcription: tokenProvider != null },
      'recording session started',
    )
  }

  pause(): void {
    if (this.status !== 'recording') return
    this.status = 'paused'
    this.pcmCapture.setPaused(true)
    this.session.setPaused(true)
    this.logger.info({ recordingId: this.recordingId }, 'recording paused')
  }

  resume(): void {
    if (this.status !== 'paused') return
    this.status = 'recording'
    this.pcmCapture.setPaused(false)
    this.session.setPaused(false)
    this.logger.info({ recordingId: this.recordingId }, 'recording resumed')
  }

  /**
   * Apply a consent update pushed by core-server (CFG-hosted only). No-op
   * when this session has no consent-sync wired (self-host).
   */
  pushConsent(userId: string, consented: boolean): void {
    this.consentSync?.applyPushedUpdate(userId, consented)
  }

  /**
   * Arm the periodic CT billing tick. Pause-aware: while the session is
   * paused we slide `lastBillingTickAt` forward so the user isn't billed
   * for the paused window (ported from the legacy `worker.ts` cadence).
   *
   * Two ticks ride the SAME cadence: the `server_uptime` tick (always, when
   * CFG-hosted — the skill-server container's by-instance-size uptime) and
   * the `transcription` surcharge tick (only when this session is on the
   * platform Deepgram key — see `transcriptionBilled`).
   */
  private startBillingTimer(): void {
    const cfg = this.params.cfg
    if (!cfg) return
    this.lastBillingTickAt = Date.now()
    const timer = setInterval(() => {
      if (this.status === 'paused') {
        this.lastBillingTickAt = Date.now()
        return
      }
      const now = Date.now()
      const minutes = (now - this.lastBillingTickAt) / 60_000
      this.lastBillingTickAt = now
      this.postBillingTicks(minutes, false)
    }, BILLING_TICK_MINUTES * 60_000)
    timer.unref()
    this.billingTimer = timer
  }

  /** Stop the billing timer and post a final partial-minute tick. */
  private async stopBillingTimer(): Promise<void> {
    const cfg = this.params.cfg
    if (this.billingTimer) {
      clearInterval(this.billingTimer)
      this.billingTimer = null
    }
    if (!cfg) return
    const finalMinutes = (Date.now() - this.lastBillingTickAt) / 60_000
    if (finalMinutes > 0) await this.postBillingTicks(finalMinutes, true)
  }

  /**
   * Post the billing tick(s) for `minutes` of active (non-paused) recording.
   * Always posts the `server_uptime` tick (skill-server container uptime,
   * billed by instance size); additionally posts a separate itemized
   * `transcription` surcharge tick when this session runs on the platform
   * Deepgram key (`transcriptionBilled`).
   */
  private postBillingTicks(minutes: number, final: boolean): void {
    const cfg = this.params.cfg
    if (!cfg) return
    const suffix = final ? `final ${minutes.toFixed(1)} min` : `${minutes.toFixed(1)} min`
    void this.params.core.postBillingTick({
      resourceType: 'server_uptime',
      minutes,
      ctPerMinute: cfg.ctPerMinute,
      label: `Recording Server (${cfg.size}): ${suffix}`,
    })
    // Transcription tick is gated on both INTENT (transcriptionBilled, set at
    // start from `effectiveMode === 'platform'`) AND DELIVERY
    // (transcriptionDelivered, flipped the first time a transcript event
    // arrives). If the platform grant fails or Deepgram is otherwise broken,
    // no transcripts flow, transcriptionDelivered stays false, and the
    // surcharge is never posted — the user only pays server_uptime.
    if (this.transcriptionBilled && this.transcriptionDelivered && cfg.transcriptionCtPerMinute != null) {
      void this.params.core.postBillingTick({
        resourceType: 'transcription',
        minutes,
        ctPerMinute: cfg.transcriptionCtPerMinute,
        label: `Live Transcription: ${suffix}`,
      })
    }
  }

  /**
   * Stop the session: leave voice, finalize PCM, mix mp3, generate VTT,
   * store via the sink, and post the result into Discord. Runs to
   * completion — callers that need a fast HTTP response should not await it.
   */
  async stop(): Promise<void> {
    if (this.status === 'stopped' || this.status === 'stopping') return
    this.status = 'stopping'
    this.logger.info({ recordingId: this.recordingId }, 'recording stopping')

    this.consent.stop()
    this.voice.leave('session-stop')
    await this.pcmCapture.onSessionStop()
    await this.session.stop()

    // CFG-hosted: stop the billing timer + post the final partial-minute
    // tick. Best-effort — a failed tick must not block post-processing.
    await this.stopBillingTimer().catch((err) =>
      this.logger.warn({ err, recordingId: this.recordingId }, 'final billing tick failed'),
    )

    try {
      const result = await processRecording(
        this.recordingId,
        this.pcmCapture.getResult(),
        this.params.sink,
        {
          guildId: this.guildId,
          voiceChannelId: this.voiceChannelId,
          durationMs: Date.now() - this.startedAt,
          speakerCount: this.pcmCapture.speakerCount,
          transcription: this.params.transcription,
        },
        this.logger,
        {
          captions: this.captions.length > 0 ? this.captions : undefined,
          redactedSpeakerIds: this.redactedSpeakerIds(),
        },
      )
      if (result) {
        await this.deliver(result)
      } else {
        this.logger.warn({ recordingId: this.recordingId }, 'nothing recorded — no output produced')
      }
    } catch (err) {
      this.status = 'failed'
      this.logger.error({ err, recordingId: this.recordingId }, 'post-processing failed')
    } finally {
      await rm(this.tempDir, { recursive: true, force: true }).catch(() => {})
      if (this.status !== 'failed') this.status = 'stopped'
      this.logger.info({ recordingId: this.recordingId }, 'recording session stopped')
    }
  }

  /** Snapshot for the control API. */
  describe(): {
    recordingId: string
    guildId: string
    voiceChannelId: string
    status: SessionStatus
    startedAt: number
    speakerCount: number
    paused: boolean
  } {
    return {
      recordingId: this.recordingId,
      guildId: this.guildId,
      voiceChannelId: this.voiceChannelId,
      status: this.status,
      startedAt: this.startedAt,
      speakerCount: this.pcmCapture?.speakerCount ?? 0,
      paused: this.status === 'paused',
    }
  }

  private async deliver(result: Awaited<ReturnType<typeof processRecording>>): Promise<void> {
    if (!result) return
    const p = this.params
    // Reuse the thread created at session start so the mp3 lands in the same
    // place live captions streamed into. If start-time thread creation failed
    // (`threadId === null`), fall back to posting in the parent channel — the
    // same fallback `createRecordingThread` already enforces.
    const target = this.threadId ?? p.textChannelId
    await postRecording(
      p.client,
      target,
      this.recordingId,
      tempDirOf(result.mp3Path),
      result,
      result.captions,
      this.redactedSpeakerIds(),
      this.logger,
    )
  }

  private onTranscript(event: TranscriptFinalEvent): void {
    // First delivered transcript flips the gate that lets the transcription
    // surcharge bill. Set BEFORE pushing the caption so a tick that fires
    // concurrently with the first event still sees the flag.
    this.transcriptionDelivered = true
    this.captions.push({
      speakerName: event.speakerName,
      speakerId: event.speakerId,
      transcript: event.transcript,
      words: event.words,
      startSec: event.startSec,
      endSec: event.endSec,
    })

    // Stream the finalized utterance into the live thread (best-effort).
    // Redacted utterances are skipped — surfacing a non-consenting speaker's
    // words would defeat the redaction. The VTT posted at stop still
    // includes the complete record.
    //
    // If we already posted an interim message for this speaker's in-flight
    // utterance, EDIT it to the final (corrected) text in non-italic form
    // and clear the slot. Otherwise post a fresh final message.
    if (this.threadId && !event.isRedacted) {
      void this.postOrEditFinal(event)
    }

    // CFG-hosted: phone the finalized utterance home so core-server can
    // persist it + fan out the live-caption SSE. No-op self-host (the
    // core client is a no-op when `cfg` is absent), best-effort otherwise.
    if (this.params.cfg) {
      void this.params.core.postTranscript({
        speakerId: event.speakerId,
        speakerName: event.speakerName,
        transcript: event.transcript,
        isRedacted: event.isRedacted,
        startSec: event.startSec,
        endSec: event.endSec,
        words: event.words.length > 0 ? event.words : undefined,
      })
    }
  }

  /**
   * Render an in-progress utterance. First interim from a fresh utterance
   * POSTs a new message (italic — "being said right now"); subsequent
   * interims for the same utterance EDIT that message in-place, throttled
   * to {@link INTERIM_EDIT_THROTTLE_MS} per speaker so a chatty Deepgram
   * stream doesn't burn through Discord's 5-edits-per-5s-per-message
   * limit. The final transcript (handled by {@link postOrEditFinal})
   * tidies the message into its non-italic corrected form and clears the
   * in-flight slot, so the next utterance from this speaker starts fresh.
   */
  private onInterim(event: TranscriptInterimEvent): void {
    if (!this.threadId) return
    const text = event.transcript.trim()
    if (!text) return
    // Don't reflip transcriptionDelivered here — interims aren't billable
    // value; the surcharge gate waits for the first FINAL transcript.
    const existing = this.interimMessageIds.get(event.speakerId)
    if (existing) {
      // Throttle edits + skip when nothing changed.
      const last = this.interimLastEditAt.get(event.speakerId) ?? 0
      if (Date.now() - last < this.INTERIM_EDIT_THROTTLE_MS) return
      if (this.interimLastText.get(event.speakerId) === text) return
      this.interimLastEditAt.set(event.speakerId, Date.now())
      this.interimLastText.set(event.speakerId, text)
      void this.editThreadMessage(existing, this.renderInterim(event.speakerName, text))
    } else {
      // First interim for this utterance — post a new message.
      this.interimLastEditAt.set(event.speakerId, Date.now())
      this.interimLastText.set(event.speakerId, text)
      void this.postThreadMessage(this.renderInterim(event.speakerName, text)).then((id) => {
        if (id) this.interimMessageIds.set(event.speakerId, id)
      })
    }
  }

  /**
   * Land the final transcript in the thread. Edits the in-flight interim
   * message if we posted one for this utterance; otherwise posts fresh.
   * Either way clears the speaker's interim slot so the next utterance
   * starts a new message.
   */
  private async postOrEditFinal(event: TranscriptFinalEvent): Promise<void> {
    if (!this.threadId) return
    const text = event.transcript.trim()
    if (!text) return
    const rendered = this.renderFinal(event.speakerName, text)
    const interimId = this.interimMessageIds.get(event.speakerId)
    this.interimMessageIds.delete(event.speakerId)
    this.interimLastEditAt.delete(event.speakerId)
    this.interimLastText.delete(event.speakerId)
    if (interimId) {
      await this.editThreadMessage(interimId, rendered)
    } else {
      await this.postThreadMessage(rendered)
    }
  }

  /** Italic in-progress render. Truncates to fit Discord's 2000-char cap. */
  private renderInterim(speakerName: string, text: string): string {
    const prefix = `**${speakerName}:** *`
    const suffix = '*'
    const budget = 2000 - prefix.length - suffix.length - 1
    const body = text.length > budget ? text.slice(0, budget - 1) + '…' : text
    return prefix + body + suffix
  }

  /** Final (corrected, non-italic) render. */
  private renderFinal(speakerName: string, text: string): string {
    const prefix = `**${speakerName}:** `
    const budget = 2000 - prefix.length - 1
    const body = text.length > budget ? text.slice(0, budget - 1) + '…' : text
    return prefix + body
  }

  private async postThreadMessage(content: string): Promise<string | null> {
    if (!this.threadId) return null
    try {
      const channel = await this.params.client.channels.fetch(this.threadId)
      if (!channel || !channel.isSendable()) return null
      const msg = await channel.send({ content })
      return msg.id
    } catch (err) {
      this.logger.warn({ err, recordingId: this.recordingId }, 'live caption post failed')
      return null
    }
  }

  private async editThreadMessage(messageId: string, content: string): Promise<void> {
    if (!this.threadId) return
    try {
      const channel = await this.params.client.channels.fetch(this.threadId)
      if (!channel || !channel.isTextBased() || !('messages' in channel)) return
      const msg = await channel.messages.fetch(messageId).catch(() => null)
      if (!msg || !msg.editable) return
      await msg.edit({ content })
    } catch (err) {
      this.logger.warn({ err, recordingId: this.recordingId, messageId }, 'live caption edit failed')
    }
  }

  private redactedSpeakerIds(): Set<string> {
    const consented = this.consent.consentedIds()
    const redacted = new Set<string>()
    for (const c of this.captions) {
      if (!consented.has(c.speakerId)) redacted.add(c.speakerId)
    }
    return redacted
  }

  private async resolveSpeakerName(userId: string): Promise<string> {
    try {
      const user = await this.params.client.users.fetch(userId)
      return user.displayName || user.username || userId
    } catch {
      return userId
    }
  }

  private async voiceMemberIds(client: Client): Promise<string[]> {
    try {
      const channel = await client.channels.fetch(this.voiceChannelId)
      if (channel && channel.isVoiceBased()) {
        return Array.from(channel.members.keys()).filter((id) => id !== client.user?.id)
      }
    } catch {
      /* fall through */
    }
    return []
  }

  private async voiceChannelName(client: Client): Promise<string> {
    try {
      const channel = await client.channels.fetch(this.voiceChannelId)
      if (channel && 'name' in channel && channel.name) return channel.name
    } catch {
      /* fall through */
    }
    return this.voiceChannelId
  }
}
