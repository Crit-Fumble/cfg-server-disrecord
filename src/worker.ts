/**
 * Worker — per-session recording process.
 *
 * Receives voice handoff tokens via env (set by the gateway when it spawned
 * this container). Connects directly to Discord voice WSS, captures audio,
 * streams to Deepgram if enabled, persists transcript to core-server.
 *
 * v0.1 skeleton — port voice capture + Deepgram client from cfg-core-server.
 */

import { logger as rootLogger } from './logger.js'
import type { WorkerConfig } from './config.js'

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

  // TODO(cfg-core-dev-tools#119): port from cfg-core-server:
  //   - src/services/discord/voice/capabilities/transcription.ts
  //   - src/clients/deepgram/client.ts
  //   - src/services/discord/voice/recording-indicators.ts (member-resolve fix)
  //
  // Steps when ported:
  //   1. Join the voice channel using handoff tokens (no gateway connection
  //      needed — go direct to the voice WSS endpoint with session_id + token).
  //   2. For each consenting speaker, open a Deepgram WS (or skip if mode=disabled).
  //   3. Stream PCM frames to Deepgram. Keep the WS open across silence
  //      (lesson from cfg-core-server#63 — do NOT idle-close).
  //   4. Persist final transcript via core-server API on session end.
  //   5. Emit final billing tick (uptime + optional transcription minutes).

  logger.warn('worker is a stub — see cfg-core-dev-tools#119')

  // Keep the process alive so the container doesn't exit mid-implementation.
  // Replace with actual session-end signal once voice handoff is wired.
  await new Promise<void>((resolve) => {
    const onSignal = () => resolve()
    process.on('SIGTERM', onSignal)
    process.on('SIGINT', onSignal)
  })

  logger.info('worker shutting down')
}
