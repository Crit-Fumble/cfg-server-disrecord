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

/** 48 kHz mono — what Deepgram + PcmCapture both expect. */
const PCM_SAMPLE_RATE = 48_000
const PCM_CHANNELS = 1

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

    // Voice-join consent trigger. Discord fires voiceStateUpdate for
    // joins, leaves, mutes, deafens, channel switches — we filter to
    // "joined OUR voice channel for the first time" and prompt then.
    // noteSpeaker is idempotent (marks `seen`), so the existing onSpeakerStart
    // path stays a safe second trigger if the listener somehow misses
    // the event.
    this.voiceStateListener = (oldState, newState) => {
      try {
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

    this.connection = connection
    logger.info({ guildId, voiceChannelId }, 'voice channel joined; capturing audio')
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
    if (this.voiceStateListener) {
      this.params.client.off('voiceStateUpdate', this.voiceStateListener)
      this.voiceStateListener = null
    }
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
