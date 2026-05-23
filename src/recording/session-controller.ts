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
import { SpeakerWebhookManager } from '../discord/speaker-webhook.js'
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

/** Discord per-message character cap. */
const DISCORD_MESSAGE_MAX_CHARS = 2000

/** Wrap text in Discord italic markers — used for the "being said" interim render. */
function italic(text: string): string {
  return `*${text}*`
}

/** Hard-truncate to Discord's per-message char cap. Trailing ellipsis when cut. */
function truncateForDiscord(content: string): string {
  if (content.length <= DISCORD_MESSAGE_MAX_CHARS) return content
  return content.slice(0, DISCORD_MESSAGE_MAX_CHARS - 1) + '…'
}

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
   * In-flight stop promise. The control-API `/stop` call kicks off the
   * full post-process (mix mp3, upload to Spaces, post to Discord
   * thread) which takes seconds. When core-server's spawner then
   * SIGTERMs the container, the SIGTERM handler also calls stop() —
   * without this, the second call hits `status === 'stopping'` and
   * returns instantly, then SIGTERM proceeds to destroy the Discord
   * gateway WHILE deliver() is still running → the thread post fails
   * with "Expected token to be set." Re-entered stop() returns this
   * promise so SIGTERM actually waits for the post-process to finish.
   */
  private stopInFlight: Promise<void> | null = null

  /**
   * Per-speaker webhook caption state. Each speaker posts via their own
   * webhook (their name + avatar appear as the chat author), so Discord
   * auto-groups consecutive messages from the same speaker under a single
   * header. One in-flight utterance per speaker: first interim POSTs an
   * italic message via the webhook, subsequent interims EDIT it (throttled),
   * the final EDITs one last time to non-italic + clears the slot so the
   * speaker's next utterance posts a fresh message.
   */
  private webhookManager: SpeakerWebhookManager | null = null
  private interimMessageIds = new Map<string, string>()
  /** Per-speaker throttle so we don't spam Discord edits on every interim. */
  private interimLastEditAt = new Map<string, number>()
  /** Last interim text per speaker — avoids edits when nothing actually changed. */
  private interimLastText = new Map<string, string>()
  /**
   * Per-speaker async queue. Serializes interim/final ops for a speaker so
   * the first-interim POST resolves (and writes its message id) before any
   * subsequent edit fires — fixes the race where parallel interims each
   * posted a fresh message because none of them saw the id yet.
   */
  private speakerOpQueue = new Map<string, Promise<void>>()
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
      // CFG-hosted ⇒ installationId (Prisma RecordingSession.id, the FK
      // core-server's handleConsentButton upserts against). Self-host ⇒
      // local recordingId — there is no core-server, the container's
      // own gateway handler picks the click up.
      buttonKey: p.cfg?.installationId ?? this.recordingId,
      client: p.client,
      textChannelId: p.textChannelId,
      // threadId is wired below via setThreadId once createRecordingThread
      // resolves — consent prompts then target the thread (with the user
      // added on demand) and fall back to textChannelId on any failure.
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
    // ── CFG-hosted: pre-fetch the session policy ────────────────────────────
    // It carries TWO things we need before RecordingSession boots:
    //   1. The seeded consent list (auto-consent for the invoker + anyone
    //      who pre-consented via the Activity / channel settings).
    //   2. Deepgram keywords / keyterms — campaign-derived plus per-channel
    //      from ReseshChannelSettings. Without these the model misses
    //      player names ("Keyway" instead of "Keawe"), monster names,
    //      jargon, etc. Earlier the policy was fetched by consent-sync but
    //      only consentedUserIds were consumed; the keyword fields were
    //      thrown away.
    let policyKeywords: string[] = []
    let policyKeyterms: string[] = []
    if (p.cfg) {
      const policy = await p.core.fetchSessionPolicy()
      for (const userId of policy.consentedUserIds) {
        this.consent.applyConsent(userId)
      }
      policyKeywords = policy.keywords ?? []
      policyKeyterms = policy.keyterms ?? []
      this.logger.info(
        { consented: policy.consentedUserIds.length, keywords: policyKeywords.length, keyterms: policyKeyterms.length },
        'consent + keywords seeded from session policy',
      )
    }

    this.session = new RecordingSession({
      deepgramTokenProvider: tokenProvider,
      deepgramModel: p.deepgramModel,
      language: p.deepgramLanguage,
      consentedUserIds: this.consent.consentedIds(),
      keywords: policyKeywords,
      keyterms: policyKeyterms,
      resolveSpeakerName: (userId) => this.resolveSpeakerName(userId),
      onTranscriptFinal: (event: TranscriptFinalEvent) => this.onTranscript(event),
      onTranscriptInterim: (event: TranscriptInterimEvent) => this.onInterim(event),
      logger: this.logger,
    })
    // Keep the RecordingSession consent set in sync with the manager.
    this.consent.onConsent((userId) => void this.session.addConsentedUser(userId))
    this.consent.onDecline((userId) => this.session.addDeclinedUser(userId))

    // CFG-hosted: wire the consent-sync for LATE pushed updates from
    // core-server (Activity toggle, mid-session Discord button click).
    // Initial seed is handled inline above to give us access to the
    // policy's keyword fields too.
    if (p.cfg) {
      this.consentSync = new ConsentSync({ consent: this.consent, core: p.core, logger: this.logger })
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
    // Hand the thread id to the consent manager so subsequent prompts
    // (initial + late-joiner) target the thread, adding the user to it
    // on demand. Falls back to the parent channel on any thread error.
    this.consent.setThreadId(this.threadId)

    // Spin up the per-speaker webhook manager. Each speaker's live caption
    // posts via their own webhook (their name + avatar) so Discord groups
    // consecutive same-speaker messages under one header — natively. The
    // manager itself does NOT post anything yet; webhooks are created
    // lazily on the first interim from a given speaker.
    //
    // init() sweeps any stale `cfg-resesh-rec-*` webhooks left in the
    // parent channel by crashed prior sessions, freeing slots back to
    // Discord's 15-webhook cap before this session starts creating its
    // own. Fired in parallel with the consent-prompt loop below — neither
    // depends on the other, and we don't want to block the join on a
    // slow Discord API call.
    this.webhookManager = new SpeakerWebhookManager(p.client, p.textChannelId, this.recordingId, this.logger)
    void this.webhookManager.init()

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
    if (this.status === 'stopped') return
    if (this.stopInFlight) return this.stopInFlight
    this.stopInFlight = this.runStop()
    try {
      await this.stopInFlight
    } finally {
      this.stopInFlight = null
    }
  }

  private async runStop(): Promise<void> {
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
      // Drain any still-queued per-speaker ops so a late edit can't fire
      // against a deleted webhook. Best-effort — anything still pending
      // after the session is going down anyway.
      await Promise.allSettled(Array.from(this.speakerOpQueue.values()))
      // Delete the per-speaker webhooks the manager created so we don't
      // leave residue in the channel's webhook list (15-cap globally).
      if (this.webhookManager) {
        await this.webhookManager.cleanup()
        this.webhookManager = null
      }
      if (this.status !== 'failed') this.status = 'stopped'
      this.logger.info({ recordingId: this.recordingId }, 'recording session stopped')
    }
  }

  /**
   * Audit the parent text channel's webhooks — categorized by ownership.
   * Returns null if the bot lacks MANAGE_WEBHOOKS. Used by the control
   * API's `GET /v1/webhooks` endpoint for ops visibility.
   */
  async auditWebhooks() {
    return this.webhookManager?.audit() ?? null
  }

  /**
   * Delete stale `cfg-resesh-rec-*` webhooks (any recordingId != ours)
   * in the parent channel. Used by the control API's
   * `POST /v1/webhooks/sweep` endpoint. Leaves non-recording ReSesh
   * webhooks (e.g. future Chat in Character) and foreign integrations
   * untouched.
   */
  async sweepWebhooks() {
    return (
      this.webhookManager?.sweepStale('manual') ?? {
        kept: 0,
        deleted: 0,
        otherReseshFeature: 0,
        foreign: 0,
        unavailable: true,
      }
    )
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
      this.postFinalCaption(event)
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
   * Live-caption flow: each speaker posts via their own Discord webhook
   * (name + avatar = speaker), so Discord's chat renderer auto-groups
   * consecutive same-speaker messages under one header — the "paragraph
   * under one speaker" UX. Per-speaker ops are serialized through
   * {@link enqueueSpeakerOp} so the first interim's POST resolves (and
   * registers its message id) before any subsequent edit fires — fixes
   * the race where parallel interims each posted a fresh message
   * because none of them had the id yet.
   *
   * Falls back to bot messages (with explicit speaker label in the text)
   * when webhooks aren't available — missing MANAGE_WEBHOOKS, hitting
   * Discord's 15-webhooks-per-channel cap, or a create error.
   */
  private onInterim(event: TranscriptInterimEvent): void {
    if (!this.threadId) return
    const text = event.transcript.trim()
    if (!text) return
    // Don't reflip transcriptionDelivered here — interims aren't billable
    // value; the surcharge gate waits for the first FINAL transcript.

    // Throttle + dedup synchronously, BEFORE enqueueing the op, so a chatty
    // Deepgram stream doesn't fill the queue with no-op edits.
    const existing = this.interimMessageIds.get(event.speakerId)
    if (existing) {
      const last = this.interimLastEditAt.get(event.speakerId) ?? 0
      if (Date.now() - last < this.INTERIM_EDIT_THROTTLE_MS) return
      if (this.interimLastText.get(event.speakerId) === text) return
    }
    this.interimLastEditAt.set(event.speakerId, Date.now())
    this.interimLastText.set(event.speakerId, text)

    this.enqueueSpeakerOp(event.speakerId, async () => {
      const messageId = this.interimMessageIds.get(event.speakerId)
      if (messageId) {
        await this.editCaption(event.speakerId, messageId, italic(text))
      } else {
        const newId = await this.postCaption(event.speakerId, event.speakerName, italic(text))
        if (newId) this.interimMessageIds.set(event.speakerId, newId)
      }
    })
  }

  /**
   * Land the final transcript. Edits the in-flight interim message if we
   * posted one for this utterance; otherwise posts fresh. Either way
   * clears the speaker's interim slot so the next utterance starts a new
   * message — Discord groups consecutive same-speaker messages visually.
   */
  private postFinalCaption(event: TranscriptFinalEvent): void {
    if (!this.threadId) return
    const text = event.transcript.trim()
    if (!text) return

    this.enqueueSpeakerOp(event.speakerId, async () => {
      const interimId = this.interimMessageIds.get(event.speakerId)
      this.interimMessageIds.delete(event.speakerId)
      this.interimLastEditAt.delete(event.speakerId)
      this.interimLastText.delete(event.speakerId)
      if (interimId) {
        await this.editCaption(event.speakerId, interimId, text)
      } else {
        await this.postCaption(event.speakerId, event.speakerName, text)
      }
    })
  }

  /**
   * Per-speaker serial queue. Ops for the same speaker run one at a time;
   * different speakers run in parallel. Keeps post-then-edit ordering for
   * a single speaker without serializing the whole thread.
   */
  private enqueueSpeakerOp(speakerId: string, op: () => Promise<void>): void {
    const prev = this.speakerOpQueue.get(speakerId) ?? Promise.resolve()
    const next = prev.then(op, op).catch((err) =>
      this.logger.warn({ err, recordingId: this.recordingId, speakerId }, 'speaker op threw'),
    )
    this.speakerOpQueue.set(speakerId, next)
  }

  /**
   * Post a caption via the speaker's webhook when available; falls back to
   * a bot message with an explicit `**Name:**` prefix. Returns the new
   * message id on success.
   */
  private async postCaption(
    speakerId: string,
    speakerName: string,
    content: string,
  ): Promise<string | null> {
    if (!this.threadId) return null
    const webhook = await this.resolveSpeakerWebhook(speakerId, speakerName)
    const truncated = truncateForDiscord(content)
    if (webhook) {
      try {
        const avatarURL = await this.resolveSpeakerAvatar(speakerId).catch(() => null)
        const msg = await webhook.send({
          content: truncated,
          username: speakerName,
          avatarURL: avatarURL ?? undefined,
          threadId: this.threadId,
        })
        return msg.id
      } catch (err) {
        this.logger.warn(
          { err, recordingId: this.recordingId, speakerId },
          'webhook post failed — falling back to bot message',
        )
      }
    }
    // Bot-message fallback (no MANAGE_WEBHOOKS, webhook cap hit, or send error).
    return this.postBotMessage(`**${speakerName}:** ${truncated}`)
  }

  /** Edit a previously-posted caption (webhook OR bot — id alone disambiguates). */
  private async editCaption(speakerId: string, messageId: string, content: string): Promise<void> {
    if (!this.threadId) return
    const truncated = truncateForDiscord(content)
    const webhook = await this.resolveSpeakerWebhook(speakerId, null)
    if (webhook) {
      try {
        await webhook.editMessage(messageId, { content: truncated, threadId: this.threadId })
        return
      } catch (err) {
        this.logger.warn(
          { err, recordingId: this.recordingId, speakerId, messageId },
          'webhook edit failed — falling back to channel.messages.edit',
        )
      }
    }
    await this.editBotMessage(messageId, truncated)
  }

  /**
   * Look up (or create) the speaker's webhook. `speakerName` is required
   * for the create path; on edit we can pass null because the webhook is
   * cached after the first interim.
   */
  private async resolveSpeakerWebhook(speakerId: string, speakerName: string | null) {
    if (!this.webhookManager) return null
    const name = speakerName ?? (await this.resolveSpeakerName(speakerId).catch(() => speakerId))
    const avatarURL = await this.resolveSpeakerAvatar(speakerId).catch(() => null)
    return this.webhookManager.getOrCreate({ speakerId, displayName: name, avatarURL })
  }

  private async resolveSpeakerAvatar(speakerId: string): Promise<string | null> {
    try {
      const user = await this.params.client.users.fetch(speakerId)
      return user.displayAvatarURL({ size: 128, extension: 'png' })
    } catch {
      return null
    }
  }

  private async postBotMessage(content: string): Promise<string | null> {
    if (!this.threadId) return null
    try {
      const channel = await this.params.client.channels.fetch(this.threadId)
      if (!channel || !channel.isSendable()) return null
      const msg = await channel.send({ content })
      return msg.id
    } catch (err) {
      this.logger.warn({ err, recordingId: this.recordingId }, 'bot-message caption post failed')
      return null
    }
  }

  private async editBotMessage(messageId: string, content: string): Promise<void> {
    if (!this.threadId) return
    try {
      const channel = await this.params.client.channels.fetch(this.threadId)
      if (!channel || !channel.isTextBased() || !('messages' in channel)) return
      const msg = await channel.messages.fetch(messageId).catch(() => null)
      if (!msg || !msg.editable) return
      await msg.edit({ content })
    } catch (err) {
      this.logger.warn({ err, recordingId: this.recordingId, messageId }, 'bot-message caption edit failed')
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
