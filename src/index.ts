/**
 * cfg-server-disrecord entrypoint — the recording skill server.
 *
 *   node dist/index.js serve    — recording skill server: borrows a bot
 *                                 token to join voice, captures opus, mixes
 *                                 mp3, transcribes, exposes an HTTP control
 *                                 API. Runs local-only, or CFG-hosted when
 *                                 CORE_SERVER_URL is set. No command surface.
 *   node dist/index.js <other>  — delegated to the `disrecord` CLI
 *                                 (status / start / stop).
 *
 * The Docker default CMD is `serve`.
 */

import { logger } from './logger.js'

async function main(): Promise<void> {
  const mode = (process.argv[2] ?? 'serve').toLowerCase()

  if (mode === 'serve') {
    const { resolveStandaloneConfig } = await import('./config.js')
    const { startStandalone } = await import('./standalone.js')
    await startStandalone(resolveStandaloneConfig())
    return
  }

  // Everything else (status / start / stop) → CLI.
  const { runCli } = await import('./cli.js')
  await runCli(process.argv.slice(2))
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal error in cfg-server-disrecord main')
  process.exit(1)
})
