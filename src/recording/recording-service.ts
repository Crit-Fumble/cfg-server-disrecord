/**
 * RecordingService — the standalone container's recording façade.
 *
 * Single entry point shared by the HTTP control server and the Discord
 * slash-command handler. Owns the {@link SessionRegistry}, the
 * {@link OutputSink}, the bot client, and the resolved config; turns
 * "start / pause / resume / stop / status" requests into
 * {@link SessionController} lifecycle calls.
 *
 * The one-recording-per-guild lock lives here via SessionRegistry.reserve().
 */

import { nanoid } from './nanoid.js'
import { SessionController } from './session-controller.js'
import { SessionRegistry, GuildConflictError, SessionNotFoundError } from './session-registry.js'
import { CoreServerClient } from '../phone-home/core-client.js'
import type { SettingsStore } from '../settings/settings-store.js'
import type { InteractionDelivery } from '../gateway/interaction-delivery.js'
import type { Client } from 'discord.js'
import type { OutputSink } from './output-sink.js'
import type { StandaloneConfig } from '../config.js'
import type { Logger } from '../logger.js'

export { GuildConflictError, SessionNotFoundError }

export interface StartRecordingRequest {
  guildId: string
  voiceChannelId: string
  /** Defaults to the voice channel. */
  textChannelId?: string
  /** Defaults to true. Ignored (forced false) when transcription is disabled. */
  transcription?: boolean
  /** Discord user id of the invoker — pre-consented. */
  invokerUserId?: string
  /**
   * Reuse this existing thread instead of creating one.
   *
   * Without it every start created a NEW thread named
   * `<voice> - <date> - <kind>` — so stopping and restarting within a session,
   * or restarting after a drop, left identically-named duplicates. The caller
   * (core-server) decides which thread that is; the worker just honours it.
   */
  threadId?: string
}

export class RecordingService {
  private readonly registry = new SessionRegistry()
  /**
   * Phone-home client. Constructed once from `config.cfg` — a no-op client
   * when self-host. Shared by every SessionController this service spawns.
   */
  private readonly core: CoreServerClient
  /**
   * How Discord delivers this app's interactions. Null when unknown or
   * CFG-hosted (where core owns the endpoint and this question is moot).
   */
  private interactionDelivery: InteractionDelivery | null = null

  constructor(
    private readonly client: Client,
    private readonly sink: OutputSink,
    private readonly config: StandaloneConfig,
    private readonly logger: Logger,
    /**
     * The container's own guild/channel settings. READ-ONLY here — writes go
     * through the control API, which holds the same instance.
     */
    private readonly settingsStore: SettingsStore,
  ) {
    this.core = new CoreServerClient(config.cfg, logger.child({ module: 'core-client' }))
  }

  /** Recorded at boot so `diagnostics()` can warn where an operator is looking. */
  setInteractionDelivery(delivery: InteractionDelivery | null): void {
    this.interactionDelivery = delivery
  }

  /** True once the Discord client is connected and ready. */
  get botReady(): boolean {
    return this.client.isReady()
  }

  get activeCount(): number {
    return this.registry.size
  }

  /**
   * Start a new recording. Throws {@link GuildConflictError} when the guild
   * already has an active recording. Resolves once voice is joined and the
   * initial consent prompt is posted.
   */
  async start(req: StartRecordingRequest): Promise<string> {
    // CFG-hosted: use the installationId as our recording id so every
    // subsequent control-API call from core-server (pause / resume / stop
    // / consent push) — all of which use installationId in the URL — hits
    // a registry entry we actually have. Without this the container
    // generates a fresh nanoid and the registry lookup misses on every
    // control call, silently dropping the request. Self-host has no
    // installationId; nanoid is fine because the container is the only
    // surface that ever needs to address its own sessions.
    const recordingId = this.config.cfg?.installationId ?? nanoid()
    const textChannelId = req.textChannelId ?? req.voiceChannelId
    // Reserve the guild slot up front so a concurrent start can't race past
    // the lock while we're joining voice.
    this.registry.reserve(recordingId, req.guildId)

    // Transcription is on unless the session's Deepgram mode is 'disabled'
    // (and the caller didn't opt out). Platform mode has no static key — the
    // container mints grant tokens — so a missing `deepgramKey` no longer
    // forces record-only; only mode='disabled' does.
    const transcription =
      this.config.deepgramMode !== 'disabled' && (req.transcription ?? true)

    const controller = new SessionController({
      recordingId,
      client: this.client,
      guildId: req.guildId,
      voiceChannelId: req.voiceChannelId,
      textChannelId,
      transcription,
      deepgramMode: this.config.deepgramMode,
      deepgramKey: this.config.deepgramKey ?? null,
      deepgramModel: this.config.deepgramModel,
      deepgramLanguage: this.config.deepgramLanguage,
      chunkMinutes: this.config.chunkMinutes,
      sink: this.sink,
      // Opt-in tuning-corpus retention (#12). The PCM lands next to the
      // finalized recordings so an operator has one place to look — and one
      // place to clean up.
      keepPcmDir: this.config.keepPcm ? this.config.outputDir : undefined,
      invokerUserId: req.invokerUserId,
      existingThreadId: req.threadId ?? null,
      cfg: this.config.cfg,
      consentStorePath: this.config.consentStorePath,
      settingsStore: this.settingsStore,
      core: this.core,
      logger: this.logger.child({ recordingId }),
    })

    try {
      await controller.start()
    } catch (err) {
      this.registry.release(req.guildId, recordingId)
      throw err
    }
    this.registry.commit(controller)
    return recordingId
  }

