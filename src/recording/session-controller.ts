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
 *   start()  → mkdir temp → join voice (capture ASAP) → create thread + wire consent surface
 *   pause()  → gate audio + transcription
 *   resume() → un-gate
 *   stop()   → leave voice → finalize PCM → mix → VTT → sink → post thread
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActivityType, type Client } from 'discord.js'
import { VoiceCapture } from '../gateway/voice-capture.js'
import { PcmCapture } from './pcm-capture.js'
import { ActiveTimeMeter } from './active-time-meter.js'
import { RecordingSession, type TranscriptFinalEvent, type TranscriptInterimEvent } from './recording-session.js'
import { buildDeepgramTokenProvider } from '../deepgram/index.js'
import { ConsentManager } from '../consent/consent-manager.js'
import { processRecording } from './post-process.js'
import { ChunkRecorder, type ChunkInfo } from './chunk-recorder.js'
import { createRecordingThread, postChunk, postRecording, tempDirOf } from '../discord/thread-poster.js'
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
  /** Real-time mp3 chunking cadence in minutes (#131). `<= 0` disables it. */
  chunkMinutes: number
  /** Output sink for the finalized mp3 + VTT. */
  sink: OutputSink
  /** Discord user id of the invoker — pre-consented. */
  invokerUserId?: string
  /**
   * Reuse this thread rather than creating one. Set by core-server when the
   * GM picked a thread, or when an earlier recording in the same session
   * already has one — which is what stops a restart producing a duplicate.
   */
  existingThreadId?: string | null
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
  /** Real-time mp3 chunker (#131). Constructed in start(); a no-op when chunkMinutes<=0. */
  private chunkRecorder: ChunkRecorder | null = null
  private session!: RecordingSession
  private voice!: VoiceCapture
  private readonly captions: CaptionEntry[] = []
  private threadId: string | null = null
  /**
   * Tracks whether we've set the bot's presence to the recording-indicator
   * activity in this session, so {@link runStop} only clears it once.
   * Presence is a global (bot-identity-wide) state, not per-guild — see
   * the comments on {@link setRecordingPresence} for the multi-tenant
   * caveat.
   */
  private presenceSet = false
  /**
   * Message id of the session-start announcement — the first message in
   * the thread. The end-of-session "Back to Top" link anchors here so
   * users can jump to the start of a multi-hour transcript in one click.
   */
  private firstThreadMessageId: string | null = null

  /** CFG-hosted consent bridge — only constructed when `cfg` is present. */
  private consentSync: ConsentSync | null = null
  /** Billing-tick timer — only armed when `cfg` is present. */
  private billingTimer: NodeJS.Timeout | null = null
  /**
   * Once-flag for the mid-session insufficient-Crit-Coin graceful stop (#120).
   * Set the first time a `server_uptime` tick comes back 402; guards
   * {@link handleInsufficientCoins} so the user gets exactly ONE
   * "out of Crit-Coin" channel message and exactly ONE stop(), even though
   * stop() itself posts a final billing tick that would also 402.
   */
  private insufficientStopFired = false
  /**
   * Tracks ACTIVE (un-paused) time for the billing tick. Replaces the old
   * single sliding anchor, which discarded the active sub-window whenever a
   * tick boundary landed during a pause (prod incident 2026-06-23: a session
   * paused at ~10 min billed only the post-tick sliver, ~1 of ~10 active min).
   */
  private readonly billingMeter = new ActiveTimeMeter()
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
   * full post-process (mix mp3, upload to object storage, post to Discord
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
      // A human disconnecting the bot is an instruction to stop, not a fault
      // to recover from. End the recording the normal way so the mix, VTT and
      // thread post all still happen — stop() is re-entrant-safe, and
      // fire-and-forget keeps us off the gateway event loop.
      onExplicitDisconnect: (reason) => {
        this.logger.info({ recordingId: this.recordingId, reason }, 'ending recording — bot was removed from voice')
        void this.stop()
      },
      logger: this.logger,
    })

    // Look up voice members up front — used for thread invites, the
    // announcement ping list, and the member-seeding below. Cheap
    // (`channels.fetch` only) and needs no live voice connection, so it runs
    // before the join.
    const memberIds = await this.voiceMemberIds(p.client)

    // ── Capture starts ASAP: voice.join() runs EARLY ────────────────────────
    // `join()` is the ONLY thing that establishes the VoiceConnection + audio
    // receiver, and @discordjs/voice has no pre-buffer. Delaying it behind the
    // ~4 awaited Discord REST round-trips of thread creation would permanently
    // drop the opening audio — including the auto-consented host/invoker's
    // session-start narration (they pass the consent gate immediately, so
    // their early audio WOULD be captured if a connection existed). So we join
    // first and reconcile the thread-creation race a different way:
    //
    //   1. Seed members-at-start as `seen`/`pending` so `noteSpeaker` (fired by
    //      the speaking/voiceStateUpdate listeners join() registers) is a no-op
    //      for them — no per-member prompt; their surface is the 3-button row
    //      on the announcement below. This is local (no Discord calls), so it
    //      runs BEFORE join() to fully pre-empt the double-prompt path.
    //   2. Tell the consent manager a thread IS coming (`expectThread`). Any
    //      consent prompt that fires in the join→setThreadId window is then
    //      QUEUED (not leaked to the parent channel) and flushed into the
    //      thread once `setThreadId` resolves below.
    await this.consent.promptInitial(memberIds)
    this.consent.expectThread()
    // If the join fails, no thread or announcement exists yet (we join BEFORE
    // creating them), so there's no orphaned thread + "click to consent"
    // surface for a recording that never starts. We DO still need to detach
    // the consent manager's interactionCreate listener — the controller is
    // never committed to the registry on a start() throw, so runStop() (which
    // calls consent.stop()) never runs. Mark failed + tear down, then rethrow
    // so recording-service releases the registry slot.
    try {
      await this.voice.join()
    } catch (err) {
      this.status = 'failed'
      this.consent.stop()
      await rm(this.tempDir, { recursive: true, force: true }).catch(() => {})
      this.logger.error(
        { err, recordingId: this.recordingId, guildId: this.guildId },
        'voice.join() failed — aborting start before any thread/announcement was created',
      )
      throw err
    }

    // Create the live thread NOW (private — only the invoker + current
    // voice members get added, so the recording artifact + transcripts
    // are visible only to people who were in the call). When
    // transcription is on, captions stream into it; on stop the mp3 is
    // attached to this same thread instead of creating a new one.
    // Best-effort — `createRecordingThread` returns null on failure; the
    // consent manager then flushes any queued prompts to the parent channel
    // (genuine no-thread fallback) and `deliver` refuses to post the mp3.
    const voiceChannelName = await this.voiceChannelName(p.client)
    const threadMembers = Array.from(new Set([p.invokerUserId, ...memberIds].filter((id): id is string => !!id)))
    if (p.existingThreadId) {
      // Reuse. Creating unconditionally is what produced duplicate threads
      // with identical names on every stop/restart within a session.
      this.threadId = p.existingThreadId
      this.logger.info(
        { recordingId: this.recordingId, threadId: this.threadId },
        'reusing existing recording thread',
      )
    } else {
      this.threadId = await createRecordingThread(
        p.client,
        p.textChannelId,
        voiceChannelName,
        p.transcription,
        threadMembers,
        this.logger,
      )
      // Report it home so core-server can hand it back on the next start (and
      // address the thread itself). No-op in self-host.
      if (this.threadId) void this.reportThread(this.threadId, p.textChannelId)
    }
    // Wire the thread id into the consent manager. This ALSO flushes any
    // prompts that the voice listeners queued during the join→now window:
    // into the thread when non-null, or to the parent channel when thread
    // creation failed (null) — the genuine no-thread fallback.
    this.consent.setThreadId(this.threadId)

    // Post the session-start announcement INSIDE the (private) thread —
    // pings the invoker (if any) + every voice member so they all get a
    // Discord notification pointing at the thread, AND carries the 3-button
    // consent row that is the consent surface for everyone-in-voice-at-start.
    // Posted unconditionally whenever a thread exists — NOT gated on
    // `invokerUserId` (issue #5: auto-started sessions have no invoker, so the
    // old `if (p.invokerUserId)` gate meant non-speakers were never prompted
    // and `firstThreadMessageId` — the Back-to-Top anchor — was never set).
    // The returned message id anchors the end-of-session Back-to-Top link.
    if (this.threadId) {
      this.firstThreadMessageId = await this.consent.postSessionStart(
        p.invokerUserId ?? null,
        this.threadId,
        p.transcription,
        memberIds,
      )
    }

    // Spin up the per-speaker webhook manager. Each speaker's live caption
    // posts via their own webhook (their name + avatar) so Discord groups
    // consecutive same-speaker messages under one header — natively. The
    // manager itself does NOT post anything yet; webhooks are created
    // lazily on the first interim from a given speaker.
    //
    // init() sweeps any stale `cfg-resesh-rec-*` webhooks left in the
    // parent channel by crashed prior sessions, freeing slots back to
    // Discord's 15-webhook cap before this session starts creating its
    // own. Fired-and-forgotten — it doesn't depend on the voice connection.
    this.webhookManager = new SpeakerWebhookManager(p.client, p.textChannelId, this.recordingId, this.logger)
    void this.webhookManager.init()

    this.status = 'recording'

    // Surface a recording indicator on the bot's presence/activity so
    // members see "🔴 Recording session" under ReSesh in the member list.
    // Best-effort — presence updates aren't gated by Discord permissions
    // (it's a bot self-update), but any failure is logged and the
    // session continues either way.
    this.setRecordingPresence()

    // ── CFG-hosted: arm the pause-aware billing tick ────────────────────────
    // The separate `transcription` surcharge tick fires only when the
    // platform Deepgram key is in use (`transcriptionCtPerMinute` set) AND
    // transcription is actually running for this session. BYOK or disabled
    // transcription ⇒ server uptime only, no surcharge.
    this.transcriptionBilled =
      p.cfg?.transcriptionCtPerMinute != null && effectiveMode === 'platform'
    if (p.cfg) this.startBillingTimer()

    // Real-time mp3 chunking (#131) — additive + gated. A no-op unless
    // chunkMinutes>0; when armed it posts a windowed chunk into this thread on
    // the cadence + on pause/stop. Reads the same per-speaker PCM the mixer uses.
    this.chunkRecorder = new ChunkRecorder({
      recordingId: this.recordingId,
      chunkMinutes: p.chunkMinutes,
      tempDir: this.tempDir,
      getSpeakerFiles: () => this.pcmCapture.snapshotSpeakerFiles(),
      timelineByteNow: () => this.pcmCapture.timelineByteNow(),
      postChunk: (info) => this.postChunkToThread(info),
      logger: this.logger,
    })
    this.chunkRecorder.start()

    this.logger.info(
      { recordingId: this.recordingId, guildId: this.guildId, transcription: tokenProvider != null },
      'recording session started',
    )
  }

  /**
   * Upload one live chunk into the recording thread (#131), then (CFG-hosted)
   * persist its metadata for the offline archive. No-op without a thread; the
   * metadata POST is a clean no-op self-host.
   */
  private async postChunkToThread(info: ChunkInfo): Promise<void> {
    if (!this.threadId) return
    const messageId = await postChunk(this.params.client, this.threadId, this.recordingId, info, this.logger)
    await this.params.core.postChunk({
      chunkIndex: info.index,
      startSec: info.startSec,
      endSec: info.endSec,
      sizeBytes: info.sizeBytes,
      speakerCount: info.speakers,
      discordMessageId: messageId ?? undefined,
      discordChannelId: this.threadId,
    })
  }

  pause(): void {
    if (this.status !== 'recording') return
    this.status = 'paused'
    this.billingMeter.pause(Date.now())
    this.pcmCapture.setPaused(true)
    this.session.setPaused(true)
    // Flush the in-progress chunk so paused players can hear up to the break.
    void this.chunkRecorder?.onPause()
    this.logger.info({ recordingId: this.recordingId }, 'recording paused')
  }

  resume(): void {
    if (this.status !== 'paused') return
    this.status = 'recording'
    this.billingMeter.resume(Date.now())
    this.pcmCapture.setPaused(false)
    this.session.setPaused(false)
    // Skip the paused span so the next chunk isn't buried under pause silence.
    this.chunkRecorder?.onResume()
    this.logger.info({ recordingId: this.recordingId }, 'recording resumed')
  }

  /**
   * Apply a consent update pushed by core-server (CFG-hosted only). No-op
   * when this session has no consent-sync wired (self-host).
   */
  /**
   * Tell core-server which thread this recording is using. Fire-and-forget:
   * the core client is a no-op in self-host, and a failure only costs thread
   * reuse on the NEXT start, never this recording.
   */
  private async reportThread(threadId: string, parentChannelId: string | null): Promise<void> {
    if (!this.params.cfg) return
    await this.params.core.postRecordingThread(threadId, parentChannelId).catch((err: unknown) => {
      this.logger.warn({ err, recordingId: this.recordingId, threadId }, 'thread report failed')
    })
  }

  pushConsent(userId: string, consented: boolean): void {
    this.consentSync?.applyPushedUpdate(userId, consented)
  }

  /**
   * Arm the periodic CT billing tick. Pause-aware via `billingMeter`, which
   * banks only ACTIVE (un-paused) time: a tick that lands during a pause bills
   * exactly the active window that preceded the pause (possibly a full
   * interval), and a tick during recording bills active-up-to-now. Paused time
   * is never billed and active time is never discarded.
   *
   * Two ticks ride the SAME cadence: the `server_uptime` tick (always, when
   * CFG-hosted — the skill-server container's by-instance-size uptime) and
   * the `transcription` surcharge tick (only when this session is on the
   * platform Deepgram key — see `transcriptionBilled`).
   */
  private startBillingTimer(): void {
    const cfg = this.params.cfg
    if (!cfg) return
    this.billingMeter.start(Date.now())
    const timer = setInterval(() => {
      const minutes = this.billingMeter.flushMinutes(Date.now())
      // postBillingTicks is async (it awaits the server_uptime tick to detect
      // a 402 → graceful stop, #120); fire-and-forget from the timer callback.
      if (minutes > 0) void this.postBillingTicks(minutes, false)
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
    const finalMinutes = this.billingMeter.flushMinutes(Date.now())
    if (finalMinutes > 0) await this.postBillingTicks(finalMinutes, true)
  }

  /**
   * Post the billing tick(s) for `minutes` of active (non-paused) recording.
   * Always posts the `server_uptime` tick (skill-server container uptime,
   * billed by instance size); additionally posts a separate itemized
   * `transcription` surcharge tick when this session runs on the platform
   * Deepgram key (`transcriptionBilled`).
   *
   * The `server_uptime` tick is AWAITED so a mid-session insufficient-Crit-Coin
   * 402 triggers a graceful stop (#120). The `transcription` surcharge tick is
   * intentionally NOT awaited and NEVER drives the stop: only the unified
   * server-uptime axis is the dunning signal (a transcription-only shortfall
   * still produced a recording the user can keep).
   */
  private async postBillingTicks(minutes: number, final: boolean): Promise<void> {
    const cfg = this.params.cfg
    if (!cfg) return
    const suffix = final ? `final ${minutes.toFixed(1)} min` : `${minutes.toFixed(1)} min`
    // Transcription tick is gated on both INTENT (transcriptionBilled, set at
    // start from `effectiveMode === 'platform'`) AND DELIVERY
    // (transcriptionDelivered, flipped the first time a transcript event
    // arrives). If the platform grant fails or Deepgram is otherwise broken,
    // no transcripts flow, transcriptionDelivered stays false, and the
    // surcharge is never posted — the user only pays server_uptime.
    // Fire-and-forget: a transcription 402 must NOT stop the recording.
    if (this.transcriptionBilled && this.transcriptionDelivered && cfg.transcriptionCtPerMinute != null) {
      void this.params.core.postBillingTick({
        resourceType: 'transcription',
        minutes,
        ctPerMinute: cfg.transcriptionCtPerMinute,
        label: `Live Transcription: ${suffix}`,
      })
    }
    // Server-uptime tick: AWAITED, and it is the ONLY tick whose 402 stops the
    // recording. A 402 here means the user is out of Crit-Coin → graceful stop.
    const { insufficientCoins } = await this.params.core.postBillingTick({
      resourceType: 'server_uptime',
      minutes,
      ctPerMinute: cfg.ctPerMinute,
      label: `Recording Server (${cfg.size}): ${suffix}`,
    })
    if (insufficientCoins) await this.handleInsufficientCoins()
  }

  /**
   * Mid-session insufficient-Crit-Coin graceful stop (#120). Fired when a
   * `server_uptime` billing tick comes back 402. Guarded by a once-flag so the
   * user gets exactly one "out of Crit-Coin" channel message and exactly one
   * stop() — the in-flight stop posts a final tick that would also 402, and
   * this guard prevents that from re-posting or re-entering.
   */
  private async handleInsufficientCoins(): Promise<void> {
    if (this.insufficientStopFired) return
    this.insufficientStopFired = true
    this.logger.warn({ recordingId: this.recordingId }, 'out of Crit-Coin — stopping recording (#120)')
    // Best-effort user-facing notice in the thread (null-safe on threadId).
    await this.postBotMessage('Out of Crit-Coin — recording ended.')
    // stop() is re-entrant-safe (stopInFlight); fire-and-forget so this tick's
    // caller (the awaited server_uptime POST inside stop()'s final tick, OR the
    // periodic timer) returns promptly rather than awaiting the whole
    // mix/upload/post pipeline.
    void this.stop()
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
    const rid = this.recordingId
    // Numbered checkpoint logs so a hung / failed stop is easy to triage
    // from production logs without having to instrument later. Every
    // step that does external I/O (Discord, ffmpeg, object storage)
    // gets its own log line so the breakpoint is visible.
    this.logger.info({ recordingId: rid }, '[runStop] 0/9 stopping')

    this.consent.stop()
    this.clearRecordingPresence()
    this.voice.leave('session-stop')
    this.logger.info({ recordingId: rid }, '[runStop] 1/9 voice left + presence cleared')

    await this.pcmCapture.onSessionStop()
    this.logger.info({ recordingId: rid }, '[runStop] 2/9 pcm capture stopped')

    // Flush the trailing chunk (#131) now that the final PCM is on disk, before
    // temp cleanup — best-effort, never blocks the whole-session mp3.
    await this.chunkRecorder?.finalize().catch((err) =>
      this.logger.warn({ err, recordingId: rid }, 'final chunk flush failed'),
    )

    await this.session.stop()
    this.logger.info({ recordingId: rid }, '[runStop] 3/9 recording session stopped')

    // CFG-hosted: stop the billing timer + post the final partial-minute
    // tick. Best-effort — a failed tick must not block post-processing.
    await this.stopBillingTimer().catch((err) =>
      this.logger.warn({ err, recordingId: rid }, 'final billing tick failed'),
    )
    this.logger.info({ recordingId: rid }, '[runStop] 4/9 billing timer stopped')

    try {
      const result = await processRecording(
        rid,
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
      this.logger.info(
        {
          recordingId: rid,
          producedOutput: !!result,
          mp3SizeBytes: result?.sizeBytes ?? null,
          durationMs: result?.durationMs ?? null,
        },
        '[runStop] 5/9 processRecording returned',
      )
      if (result) {
        await this.deliver(result)
        this.logger.info({ recordingId: rid }, '[runStop] 6/9 delivery complete')
      } else {
        this.logger.warn({ recordingId: rid }, 'nothing recorded — no output produced')
      }
    } catch (err) {
      this.status = 'failed'
      this.logger.error({ err, recordingId: rid }, '[runStop] post-processing or delivery FAILED')
    } finally {
      await rm(this.tempDir, { recursive: true, force: true }).catch(() => {})
      this.logger.info({ recordingId: rid }, '[runStop] 7/9 temp dir cleaned')

      // Drain any still-queued per-speaker ops so a late edit can't fire
      // against a deleted webhook. Best-effort — anything still pending
      // after the session is going down anyway.
      await Promise.allSettled(Array.from(this.speakerOpQueue.values()))
      this.logger.info(
        { recordingId: rid, drained: this.speakerOpQueue.size },
        '[runStop] 8/9 speaker op queue drained',
      )

      // Delete the per-speaker webhooks the manager created so we don't
      // leave residue in the channel's webhook list (15-cap globally).
      if (this.webhookManager) {
        await this.webhookManager.cleanup()
        this.webhookManager = null
      }
      if (this.status !== 'failed') this.status = 'stopped'
      this.logger.info(
        { recordingId: rid, status: this.status },
        '[runStop] 9/9 recording session stopped',
      )
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
    // Reuse the thread created at session start so the mp3 lands in the
    // same place live captions streamed into. If start-time thread creation
    // failed (`threadId === null`), we DO NOT fall back to the parent
    // channel — posting a recording publicly is a privacy violation
    // regardless of surface. The recording remains in object storage for
    // out-of-band retrieval; the operator gets a loud log to triage.
    if (!this.threadId) {
      this.logger.error(
        {
          recordingId: this.recordingId,
          guildId: this.guildId,
          textChannelId: p.textChannelId,
        },
        'recording NOT posted: no private thread was created at session start (bot likely missing Create Private Threads). Recording remains in object storage.',
      )
      return
    }
    this.logger.info(
      { recordingId: this.recordingId, threadId: this.threadId, mp3Bytes: result.sizeBytes },
      '[deliver] posting recording to thread',
    )
    await postRecording(
      p.client,
      this.threadId,
      this.recordingId,
      tempDirOf(result.mp3Path),
      result,
      result.captions,
      this.redactedSpeakerIds(),
      this.logger,
    )
    this.logger.info(
      { recordingId: this.recordingId, threadId: this.threadId },
      '[deliver] postRecording returned (mp3 + VTT posted)',
    )

    // End-of-session "Back to Top" link. Anchors on the session-start
    // announcement (first message in the thread) so users can jump back
    // to the start of a multi-hour transcript in one click. Best-effort;
    // a missing first-message id (thread post failed) or a send error
    // just skips the link — the mp3 + VTT have already landed above.
    if (this.threadId && this.firstThreadMessageId) {
      try {
        const channel = await p.client.channels.fetch(this.threadId)
        if (channel && channel.isSendable()) {
          const url = `https://discord.com/channels/${p.guildId}/${this.threadId}/${this.firstThreadMessageId}`
          await channel.send({ content: `# [Back to Top](${url})` })
        }
      } catch (err) {
        this.logger.warn({ err, recordingId: this.recordingId }, 'Back-to-Top link post failed (best-effort)')
      }
    }
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

  /**
   * Set the bot's presence to a recording-indicator activity so members
   * see "🔴 Recording session" under ReSesh in the member list. Presence
   * updates are a bot self-update — no Discord permissions are required
   * (no CHANGE_NICKNAME, MANAGE_GUILD, etc.).
   *
   * Multi-tenant caveat: presence is keyed on the bot identity, not the
   * guild. If two disrecord containers run concurrently for the same
   * ReSesh bot token (separate users / separate guilds), the most recent
   * presence update wins globally. For solo / single-tenant deployments
   * this is fine; at scale we'd need a central coordinator to manage a
   * shared "any session active?" presence. Acceptable for now.
   */
  private setRecordingPresence(): void {
    try {
      const user = this.params.client.user
      if (!user) return
      user.setPresence({
        activities: [{ name: '🔴 Recording session', type: ActivityType.Watching }],
        status: 'online',
      })
      this.presenceSet = true
    } catch (err) {
      this.logger.warn(
        { err, recordingId: this.recordingId },
        'failed to set recording presence (best-effort)',
      )
    }
  }

  /**
   * Clear the recording-indicator presence set by {@link setRecordingPresence}.
   * No-op when presence was never set (e.g. start() failed before reaching
   * the presence call).
   */
  private clearRecordingPresence(): void {
    if (!this.presenceSet) return
    this.presenceSet = false
    try {
      const user = this.params.client.user
      if (!user) return
      user.setPresence({ activities: [], status: 'online' })
    } catch (err) {
      this.logger.warn(
        { err, recordingId: this.recordingId },
        'failed to clear recording presence (best-effort)',
      )
    }
  }

  private async resolveSpeakerName(userId: string): Promise<string> {
    // Prefer the GUILD member's display name (per-guild nickname →
    // global display name → username). Falls back to the global User
    // record only if guild-member fetch fails. Without the guild fetch
    // we'd surface raw usernames in webhook captions even when the
    // speaker has a server nickname set — which is what every other
    // Discord client shows.
    try {
      const guild = await this.params.client.guilds.fetch(this.guildId)
      const member = await guild.members.fetch(userId)
      // discord.js `member.displayName` = nickname ?? user.globalName ?? user.username
      if (member.displayName) return member.displayName
    } catch {
      // guild/member fetch can fail when the bot lost guild access or
      // the user left the guild. Fall through to the global User lookup.
    }
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
