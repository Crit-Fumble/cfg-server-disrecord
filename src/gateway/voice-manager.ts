/**
 * VoiceManager — joins voice channels and forwards opus frames to the
 * per-session AudioChannel on the OpusBus. One VoiceManager per gateway
 * process; one VoiceConnection per active session (one per guild).
 */

import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
  type AudioReceiveStream,
} from '@discordjs/voice'
import type { Client } from 'discord.js'
import type { Logger } from '../logger.js'
import type { OpusBus, AudioChannel } from './opus-bus.js'

export class VoiceJoinError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'VoiceJoinError'
  }
}

export interface VoiceManagerParams {
  client: Client
  bus: OpusBus
  logger?: Logger
  /** Override for entersState timeout. Default 15s. */
  joinTimeoutMs?: number
}

interface ActiveVoice {
  connection: VoiceConnection
  channel: AudioChannel
  subscriptions: Map<string, AudioReceiveStream>
}

export class VoiceManager {
  private active = new Map<string, ActiveVoice>() // installationId → state

  constructor(private readonly params: VoiceManagerParams) {}

  /**
   * Join a voice channel and start forwarding opus frames to the bus.
   * Throws VoiceJoinError if the guild/channel isn't reachable or the
   * connection never reaches Ready state.
   */
  async join(installationId: string, guildId: string, channelId: string): Promise<void> {
    const { client, bus, logger, joinTimeoutMs } = this.params

    const guild = await client.guilds.fetch(guildId).catch((err) => {
      throw new VoiceJoinError(`Cannot fetch guild ${guildId} — bot not invited?`, err)
    })
    const channel = await guild.channels.fetch(channelId).catch((err) => {
      throw new VoiceJoinError(`Cannot fetch channel ${channelId}`, err)
    })
    if (!channel || !('joinable' in channel) || !channel.isVoiceBased()) {
      throw new VoiceJoinError(`Channel ${channelId} is not a voice channel`)
    }

    const connection = joinVoiceChannel({
      guildId,
      channelId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, // must hear to receive audio
      selfMute: true, // bot doesn't speak
    })

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, joinTimeoutMs ?? 15_000)
    } catch (err) {
      try {
        connection.destroy()
      } catch {
        /* swallow */
      }
      throw new VoiceJoinError(`Voice connection never reached Ready for guild ${guildId}`, err)
    }

    const audioChannel = bus.open(installationId)
    const subscriptions = new Map<string, AudioReceiveStream>()

    const onStart = (userId: string) => {
      audioChannel.publish({ kind: 'speaker-start', speakerId: userId })

      if (subscriptions.has(userId)) return
      const stream = connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.Manual },
      })
      subscriptions.set(userId, stream)

      stream.on('data', (opusFrame: Buffer) => {
        audioChannel.publish({ kind: 'speaker-data', speakerId: userId, opus: opusFrame })
      })
      stream.on('error', (err) => {
        logger?.warn({ err, userId, installationId }, 'audio receive stream error')
      })
    }

    const onEnd = (userId: string) => {
      audioChannel.publish({ kind: 'speaker-end', speakerId: userId })
    }

    connection.receiver.speaking.on('start', onStart)
    connection.receiver.speaking.on('end', onEnd)

    this.active.set(installationId, { connection, channel: audioChannel, subscriptions })
    logger?.info({ installationId, guildId, channelId }, 'voice channel joined; forwarding opus')
  }

  /**
   * Leave a voice channel and close the audio channel. Idempotent — leaving
   * a session that isn't active is a no-op.
   */
  leave(installationId: string, reason: string): void {
    const state = this.active.get(installationId)
    if (!state) return
    for (const stream of state.subscriptions.values()) {
      stream.destroy()
    }
    state.subscriptions.clear()
    try {
      state.connection.destroy()
    } catch {
      /* already destroyed */
    }
    this.params.bus.close(installationId, reason)
    this.active.delete(installationId)
    this.params.logger?.info({ installationId, reason }, 'voice channel left')
  }

  has(installationId: string): boolean {
    return this.active.has(installationId)
  }

  /** Test-only: leave all active connections. */
  __resetForTests(): void {
    for (const installationId of this.active.keys()) {
      this.leave(installationId, 'test-reset')
    }
  }
}