  pause(recordingId: string): void {
    this.require(recordingId).pause()
  }

  resume(recordingId: string): void {
    this.require(recordingId).resume()
  }

  /**
   * Apply a consent update pushed by core-server (CFG-hosted control API).
   * Throws {@link SessionNotFoundError} when the recording isn't active.
   */
  pushConsent(recordingId: string, discordUserId: string, consented: boolean, remember = false): void {
    this.require(recordingId).pushConsent(discordUserId, consented, remember)
  }

  /**
   * Stop a recording. Awaits the full runStop pipeline (mix, upload,
   * Discord post, cleanup) before resolving so the HTTP caller — and the
   * core-server stop flow that follows it with a hard container kill —
   * see "stopped" only after delivery is actually done. Errors are
   * logged but not rethrown; the registry slot is always released so
   * subsequent starts in the same guild work.
   *
   * Previously this was fire-and-forget (`void controller.stop()`); the
   * HTTP endpoint returned 202 immediately, core-server then killed the
   * container mid-runStop, and the mp3 + VTT + Back-to-Top never landed
   * in Discord. With this change the endpoint blocks until delivery —
   * caller-side timeout (~10 min by default in core-server's control
   * client) is the upper bound on stop latency.
   */
  async stop(recordingId: string): Promise<void> {
    const controller = this.require(recordingId)
    try {
      await controller.stop()
    } catch (err) {
      this.logger.error({ err, recordingId }, 'session stop failed')
    } finally {
      this.registry.remove(recordingId)
    }
  }

  /** Snapshot of one session, or null when it isn't active. */
  describe(recordingId: string): ReturnType<SessionController['describe']> | null {
    return this.registry.get(recordingId)?.describe() ?? null
  }

  /** Snapshot of every active session. */
  list(): Array<ReturnType<SessionController['describe']>> {
    return this.registry.list().map((c) => c.describe())
  }

  /** Active session for a guild, or null. Used by the slash handler. */
  describeByGuild(guildId: string): ReturnType<SessionController['describe']> | null {
    return this.registry.getByGuild(guildId)?.describe() ?? null
  }

  /** Audit webhooks in the session's destination channel. Null = no such session. */
  async auditWebhooks(recordingId: string) {
    return (await this.registry.get(recordingId)?.auditWebhooks()) ?? null
  }

  /** Sweep stale recording webhooks in the session's destination channel. */
  async sweepWebhooks(recordingId: string) {
    const controller = this.registry.get(recordingId)
    if (!controller) return null
    return controller.sweepWebhooks()
  }

  /**
   * Guilds this bot is in, with their voice + text channels — what the
   * self-host dashboard populates its pickers from (#9). Reads the gateway
   * cache only, so it is cheap enough for a polling UI.
   */
  listGuilds(): Array<{
    id: string
    name: string
    voiceChannels: Array<{ id: string; name: string }>
    textChannels: Array<{ id: string; name: string }>
  }> {
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
    return this.client.guilds.cache.map((guild) => {
      const voiceChannels: Array<{ id: string; name: string }> = []
      const textChannels: Array<{ id: string; name: string }> = []
      for (const channel of guild.channels.cache.values()) {
        const entry = { id: channel.id, name: channel.name }
        if (channel.isVoiceBased()) voiceChannels.push(entry)
        else if (channel.isTextBased()) textChannels.push(entry)
      }
      return {
        id: guild.id,
        name: guild.name,
        voiceChannels: voiceChannels.sort(byName),
        textChannels: textChannels.sort(byName),
      }
    })
  }

  /**
   * Boot-state summary for the dashboard (#9). `intents` is what the gateway
   * client was CONFIGURED with — note that Discord refuses the connection
   * outright when a privileged intent is requested but not enabled in the
   * Developer Portal, so a ready bot has necessarily been granted everything
   * listed here. That failure shows up as the container not booting, which is
   * what the dashboard's diagnostics text explains.
   */
  diagnostics(): {
    botReady: boolean
    botTag: string | null
    guildCount: number
    intents: string[]
    activeRecordings: number
    /**
     * `http` means this app's interactions go to `interactionsEndpointUrl` and
     * the consent BUTTONS CANNOT FIRE here. Surfaced so the dashboard can say
     * so where a human is looking, not only in the boot log.
     */
    interactionRoute: 'gateway' | 'http' | 'unknown' | null
    interactionsEndpointUrl: string | null
  } {
    return {
      botReady: this.botReady,
      botTag: this.client.user?.tag ?? null,
      guildCount: this.client.guilds.cache.size,
      intents: this.client.options.intents.toArray(),
      activeRecordings: this.activeCount,
      interactionRoute: this.interactionDelivery?.route ?? null,
      interactionsEndpointUrl: this.interactionDelivery?.endpointUrl ?? null,
    }
  }

  /** Stop every active recording — used on container shutdown. */
  async stopAll(): Promise<void> {
    const all = this.registry.list()
    await Promise.allSettled(
      all.map(async (c) => {
        await c.stop().catch((err) => this.logger.error({ err }, 'stopAll: session stop failed'))
        this.registry.remove(c.recordingId)
      }),
    )
  }

  private require(recordingId: string): SessionController {
    const controller = this.registry.get(recordingId)
    if (!controller) throw new SessionNotFoundError(recordingId)
    return controller
  }
}
