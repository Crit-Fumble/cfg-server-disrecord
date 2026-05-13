/**
 * cfg-server-disrecord worker entrypoint.
 *
 *   node dist/index.js worker
 *
 * The container runs in 'worker' mode; the legacy 'gateway' mode was retired
 * when the gateway machinery moved into cfg-core-server (see core-server's
 * services/disrecord/). Argv still parses 'worker' for compose / dockerode
 * compatibility — could be dropped once that compatibility stops mattering.
 */

import { logger } from './logger.js'
import { resolveConfig } from './config.js'

async function main(): Promise<void> {
  const mode = (process.argv[2] ?? 'worker').toLowerCase()
  if (mode !== 'worker') {
    logger.fatal(
      { provided: mode },
      "Only 'worker' mode is supported. Gateway is now part of cfg-core-server.",
    )
    process.exit(2)
  }
  const config = resolveConfig()
  const { startWorker } = await import('./worker.js')
  await startWorker(config)
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal error in cfg-server-disrecord main')
  process.exit(1)
})
