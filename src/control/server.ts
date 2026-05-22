/**
 * HTTP control server for the standalone (`serve` mode) container.
 *
 * Phase 1: binds 127.0.0.1 only. Bearer auth is applied when `CONTROL_TOKEN`
 * is set; otherwise the API is open (acceptable since it's localhost-bound
 * — a self-host operator controls everything on the host anyway).
 *
 * API (introduced Phase 1):
 *   POST /v1/recordings            { guildId, voiceChannelId, textChannelId?, transcription? } → { recordingId }
 *   POST /v1/recordings/:id/pause  → 204
 *   POST /v1/recordings/:id/resume → 204
 *   POST /v1/recordings/:id/stop   → 202   (post-processing async)
 *   GET  /v1/recordings/:id        → { status, startedAt, speakerCount, paused }
 *   GET  /v1/recordings            → [ ... ]
 *   GET  /healthz                  → { ok, botReady, activeRecordings }
 *
 * Phase 2 binds 0.0.0.0 + swaps the bearer check for per-session JWT auth.
 */

import Fastify, { type FastifyInstance } from 'fastify'
import { GuildConflictError, SessionNotFoundError } from '../recording/recording-service.js'
import type { RecordingService } from '../recording/recording-service.js'
import type { Logger } from '../logger.js'

export interface ControlServerParams {
  service: RecordingService
  port: number
  /** Optional bearer token. When set, every /v1/* request must carry it. */
  token?: string
  logger: Logger
}

interface StartBody {
  guildId?: string
  voiceChannelId?: string
  textChannelId?: string
  transcription?: boolean
  invokerUserId?: string
}

/**
 * Build + start the control server. Returns the Fastify instance so the
 * caller can `close()` it on shutdown.
 */
export async function startControlServer(params: ControlServerParams): Promise<FastifyInstance> {
  const { service, port, token, logger } = params
  const app = Fastify({ logger: false })

  // Bearer auth — applied to every /v1/* route when a token is configured.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return
    if (!token) return
    const header = req.headers.authorization ?? ''
    if (header !== `Bearer ${token}`) {
      await reply.status(401).send({ error: 'unauthorized' })
    }
  })

  app.get('/healthz', async () => ({
    ok: true,
    botReady: service.botReady,
    activeRecordings: service.activeCount,
  }))

  app.post('/v1/recordings', async (req, reply) => {
    const body = (req.body ?? {}) as StartBody
    if (!body.guildId || !body.voiceChannelId) {
      return reply.status(400).send({ error: 'guildId and voiceChannelId are required' })
    }
    try {
      const recordingId = await service.start({
        guildId: body.guildId,
        voiceChannelId: body.voiceChannelId,
        textChannelId: body.textChannelId,
        transcription: body.transcription,
        invokerUserId: body.invokerUserId,
      })
      return reply.status(201).send({ recordingId })
    } catch (err) {
      if (err instanceof GuildConflictError) {
        return reply.status(409).send({ error: 'guild_conflict', conflictingRecordingId: err.conflictingRecordingId })
      }
      logger.error({ err }, 'control: start recording failed')
      return reply.status(500).send({ error: err instanceof Error ? err.message : 'start failed' })
    }
  })

  app.post('/v1/recordings/:id/pause', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      service.pause(id)
      return reply.status(204).send()
    } catch (err) {
      return notFoundOr500(reply, err, logger)
    }
  })

  app.post('/v1/recordings/:id/resume', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      service.resume(id)
      return reply.status(204).send()
    } catch (err) {
      return notFoundOr500(reply, err, logger)
    }
  })

  app.post('/v1/recordings/:id/stop', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      service.stop(id)
      return reply.status(202).send()
    } catch (err) {
      return notFoundOr500(reply, err, logger)
    }
  })

  app.get('/v1/recordings/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const session = service.describe(id)
    if (!session) return reply.status(404).send({ error: 'not_found' })
    return reply.send(session)
  })

  app.get('/v1/recordings', async () => service.list())

  // Phase 1: localhost-only. Phase 2 switches to 0.0.0.0 for core-server.
  await app.listen({ host: '127.0.0.1', port })
  logger.info({ port, authEnabled: token != null }, 'control server listening on 127.0.0.1')
  return app
}

function notFoundOr500(
  reply: import('fastify').FastifyReply,
  err: unknown,
  logger: Logger,
): import('fastify').FastifyReply {
  if (err instanceof SessionNotFoundError) {
    return reply.status(404).send({ error: 'not_found' })
  }
  logger.error({ err }, 'control: request failed')
  return reply.status(500).send({ error: err instanceof Error ? err.message : 'request failed' })
}
