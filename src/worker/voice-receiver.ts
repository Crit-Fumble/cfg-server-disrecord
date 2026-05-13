/**
 * VoiceReceiver — Discord voice channel subscriber.
 *
 * Joins the target voice channel via @discordjs/voice (using our cross-process
 * gateway-bridge adapter), subscribes to each speaker's Opus stream, decodes
 * Opus → PCM, and feeds the PCM into the RecordingSession.
 *
 * Boundary: this module owns the Discord side (voice WSS, opus decode); the
 * RecordingSession owns the Deepgram side. They communicate exclusively
 * through onSpeakerStart / onSpeakerData / onSpeakerEnd.
 */

import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
  type AudioReceiveStream,
  type DiscordGatewayAdapterCreator,
} from '@discordjs/voice'
import opus from '@discordjs/opus'
import type { Logger } from '../logger.js'
import type { RecordingSession } from './recording-session.js'
import { OPUS_SAMPLE_RATE } from './recording-session.js'

export interface VoiceReceiverParams {
  guildId: string
  channelId: string
  adapterCreator: DiscordGatewayAdapterCreator
  session: RecordingSession
  /** Connect timeout (ms) before failing the join. Default 15s. */
  connectTimeoutMs?: number
  logger?: Logger
}

export class VoiceReceiver {
  private connection: VoiceConnection | null = null
  private decoder: opus.OpusEncoder
  private readonly subscribed = new Map<string, AudioReceiveStream>()

  constructor(private readonly params: VoiceReceiverParams) {
    // 48 kHz, mono — matches what Deepgram is configured for upstream
    // (RecordingSession passes OPUS_SAMPLE_RATE + channels=1 to createDeepgramStream).
    this.decoder = new opus.OpusEncoder(OPUS_SAMPLE_RATE, 1)
  }

  async join(): Promise<void> {
    const { guildId, channelId, adapterCreator, connectTimeoutMs, logger } = this.params

    this.connection = joinVoiceChannel({
      guildId,
      channelId,
      adapterCreator,
      selfDeaf: false, // must hear to receive audio
      selfMute: true, // bot doesn't speak
    })

    await entersState(this.connection, VoiceConnectionStatus.Ready, connectTimeoutMs ?? 15_000)
    logger?.info({ guildId, channelId }, 'voice connection ready')

    // Wire receiver: subscribe per speaker on start; tear down on end.
    const receiver = this.connection.receiver
    receiver.speaking.on('start', (userId) => {
      void this.handleSpeakerStart(userId)
    })
    receiver.speaking.on('end', (userId) => {
      void this.handleSpeakerEnd(userId)
    })
  }

  private async handleSpeakerStart(userId: string): Promise<void> {
    const { session, logger } = this.params
    await session.onSpeakerStart(userId)

    // Subscribe to this speaker's opus stream with Manual end behavior —
    // we close it ourselves on speaking-end so a brief mid-utterance pause
    // doesn't tear the subscription down.
    if (this.subscribed.has(userId)) return
    const stream = this.connection!.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    })
    this.subscribed.set(userId, stream)

    stream.on('data', (opusFrame: Buffer) => {
      try {
        const pcm = this.decoder.decode(opusFrame)
        session.onSpeakerData(userId, pcm)
      } catch (err) {
        // Opus decode failures happen on DAVE-encrypted channels and on the
        // occasional malformed frame. Single failures are non-fatal; chronic
        // failure is what the upstream DAVE canary tracks (Phase 0.5).
        logger?.debug({ err, userId }, 'opus decode failed (single frame)')
      }
    })

    stream.on('error', (err) => {
      logger?.warn({ err, userId }, 'audio receive stream error')
    })
  }

  private async handleSpeakerEnd(userId: string): Promise<void> {
    const { session, logger } = this.params
    await session.onSpeakerEnd(userId)

    // Leave the subscription open across silence — same lesson as the
    // Deepgram WS keepalive (cfg-core-server#63). Tearing down per-utterance
    // costs reconnect latency on the next start without any real resource
    // win. The subscription closes on voice connection destroy.
    logger?.debug({ userId }, 'speaker end (subscription held)')
  }

  /** Tear down the voice connection + all subscriptions. */
  destroy(): void {
    for (const stream of this.subscribed.values()) {
      stream.destroy()
    }
    this.subscribed.clear()
    if (this.connection) {
      this.connection.destroy()
      this.connection = null
    }
  }
}
