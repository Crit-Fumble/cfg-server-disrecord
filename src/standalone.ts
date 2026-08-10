/**
 * `serve`-mode entrypoint — the recording skill server.
 *
 * Opens a Discord voice connection using a bot token supplied by the
 * operator (self-host) or the consuming bot (CFG-hosted: the ReSesh bot),
 * captures opus, mixes mp3, transcribes, and posts a Discord thread. The
 * container is driven entirely by its HTTP control API — it has no slash
 * command surface (a consuming bot like ReSesh owns the command UX and
 * drives this container over the API).
 *
 * One image, two modes — picked by whether `config.cfg` is set:
 *   Self-host  — no `CORE_SERVER_URL`. LocalDirSink, 127.0.0.1 control bind,
 *                static `CONTROL_TOKEN` auth, no phone-home.
 *   CFG-hosted — `CORE_SERVER_URL` present. ObjectStorageSink (when
 *                `DO_SPACES_*` set), 0.0.0.0 control bind, per-session-JWT
 *                auth, billing / consent / transcript phone-home.
 *
 * Boots, in order:
 *   1. Discord gateway  — logs in with the borrowed bot token, waits for
 *                         ready (required for joinVoiceChannel)
 *   2. RecordingService — registry + sink + config
 *   3. control server   — HTTP API (the only drive surface)
 * then waits for SIGTERM/SIGINT, stops every active recording, and exits.
 */

import { logger as rootLogger } from './logger.js'
import { keepPcmWasIgnored, resolveStandaloneConfig, type StandaloneConfig } from './config.js'
import { startGateway, stopGateway } from './gateway/discord-gateway.js'
import { RecordingService } from './recording/recording-service.js'
import { LocalDirSink, ObjectStorageSink, type OutputSink } from './recording/output-sink.js'
import { startControlServer } from './control/server.js'
import { createControlAuthenticator } from './control/auth.js'
import { fetchInteractionDelivery, warnIfButtonsCannotFire } from './gateway/interaction-delivery.js'
import { FileSettingsStore } from './settings/settings-store.js'

const logger = rootLogger.child({ module: 'standalone' })

export async function startStandalone(config: StandaloneConfig): Promise<void> {
  const cfgHosted = config.cfg != null
  let interactionDelivery = null
  logger.info(
    {
      outputDir: config.outputDir,
      controlPort: config.controlPort,
      deepgramMode: config.deepgramMode,
      mode: cfgHosted ? 'cfg-hosted' : 'self-host',
      objectStorageUpload: config.cfg?.objectStorage != null,
    },
    'starting cfg-server-disrecord in serve mode',
  )

  // The one env var this container deliberately refuses to honour. Say so
  // rather than leaving an operator to wonder why no tuning corpus appears.
  if (keepPcmWasIgnored(config)) {
    logger.warn(
      'DISRECORD_KEEP_PCM is set but IGNORED — per-speaker audio retention is self-host only (#12). ' +
        'A CFG-hosted container never retains separated speaker audio.',
    )
  }

  // ── 1. Discord gateway — log in at boot, stay connected. The login is
  // required for voice: joinVoiceChannel needs `guild.voiceAdapterCreator`,
  // which only exists on a connected client.
  const client = await startGateway(config.discordToken, rootLogger.child({ module: 'gateway' }))

  // ── 2. RecordingService — sink picked by mode.
  // CFG-hosted with object-storage creds ⇒ upload; otherwise local dir.
  const sink: OutputSink = config.cfg?.objectStorage
    ? new ObjectStorageSink(config.cfg.objectStorage, rootLogger.child({ module: 'object-storage-sink' }))
    : new LocalDirSink(config.outputDir, rootLogger.child({ module: 'output-sink' }))
  // ONE settings store for the container's lifetime, shared by the recording
  // path (which only READS it) and the control API (which writes it, self-host
  // only). Two instances would mean two write queues over one file — the
  // lost-update shape the single-writer rule exists to avoid.
  const settingsStore = new FileSettingsStore({
    path: config.settingsPath,
    logger: rootLogger.child({ module: 'settings' }),
  })

  // Which way Discord delivers this application's interactions is a per-APP
  // axis the container cannot infer from its own config. Self-host only: in
  // CFG-hosted the endpoint URL is correct and belongs to core-server.
  if (!cfgHosted) {
    const delivery = await fetchInteractionDelivery(config.discordToken, logger)
    warnIfButtonsCannotFire(delivery, logger)
    interactionDelivery = delivery
  }

  const service = new RecordingService(client, sink, config, rootLogger, settingsStore)
  service.setInteractionDelivery(interactionDelivery)

  // ── 3. HTTP control server — the container's only drive surface.
  // CFG-hosted: bind 0.0.0.0 (core-server reaches the published port) +
  // per-session JWT auth. Self-host: 127.0.0.1 + static-token auth.
  const control = await startControlServer({
    service,
    port: config.controlPort,
    // CFG-hosted always binds wide so core-server can reach the published port.
    // Self-host takes CONTROL_HOST, which the image sets to 0.0.0.0 because a
    // loopback bind inside a container is unreachable through `docker run -p`.
    host: cfgHosted ? '0.0.0.0' : config.controlHost,
    authenticate: createControlAuthenticator({ cfg: config.cfg, controlToken: config.controlToken }),
    // Self-host gets the built-in dashboard (#9) so a solo operator can drive
    // the container without first building a frontend. CFG-hosted never does —
    // core-server owns that surface.
    dashboard: !cfgHosted,
    controlToken: config.controlToken,
    settingsStore,
    // CFG-hosted: core-server owns the file and writes it directly, so the
    // container must not be a second writer. Self-host: nothing else exists,
    // so the container owns it. Same split as ConsentSync.
    settingsReadOnly: cfgHosted,
    logger: rootLogger.child({ module: 'control' }),
  })

  logger.info('serve mode ready — awaiting control API calls')

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
