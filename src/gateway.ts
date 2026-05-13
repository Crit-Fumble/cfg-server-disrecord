/**
 * Gateway-router — always-on Discord gateway connection + HTTP API.
 *
 * Single bot identity (client_id 1504164101553656028). On a recording trigger
 * (slash command, scheduled-event auto-start, or core-server API call), this
 * process joins the voice channel, captures the handoff tokens, and spawns a
 * worker container that does the actual recording.
 *
 * v0.1 skeleton — port voice-join + worker-spawn from cfg-core-server.
 */

import { Client, GatewayIntentBits } from 'discord.js'
import Fastify from 'fastify'
import { logger as rootLogger } from './logger.js'
import type { GatewayConfig } from './config.js'

const logger = rootLogger.child({ module: 'gateway' })

export async function startGateway(config: GatewayConfig): Promise<void> {
  logger.info({ port: config.port }, 'starting cfg-resesh gateway')

  // 1. Discord gateway connection
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  })

  client.once('ready', (c) => {
    logger.info({ user: c.user.tag, id: c.user.id }, 'discord gateway ready')
  })

  client.on('error', (err) => logger.error({ err }, 'discord client error'))

  // 2. HTTP API (core-server calls in)
  const fastify = Fastify({ logger: false })

  fastify.get('/health', async () => ({
    status: 'ok',
    discordReady: client.isReady(),
    uptimeSec: process.uptime(),
  }))

  fastify.post<{ Body: StartSessionBody }>('/v1/sessions', {
    schema: {
      body: {
        type: 'object',
        required: ['guildId', 'channelId', 'userId', 'installationId', 'deepgramMode'],
        properties: {
          guildId: { type: 'string' },
          channelId: { type: 'string' },
          userId: { type: 'string' },
          installationId: { type: 'string' },
          deepgramMode: { type: 'string', enum: ['platform', 'byok', 'disabled'] },
          deepgramKey: { type: 'string', nullable: true },
        },
      },
    },
    handler: async (req, reply) => {
      // TODO(cfg-core-dev-tools#121): authenticate via shared secret,
      // join the voice channel, capture handoff tokens, spawn worker.
      logger.info({ body: req.body }, 'session start requested (stub)')
      return reply.status(501).send({ error: 'not_implemented' })
    },
  })

  fastify.delete<{ Params: { id: string } }>('/v1/sessions/:id', async (req, reply) => {
    // TODO(cfg-core-dev-tools#121): stop worker container + emit final billing tick.
    logger.info({ id: req.params.id }, 'session stop requested (stub)')
    return reply.status(501).send({ error: 'not_implemented' })
  })

  // 3. Boot order: HTTP first (core-server can ping /health while Discord
  // is still connecting), then Discord login.
  await fastify.listen({ port: config.port, host: '0.0.0.0' })
  logger.info({ port: config.port }, 'http api listening')

  await client.login(config.discordToken)

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down gateway')
    try {
      await fastify.close()
      client.destroy()
    } finally {
      process.exit(0)
    }
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

interface StartSessionBody {
  guildId: string
  channelId: string
  userId: string
  installationId: string
  deepgramMode: 'platform' | 'byok' | 'disabled'
  deepgramKey?: string
}
