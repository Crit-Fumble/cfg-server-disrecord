/**
 * Gateway-router entrypoint — wires Discord, voice, opus bus, session store,
 * worker spawner, and Fastify routes.
 *
 * Boot order:
 *   1. Listen on the HTTP port FIRST so /health responds during Discord connect
 *   2. Connect Discord client (fails fast if token invalid)
 *   3. Reconcile session state from already-running worker containers (orphans
 *      from a previous crash get registered so they can be cleanly stopped)
 *
 * Architecture details: see docs/gateway-core-infra.md and
 * docs/voice-transport-analysis.md (Option B).
 */

import { Client, GatewayIntentBits } from 'discord.js'
import Fastify from 'fastify'
import { logger as rootLogger } from './logger.js'
import type { GatewayConfig } from './config.js'
import { SessionStore } from './gateway/session-store.js'
import { OpusBus } from './gateway/opus-bus.js'
import { VoiceManager } from './gateway/voice-manager.js'
import { WorkerSpawner } from './gateway/worker-spawn.js'
import { registerRoutes } from './gateway/routes.js'

const logger = rootLogger.child({ module: 'gateway' })

export async function startGateway(config: GatewayConfig): Promise<void> {
  logger.info({ port: config.port }, 'starting cfg-server-disrecord gateway')

  // 1. Wire dependencies
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  })
  client.once('ready', (c) => {
    logger.info({ user: c.user.tag, id: c.user.id }, 'discord gateway ready')
  })
  client.on('error', (err) => logger.error({ err }, 'discord client error'))

  const store = new SessionStore()
  const bus = new OpusBus()
  const voiceManager = new VoiceManager({
    client,
    bus,
    logger: rootLogger.child({ module: 'voice-manager' }),
  })
  const spawner = new WorkerSpawner({
    dockerSocketPath: config.dockerSocketPath,
    workerImage: config.workerImageTag,
    gatewayUrl: `http://localhost:${config.port}`, // workers call back on loopback (same container network)
    coreServerUrl: config.coreServerUrl,
    logger: rootLogger.child({ module: 'worker-spawn' }),
  })

  // 2. HTTP API
  const fastify = Fastify({ logger: false })
  registerRoutes(fastify, {
    client,
    store,
    bus,
    voiceManager,
    spawner,
    authSecret: config.gatewayBearer,
    logger: rootLogger.child({ module: 'routes' }),
  })

  await fastify.listen({ port: config.port, host: '0.0.0.0' })
  logger.info({ port: config.port }, 'http api listening')

  // 3. Discord
  await client.login(config.discordToken)

  // 4. Reconcile from Docker
  try {
    const orphans = await spawner.reconcile()
    if (orphans.length > 0) {
      logger.warn(
        { count: orphans.length, ids: orphans.map((o) => o.installationId) },
        'found orphan worker containers from previous gateway run — stopping them',
      )
      for (const orphan of orphans) {
        await spawner.stop(orphan.installationId).catch((err) => {
          logger.warn({ err, installationId: orphan.installationId }, 'orphan stop failed')
        })
      }
    }
  } catch (err) {
    logger.warn({ err }, 'docker reconciliation failed (continuing)')
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down gateway')
    try {
      // Stop all active sessions cleanly so workers emit final billing ticks
      const active = store.list()
      for (const record of active) {
        voiceManager.leave(record.installationId, `gateway-${signal}`)
        await spawner.stop(record.installationId).catch(() => undefined)
      }
      await fastify.close()
      client.destroy()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}
