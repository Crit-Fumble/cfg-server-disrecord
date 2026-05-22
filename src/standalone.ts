/**
 * `serve`-mode entrypoint — the unified recording container.
 *
 * Boots the container's own Discord bot, joins voice on a `/resesh start`
 * slash command (or a control-API call), captures opus, mixes mp3,
 * transcribes, and posts a Discord thread.
 *
 * One image, two modes — picked by whether `config.cfg` is set:
 *   Self-host  — no `CORE_SERVER_URL`. LocalDirSink, 127.0.0.1 control bind,
 *                static `CONTROL_TOKEN` auth, no phone-home.
 *   CFG-hosted — `CORE_SERVER_URL` present. SpacesSink (when `DO_SPACES_*`
 *                set), 0.0.0.0 control bind, per-session-JWT auth, billing /
 *                consent / transcript phone-home.
 *
 * Boots, in order:
 *   1. Discord gateway  — bot logs in, waits for ready
 *   2. RecordingService — registry + sink + config
 *   3. slash handler    — /resesh interaction listener
 *   4. control server   — HTTP API
 * then waits for SIGTERM/SIGINT, stops every active recording, and exits.
 */

import { logger as rootLogger } from './logger.js'
import { resolveStandaloneConfig, type StandaloneConfig } from './config.js'
import { startGateway, stopGateway } from './gateway/discord-gateway.js'
import { RecordingService } from './recording/recording-service.js'
import { LocalDirSink, SpacesSink, type OutputSink } from './recording/output-sink.js'
import { registerSlashHandler } from './discord/slash-handler.js'
import { startControlServer } from './control/server.js'
import { createControlAuthenticator } from './control/auth.js'

const logger = rootLogger.child({ module: 'standalone' })

export async function startStandalone(config: StandaloneConfig): Promise<void> {
  const cfgHosted = config.cfg != null
  logger.info(
    {
      outputDir: config.outputDir,
      controlPort: config.controlPort,
      transcription: config.deepgramKey != null,
      mode: cfgHosted ? 'cfg-hosted' : 'self-host',
      spacesUpload: config.cfg?.spaces != null,
    },
    'starting cfg-server-disrecord in serve mode',
  )

  // ── 1. Discord gateway — log in at boot, stay connected.
  const client = await startGateway(config.discordToken, rootLogger.child({ module: 'gateway' }))

  // ── 2. RecordingService — sink picked by mode.
  // CFG-hosted with DO Spaces creds ⇒ upload to Spaces; otherwise local dir.
  const sink: OutputSink = config.cfg?.spaces
    ? new SpacesSink(config.cfg.spaces, rootLogger.child({ module: 'spaces-sink' }))
    : new LocalDirSink(config.outputDir, rootLogger.child({ module: 'output-sink' }))
  const service = new RecordingService(client, sink, config, rootLogger)

  // ── 3. slash handler
  registerSlashHandler(client, service, rootLogger.child({ module: 'slash-handler' }))

  // ── 4. HTTP control server.
  // CFG-hosted: bind 0.0.0.0 (core-server reaches the published port) +
  // per-session JWT auth. Self-host: 127.0.0.1 + static-token auth.
  const control = await startControlServer({
    service,
    port: config.controlPort,
    host: cfgHosted ? '0.0.0.0' : '127.0.0.1',
    authenticate: createControlAuthenticator({ cfg: config.cfg, controlToken: config.controlToken }),
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

// Re-export for the `serve` argv branch in index.ts.
export { resolveStandaloneConfig }
