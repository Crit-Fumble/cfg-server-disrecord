/**
 * Worker — per-session recording process.
 *
 * Receives voice handoff tokens via env (set by the gateway when it spawned
 * this container). Wires VoiceReceiver → RecordingSession → core-server
 * transcript callbacks.
 */

import { logger as rootLogger } from './logger.js'
import type { WorkerConfig } from './config.js'
import { RecordingSession, type TranscriptFinalEvent } from './worker/recording-session.js'
import { VoiceReceiver } from './worker/voice-receiver.js'
import { createGatewayBridgeAdapterCreator } from './worker/gateway-bridge.js'

const logger = rootLogger.child({ module: 'worker' })

export async function startWorker(config: WorkerConfig): Promise<void> {
  logger.info(
    {
      guildId: config.guildId,
      channelId: config.channelId,
      installationId: config.installationId,
      deepgramMode: config.deepgramMode,
    },
    'starting cfg-resesh worker',
  )

  // ── 1. RecordingSession — handles per-speaker Deepgram + consent gate
  const deepgramKey =
    config.deepgramMode === 'disabled' ? null : config.deepgramKey ?? null
  // TODO(cfg-core-dev-tools#119): fetch real consent set + speaker name
  // resolver from core-server. For now, accept all speakers verbatim and
  // resolve via the Discord user ID.
  const session = new RecordingSession({
    deepgramApiKey: deepgramKey,
    resolveSpeakerName: async (userId) => userId, // TODO: core-server API call
    onTranscriptFinal: async (event: TranscriptFinalEvent) => {
      // TODO: POST to core-server with auth: ${config.coreServerAuthSecret}
      logger.info(
        {
          speakerId: event.speakerId,
          isRedacted: event.isRedacted,
          startSec: event.startSec.toFixed(2),
          chars: event.transcript.length,
        },
        'transcript final (TODO: POST to core-server)',
      )
    },
    logger: rootLogger.child({ module: 'recording-session' }),
  })

  // ── 2. GatewayBridge adapter — cross-process voice events
  // TODO: derive gatewayUrl from a worker env var (RESESH_GATEWAY_URL) once
  // the gateway exposes /internal/voice/events + send-payload endpoints.
  const adapterCreator = createGatewayBridgeAdapterCreator({
    gatewayUrl: process.env.RESESH_GATEWAY_URL ?? 'http://cfg-resesh-gateway:4400',
    authSecret: config.coreServerAuthSecret,
    guildId: config.guildId,
    seedVoiceServerUpdate: {
      guild_id: config.guildId,
      token: config.voiceToken,
      endpoint: config.voiceEndpoint,
    },
    seedVoiceStateUpdate: {
      guild_id: config.guildId,
      channel_id: config.channelId,
      user_id: config.userId,
      session_id: config.voiceSessionId,
      deaf: false,
      mute: false,
      self_deaf: false,
      self_mute: true,
      self_video: false,
      suppress: false,
      request_to_speak_timestamp: null,
    },
    logger: rootLogger.child({ module: 'gateway-bridge' }),
  })

  // ── 3. VoiceReceiver — joins the channel, subscribes to opus streams
  const receiver = new VoiceReceiver({
    guildId: config.guildId,
    channelId: config.channelId,
    adapterCreator,
    session,
    logger: rootLogger.child({ module: 'voice-receiver' }),
  })

  try {
    await receiver.join()
    logger.info('voice channel joined — recording active')
  } catch (err) {
    logger.fatal({ err }, 'failed to join voice channel — exiting')
    process.exit(1)
  }

  // Wait for shutdown signal. Final billing tick + session close happen here.
  await new Promise<void>((resolve) => {
    const onSignal = (signal: string) => {
      logger.info({ signal }, 'shutdown signal received')
      resolve()
    }
    process.on('SIGTERM', () => onSignal('SIGTERM'))
    process.on('SIGINT', () => onSignal('SIGINT'))
  })

  logger.info('worker shutting down')
  receiver.destroy()
  await session.stop()
  // TODO(cfg-core-dev-tools#120): emit final billing tick to core-server.
  logger.info('worker stopped cleanly')
}
