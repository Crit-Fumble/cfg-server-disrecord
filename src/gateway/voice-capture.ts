/**
 * VoiceCapture — joins a Discord voice channel with the container's own bot
 * client and fans each speaker's audio out to two sinks:
 *
 *   1. PcmCapture        — decodes opus → PCM, writes per-speaker .pcm files
 *                          for the end-of-session mp3 mix.
 *   2. RecordingSession  — decodes opus → PCM, streams to Deepgram for live
 *                          transcription (no-op when transcription disabled).
 *
 * Ported from cfg-core-server's `services/disrecord/voice-manager.ts`,
 * minus the opus-bus publish (there is no SSE fan-out in standalone mode —
 * both consumers live in-process).
 *
 * One VoiceCapture instance per active recording.
 */

import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
  type AudioReceiveStream,
} from '@discordjs/voice'
import type { Client, VoiceState } from 'discord.js'
import opus from '@discordjs/opus'
import type { Logger } from '../logger.js'
import type { RecordingSession } from '../recording/recording-session.js'
import type { PcmCapture } from '../recording/pcm-capture.js'
import type { ConsentManager } from '../consent/consent-manager.js'
import { recoverVoiceConnection } from './voice-reconnect.js'

/** 48 kHz mono — what Deepgram + PcmCapture both expect. */
const PCM_SAMPLE_RATE = 48_000
const PCM_CHANNELS = 1

/**
 * How long after a gateway (re)connect a "we left voice" delta is treated as
 * outage fallout rather than a deliberate kick. Mirrors core-server's
 * `READY_SETTLE_MS` in events-gateway.ts — same hazard, same shape.
 */
const RECONNECT_SETTLE_MS = 15_000

/**
 * Decide whether a voice-state change means "a human removed this bot from
 * the channel we are recording".
 *
 * Pulled out as a pure function because it is the whole policy: close codes
 * cannot express it. Discord sends 4014 for BOTH a deliberate kick and a
 * dropped gateway session, so keying off the code either fights real kicks or
 * abandons real blips. The bot's own voice state is unambiguous.
 *
 * Returns a human-readable reason, or null when the change is not our removal.
 */
export function classifyOwnRemoval(params: {
  botUserId: string | undefined
  ourChannelId: string
  subjectId: string
  oldChannelId: string | null
  newChannelId: string | null
}): string | null {
  const { botUserId, ourChannelId, subjectId, oldChannelId, newChannelId } = params
  if (!botUserId || subjectId !== botUserId) return null
  // Only a transition OUT of the channel we are recording counts. Joining it,
  // or any change while already elsewhere, is not a removal.
  if (oldChannelId !== ourChannelId || newChannelId === ourChannelId) return null
  return newChannelId === null
    ? 'disconnected from voice by a user'
    : `moved to another voice channel by a user (${newChannelId})`
}

export class VoiceJoinError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'VoiceJoinError'
  }
}

export interface VoiceCaptureParams {
  client: Client
  guildId: string
  voiceChannelId: string
  /** Transcription sink. */
  session: RecordingSession
  /** mp3-mix sink. */
  pcmCapture: PcmCapture
  /** Consent source — drives late-joiner prompts on voice-state changes. */
  consent: ConsentManager
  /**
   * Called when a HUMAN removes the bot from voice (Discord's "Disconnect",
   * a move to another channel, or the channel being deleted). That is an
   * instruction, not a fault: the recording should end rather than be
   * rejoined. Absent ⇒ the capture just stands down without ending anything.
   */
  onExplicitDisconnect?: (reason: string) => void
  logger: Logger
}

export class VoiceCapture {
  private connection: VoiceConnection | null = null
  private readonly subscriptions = new Map<string, AudioReceiveStream>()
  private readonly decoders = new Map<string, opus.OpusEncoder>()
  /**
   * voiceStateUpdate listener — fires the consent prompt the moment a
   * non-bot user JOINS the voice channel we're recording, rather than
   * waiting until they first speak. The previous "prompt on first
   * speech" path is still there for safety (it no-ops if we've already
   * marked the user seen), but the prompt now lands in their notifications
   * the instant they join.
   *
   * Retained as a field so {@link leave} can detach it cleanly when the
   * session ends — leaks would accumulate across self-host sessions.
   */
  private voiceStateListener: ((oldState: VoiceState, newState: VoiceState) => void) | null = null
  /** Set by {@link leave} so in-flight recovery stands down instead of resurrecting voice. */
  private stopped = false
  /** Guards against overlapping recovery loops when Disconnected fires repeatedly. */
  private recovering = false
  /**
   * Set when a human removed the bot from voice. Suppresses recovery — we do
   * NOT rejoin a channel someone deliberately kicked us out of.
   */
  private explicitlyRemoved = false
  /**
   * When the gateway last (re)connected. A voice-state "we left" delta that
   * lands right after a resume is almost certainly Discord reconciling a
   * server-side drop from the outage we just rode out — NOT a human kick.
   * Treating it as deliberate would end a recording on exactly the blip this
   * whole module exists to survive, so those deltas are ignored.
   */
  private lastShardReconnectAt = 0
  private shardListeners: Array<[string, (...args: unknown[]) => void]> = []

