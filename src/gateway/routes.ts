/**
 * Fastify route handlers for the gateway HTTP API.
 *
 * Public:
 *   POST   /v1/sessions               — provision (auth: shared bearer)
 *   DELETE /v1/sessions/:id           — stop (auth: shared bearer)
 *   GET    /v1/sessions/:id/status    — health snapshot (auth: shared bearer)
 *   GET    /health                    — liveness probe (no auth)
 *
 * Internal (worker-only):
 *   GET    /internal/sessions/:id/audio — SSE opus stream
 *                                          (auth: per-session token)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { randomBytes } from 'node:crypto'
import type { Client } from 'discord.js'
import type { Logger } from '../logger.js'
import { SessionStore, GuildConflictError, SessionNotFoundError } from './session-store.js'
import type { OpusBus, AudioChannelEvent } from './opus-bus.js'
import type { VoiceManager } from './voice-manager.js'
import { VoiceJoinError } from './voice-manager.js'
import type { WorkerSpawner } from './worker-spawn.js'

export interface GatewayRouteDeps {
  client: Client
  store: SessionStore
  bus: OpusBus
  voiceManager: VoiceManager
  spawner: WorkerSpawner
  /** Shared secret bearer for core-server ↔ gateway. */
  authSecret: string
  logger?: Logger
}

interface ProvisionBody {
  userId: string
  installationId: string
  size: 'nano' | 'micro' | 'small'
  guildId: string
  channelId: string
  deepgramMode: 'platform' | 'byok' | 'disabled'
  deepgramKey?: string
}

interface ProvisionResponse {
  sessionId: string
  containerId: string
  hostPort: number | null
}

interface StatusResponse {
  status: 'offline' | 'starting' | 'ready' | 'unhealthy'
  containerId: string | null
  hostPort: number | null
  uptimeSec?: number
}

function requireBearer(req: FastifyRequest, expected: string): boolean {
  const header = req.headers.authorization ?? ''
  if (!header.startsWith('Bearer ')) return false
  const token = header.slice('Bearer '.length).trim()
  return token === expected
}

function generateSessionToken(): string {
  return randomBytes(32).toString('hex')
}

