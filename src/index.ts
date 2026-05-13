/**
 * cfg-resesh entrypoint.
 *
 * Mode selected by the first CLI arg:
 *   node dist/index.js gateway    → always-on gateway-router
 *   node dist/index.js worker     → per-session recording worker
 *
 * See docs/ARCHITECTURE.md for the rationale.
 */

import { logger } from './logger.js'
import { resolveConfig, type Mode } from './config.js'

async function main(): Promise<void> {
  const mode = (process.argv[2] ?? '').toLowerCase()
  if (mode !== 'gateway' && mode !== 'worker') {
    logger.fatal({ provided: mode }, 'Usage: node dist/index.js <gateway|worker>')
    process.exit(2)
  }
  process.env.RESESH_MODE_HINT = mode
  const config = resolveConfig(mode as Mode)

  if (config.mode === 'gateway') {
    const { startGateway } = await import('./gateway.js')
    await startGateway(config)
  } else {
    const { startWorker } = await import('./worker.js')
    await startWorker(config)
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal error in cfg-resesh main')
  process.exit(1)
})