  constructor(private readonly params: VoiceCaptureParams) {}

  /**
   * Join the voice channel and start forwarding opus frames to both sinks.
   * Throws {@link VoiceJoinError} if the guild/channel isn't reachable or the
   * connection never reaches Ready state.
   */
  async join(joinTimeoutMs = 15_000): Promise<void> {
    const { client, guildId, voiceChannelId, logger } = this.params

    const guild = await client.guilds.fetch(guildId).catch((err) => {
      throw new VoiceJoinError(`Cannot fetch guild ${guildId} — bot not invited?`, err)
    })
    const channel = await guild.channels.fetch(voiceChannelId).catch((err) => {
      throw new VoiceJoinError(`Cannot fetch channel ${voiceChannelId}`, err)
    })
    if (!channel || !channel.isVoiceBased()) {
      throw new VoiceJoinError(`Channel ${voiceChannelId} is not a voice channel`)
    }

    const connection = joinVoiceChannel({
      guildId,
      channelId: voiceChannelId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, // must hear to receive audio
      selfMute: true, // bot doesn't speak
    })

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, joinTimeoutMs)
    } catch (err) {
      try {
        connection.destroy()
      } catch {
        /* swallow */
      }
      throw new VoiceJoinError(`Voice connection never reached Ready for guild ${guildId}`, err)
    }

    connection.receiver.speaking.on('start', (userId: string) => this.onSpeakerStart(userId))
    connection.receiver.speaking.on('end', (userId: string) => this.onSpeakerEnd(userId))

    // A dropped voice connection must never silently end the capture. See
    // voice-reconnect.ts for why the library's own retry is not enough.
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void this.onDisconnected(connection)
    })

    // Voice-join consent trigger. Discord fires voiceStateUpdate for
    // joins, leaves, mutes, deafens, channel switches — we filter to
    // "joined OUR voice channel for the first time" and prompt then.
    // noteSpeaker is idempotent (marks `seen`), so the existing onSpeakerStart
    // path stays a safe second trigger if the listener somehow misses
    // the event.
    this.voiceStateListener = (oldState, newState) => {
      try {
        // OUR OWN removal, checked FIRST — the generic guards below would
        // swallow it (a bot leaving trips both the `oldState` early-return
        // and the bot-member skip).
        //
        // This is the authoritative signal for "a human disconnected us".
        // Close codes cannot carry it: Discord sends 4014 both for a
        // deliberate kick AND for a dropped gateway session, so keying off
        // the code alone would either fight real kicks or abandon real
        // blips. The voice state is unambiguous.
        if (newState.id === client.user?.id) {
          const reason = classifyOwnRemoval({
            botUserId: client.user?.id,
            ourChannelId: voiceChannelId,
            subjectId: newState.id,
            oldChannelId: oldState.channelId,
            newChannelId: newState.channelId,
          })
          if (reason && !this.stopped) {
            const sinceReconnect = Date.now() - this.lastShardReconnectAt
            if (sinceReconnect < RECONNECT_SETTLE_MS) {
              logger.warn(
                { guildId, voiceChannelId, reason, sinceReconnect },
                'ignoring voice-state removal inside the reconnect settling window — treating as outage fallout, not a kick',
              )
              return
            }
            this.explicitlyRemoved = true
            logger.info({ guildId, voiceChannelId, reason }, 'bot removed from voice — ending recording, not rejoining')
            this.params.onExplicitDisconnect?.(reason)
          }
          return
        }
        if (oldState.channelId === voiceChannelId) return // already here / left from here
        if (newState.channelId !== voiceChannelId) return // not joining our channel
        if (newState.member?.user?.bot) return // skip bot members (including ourselves)
        const userId = newState.id // discord.js VoiceState.id IS the user id
        if (!userId) return
        logger.info({ userId, voiceChannelId }, 'voice-join detected — prompting consent')
        this.params.consent.noteSpeaker(userId)
      } catch (err) {
        logger.warn({ err }, 'voiceStateUpdate listener threw')
      }
    }
    client.on('voiceStateUpdate', this.voiceStateListener)

    // Stamp every (re)connect so the settling window above can tell outage
    // fallout from a deliberate kick.
    for (const evt of ['shardResume', 'shardReady', 'ready'] as const) {
      const fn = () => {
        this.lastShardReconnectAt = Date.now()
      }
      client.on(evt, fn)
      this.shardListeners.push([evt, fn])
    }

    this.connection = connection
    logger.info({ guildId, voiceChannelId }, 'voice channel joined; capturing audio')
  }

  /**
   * Recover a dropped voice connection.
   *
   * Deliberately does NOT rebuild the receiver subscriptions. In
   * `@discordjs/voice` the `AudioReceiveStream`s are torn down only on the
   * `Destroyed` status, and `updateReceiveBindings` re-points the receiver's
   * ws/udp handlers at the new networking instance on every rejoin — so the
   * existing per-speaker streams keep flowing once Ready returns. Recreating
   * them here would drop audio, not restore it.
   */
  private async onDisconnected(connection: VoiceConnection): Promise<void> {
    if (this.stopped || this.recovering || this.explicitlyRemoved) return
    this.recovering = true
    const { guildId, voiceChannelId, logger } = this.params
    logger.warn({ guildId, voiceChannelId }, 'voice connection disconnected — attempting recovery')

    try {
      // The websocket close and the voiceStateUpdate that explains it race.
      // Give the state a moment to land before deciding this was a fault
      // rather than an instruction — otherwise a deliberate kick briefly
      // looks like a blip and we start rejoining before standing down.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      if (this.explicitlyRemoved || this.stopped) {
        logger.info({ guildId }, 'voice loss was a deliberate removal — standing down without rejoining')
        return
      }

      // The library auto-rejoins on its own for non-4014 closes. Give that a
      // brief grace period before we start sending our own join payloads, so
      // we don't race it during an ordinary blip.
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 5_000)
        logger.info({ guildId }, 'voice connection self-healed — audio capture resumed')
        return
      } catch {
        /* fall through to driven recovery */
      }

      await recoverVoiceConnection(
        {
          rejoin: () => connection.rejoin(),
          awaitReady: async (timeoutMs) => {
            await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs)
          },
          isDestroyed: () =>
            this.stopped ||
            this.explicitlyRemoved ||
            connection.state.status === VoiceConnectionStatus.Destroyed,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => Date.now(),
          logger,
        },
        {},
      )
    } catch (err) {
      logger.error({ err, guildId }, 'voice recovery loop threw unexpectedly')
    } finally {
      this.recovering = false
    }
  }

  private onSpeakerStart(userId: string): void {
    const { session, pcmCapture, consent, logger } = this.params
    void session.onSpeakerStart(userId)
    pcmCapture.onSpeakerStart(userId)
    // A speaker we've never seen who hasn't consented gets a prompt.
    consent.noteSpeaker(userId)

    if (this.subscriptions.has(userId) || !this.connection) return
    const stream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    })
    this.subscriptions.set(userId, stream)

    if (!this.decoders.has(userId)) {
      this.decoders.set(userId, new opus.OpusEncoder(PCM_SAMPLE_RATE, PCM_CHANNELS))
    }

    stream.on('data', (opusFrame: Buffer) => {
      let pcm: Buffer
      try {
        const decoder = this.decoders.get(userId)
        if (!decoder) return
        pcm = decoder.decode(opusFrame)
      } catch (err) {
        logger.debug({ err, userId }, 'opus decode failed (single frame)')
        return
      }
      session.onSpeakerData(userId, pcm)
      pcmCapture.onSpeakerData(userId, pcm)
    })
    stream.on('error', (err) => {
      logger.warn({ err, userId }, 'audio receive stream error')
    })
  }

  private onSpeakerEnd(userId: string): void {
    void this.params.session.onSpeakerEnd(userId)
    this.params.pcmCapture.onSpeakerEnd(userId)
  }

  /** Leave the voice channel and tear down all subscriptions. Idempotent. */
  leave(reason: string): void {
    // Set before anything else so an in-flight recovery loop stands down
    // rather than rejoining a channel we are deliberately leaving.
    this.stopped = true
    if (this.voiceStateListener) {
      this.params.client.off('voiceStateUpdate', this.voiceStateListener)
      this.voiceStateListener = null
    }
    for (const [evt, fn] of this.shardListeners) {
      this.params.client.off(evt, fn as never)
    }
    this.shardListeners = []
    for (const stream of this.subscriptions.values()) {
      stream.destroy()
    }
    this.subscriptions.clear()
    this.decoders.clear()
    if (this.connection) {
      try {
        this.connection.destroy()
      } catch {
        /* already destroyed */
      }
      this.connection = null
    }
    this.params.logger.info({ reason }, 'voice channel left')
  }
}
