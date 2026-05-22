/**
 * `serve`-mode entrypoint — the standalone unified recording container.
 *
 * Phase 1: boots the container's own Discord bot, joins voice on a
 * `/resesh start` slash command, captures opus, mixes mp3, transcribes with
 * a BYO Deepgram key, posts a Discord thread — with ZERO core-server
 * involvement. The bot logs in at boot and stays connected.
 *
 * Boots, in order:
 *   1. Discord gateway  — bot logs in, waits for ready
 *   2. RecordingService — registry + LocalDirSink + config
 *   3. slash handler    — /resesh interaction listener
 *   4. control server   — HTTP API on 127.0.0.1
 * then waits for SIGTERM/SIGINT, stops every active recording, and exits.
 */

import { logger as rootLogger } from './logger.js'
import { resolveStandaloneConfig, type StandaloneConfig } from './config.js'
import { startGateway, stopGateway } from './gateway/discord-gateway.js'
import { RecordingService } from './recording/recording-service.js'
import { LocalDirSink } from './recording/output-sink.js'
import { registerSlashHandler } from './discord/slash-handler.js'
import { startControlServer } from './control/server.js'

const logger = rootLogger.child({ module: 'standalone' })

export async function startStandalone(config: StandaloneConfig): Promise<void> {
  logger.info(
    {
      outputDir: config.outputDir,
      controlPort: config.controlPort,
      transcription: config.deepgramKey != null,
      controlAuth: config.controlToken != null,
    },
    'starting cfg-server-disrecord in serve mode',
  )

  // ── 1. Discord gateway — log in at boot, stay connected.
  const client = await startGateway(config.discordToken, rootLogger.child({ module: 'gateway' }))

  // ── 2. RecordingService — Phase 1 always uses the local-dir sink.
  const sink = new LocalDirSink(config.outputDir, rootLogger.child({ module: 'output-sink' }))
  const service = new RecordingService(client, sink, config, rootLogger)

  // ── 3. slash handler
  registerSlashHandler(client, service, rootLogger.child({ module: 'slash-handler' }))

  // ── 4. HTTP control server (127.0.0.1)
  const control = await startControlServer({
    service,
    port: config.controlPort,
    token: config.controlToken,
    logger: rootLogger.child({ module: 'control' }),
  })

  logger.info('serve mode ready — awaiting slash commands / control API')

  // ── wait for shutdown
  await new Promise<void>((resolve) => {
    const onSignal = (signal: string) => {
      logger.info({ signal }, 'shutdown signal received')
      resolve()
    }
    process.once('SIGTERM', () => onSignal('SIGTERM'))
    process.once('SIGINT', () => onSignal('SIGINT'))
  })

  logger.info('stopping — finalizing active recordings')
  await service.stopAll()
  await control.close().catch((err) => logger.warn({ err }, 'control server close failed'))
  await stopGateway(client, rootLogger.child({ module: 'gateway' }))
  logger.info('serve mode stopped cleanly')
}