export function registerRoutes(app: FastifyInstance, deps: GatewayRouteDeps): void {
  const { client, store, bus, voiceManager, spawner, authSecret, logger } = deps

  app.get('/health', async () => ({
    status: 'ok',
    discordReady: client.isReady(),
    activeSessions: store.list().length,
    uptimeSec: process.uptime(),
  }))

  // ── POST /v1/sessions ──────────────────────────────────────────────────
  app.post<{ Body: ProvisionBody }>('/v1/sessions', async (req, reply) => {
    if (!requireBearer(req, authSecret)) {
      return reply.status(401).send({ error: 'unauthorized' })
    }
    const body = req.body
    if (!body?.installationId || !body?.guildId || !body?.channelId || !body?.userId) {
      return reply.status(400).send({ error: 'missing required fields' })
    }

    // Conflict check + reserve
    try {
      store.reserve(body.installationId, body.guildId)
    } catch (err) {
      if (err instanceof GuildConflictError) {
        return reply.status(409).send({
          error: 'guild_conflict',
          message: `Another Recording Server is active in this Discord server`,
          conflictingInstallationId: err.conflictingInstallationId,
        })
      }
      throw err
    }

    const sessionToken = generateSessionToken()
    try {
      await voiceManager.join(body.installationId, body.guildId, body.channelId)
      const spawn = await spawner.spawn({
        installationId: body.installationId,
        userId: body.userId,
        guildId: body.guildId,
        channelId: body.channelId,
        size: body.size ?? 'micro',
        sessionToken,
        deepgramMode: body.deepgramMode,
        deepgramKey: body.deepgramKey,
      })
      store.commit({
        installationId: body.installationId,
        guildId: body.guildId,
        channelId: body.channelId,
        userId: body.userId,
        containerId: spawn.containerId,
        containerName: spawn.containerName,
        hostPort: spawn.hostPort,
        sessionToken,
        status: 'ready',
        startedAt: Date.now(),
        endedAt: null,
      })
      const response: ProvisionResponse = {
        sessionId: body.installationId, // Phase 0: sessionId == installationId
        containerId: spawn.containerId,
        hostPort: spawn.hostPort,
      }
      return reply.status(201).send(response)
    } catch (err) {
      store.release(body.guildId, body.installationId)
      voiceManager.leave(body.installationId, 'provision-failed')
      if (err instanceof VoiceJoinError) {
        logger?.warn({ err, installationId: body.installationId }, 'voice join failed')
        return reply.status(502).send({ error: 'voice_join_failed', message: err.message })
      }
      logger?.error({ err, installationId: body.installationId }, 'session provision failed')
      return reply.status(500).send({ error: 'provision_failed', message: (err as Error).message })
    }
  })

  // ── DELETE /v1/sessions/:installationId ────────────────────────────────
  app.delete<{ Params: { id: string } }>('/v1/sessions/:id', async (req, reply) => {
    if (!requireBearer(req, authSecret)) {
      return reply.status(401).send({ error: 'unauthorized' })
    }
    const installationId = req.params.id
    if (!store.has(installationId)) {
      return reply.status(404).send({ error: 'not_found' })
    }
    try {
      store.markStopping(installationId)
      voiceManager.leave(installationId, 'requested')
      await spawner.stop(installationId)
      store.remove(installationId)
      return reply.status(204).send()
    } catch (err) {
      logger?.error({ err, installationId }, 'session stop failed')
      return reply.status(500).send({ error: 'stop_failed', message: (err as Error).message })
    }
  })

  // ── GET /v1/sessions/:installationId/status ────────────────────────────
  app.get<{ Params: { id: string } }>('/v1/sessions/:id/status', async (req, reply) => {
    if (!requireBearer(req, authSecret)) {
      return reply.status(401).send({ error: 'unauthorized' })
    }
    const record = store.get(req.params.id)
    if (!record) {
      const offline: StatusResponse = { status: 'offline', containerId: null, hostPort: null }
      return reply.status(200).send(offline)
    }
    const response: StatusResponse = {
      status:
        record.status === 'ready'
          ? 'ready'
          : record.status === 'starting'
            ? 'starting'
            : record.status === 'stopping'
              ? 'unhealthy'
              : 'unhealthy',
      containerId: record.containerId,
      hostPort: record.hostPort,
      uptimeSec: (Date.now() - record.startedAt) / 1000,
    }
    return reply.status(200).send(response)
  })

  // ── GET /internal/sessions/:installationId/audio (SSE) ─────────────────
  app.get<{ Params: { id: string } }>('/internal/sessions/:id/audio', async (req, reply) => {
    const installationId = req.params.id
    const record = store.get(installationId)
    if (!record) {
      return reply.status(404).send({ error: 'not_found' })
    }
    // Per-session bearer auth — different from the core-server shared secret
    // so a leaked auth secret doesn't grant audio access.
    if (!requireBearer(req, record.sessionToken)) {
      return reply.status(401).send({ error: 'unauthorized' })
    }
    const channel = bus.get(installationId)
    if (!channel) {
      return reply.status(503).send({ error: 'audio_channel_closed' })
    }

    streamAudio(reply, channel.subscribe.bind(channel), logger)
  })
}

/**
 * Pipe AudioChannel events to the SSE response. Closes the stream when the
 * underlying channel emits session-end OR the client disconnects.
 */
function streamAudio(
  reply: FastifyReply,
  subscribe: (handler: (event: AudioChannelEvent) => void) => () => void,
  logger?: Logger,
): void {
  reply.raw.setHeader('content-type', 'text/event-stream')
  reply.raw.setHeader('cache-control', 'no-cache')
  reply.raw.setHeader('connection', 'keep-alive')
  reply.raw.flushHeaders?.()

  // Periodic comment line to keep proxies from idle-closing the SSE.
  const keepalive = setInterval(() => {
    try {
      reply.raw.write(': keepalive\n\n')
    } catch {
      /* socket already closed; cleanup happens via close listener */
    }
  }, 15_000)
  keepalive.unref?.()

  const unsubscribe = subscribe((event) => {
    try {
      if (event.kind === 'speaker-data') {
        const payload = JSON.stringify({
          speakerId: event.speakerId,
          opus: event.opus.toString('base64'),
        })
        reply.raw.write(`event: speaker-data\ndata: ${payload}\n\n`)
      } else if (event.kind === 'speaker-start') {
        reply.raw.write(`event: speaker-start\ndata: {"speakerId":"${event.speakerId}"}\n\n`)
      } else if (event.kind === 'speaker-end') {
        reply.raw.write(`event: speaker-end\ndata: {"speakerId":"${event.speakerId}"}\n\n`)
      } else if (event.kind === 'session-end') {
        reply.raw.write(
          `event: session-end\ndata: ${JSON.stringify({ reason: event.reason })}\n\n`,
        )
        reply.raw.end()
      }
    } catch (err) {
      logger?.debug({ err }, 'audio SSE write failed (consumer disconnected?)')
    }
  })

  const cleanup = () => {
    clearInterval(keepalive)
    unsubscribe()
  }
  reply.raw.once('close', cleanup)
  reply.raw.once('error', cleanup)
}

export const __testing__ = { generateSessionToken, requireBearer }
