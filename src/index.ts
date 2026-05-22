/**
 * cfg-server-disrecord entrypoint.
 *
 *   node dist/index.js worker   — legacy per-session SSE worker (core-server
 *                                 spawns this; pulls opus over SSE, runs
 *                                 Deepgram, POSTs transcripts/billing back).
 *   node dist/index.js serve    — standalone unified recording container:
 *                                 own bot, own voice capture + mp3 mix +
 *                                 transcription, HTTP control API. No
 *                                 core-server involvement.
 *   node dist/index.js <other>  — delegated to the `disrecord` CLI
 *                                 (register-commands / status / start / stop).
 *
 * Both `worker` and `serve` modes ship in the same image; the Docker
 * default CMD is `worker` so core-server's existing spawn keeps working.
 */

import { logger } from './logger.js'

async function main(): Promise<void> {
  const mode = (process.argv[2] ?? 'worker').toLowerCase()

  if (mode === 'worker') {
    const { resolveConfig } = await import('./config.js')
    const { startWorker } = await import('./worker.js')
    await startWorker(resolveConfig())
    return
  }

  if (mode === 'serve') {
    const { resolveStandaloneConfig } = await import('./config.js')
    const { startStandalone } = await import('./standalone.js')
    await startStandalone(resolveStandaloneConfig())
    return
  }

  // Everything else (register-commands / status / start / stop) → CLI.
  const { runCli } = await import('./cli.js')
  await runCli(process.argv.slice(2))
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal error in cfg-server-disrecord main')
  process.exit(1)
})
