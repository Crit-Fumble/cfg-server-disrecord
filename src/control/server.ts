/**
 * HTTP control server for the `serve`-mode container.
 *
 * Two binds, picked by deployment mode:
 *   Self-host  — `127.0.0.1`. Auth is the static `CONTROL_TOKEN` (or open
 *                when unset; acceptable on a localhost bind).
 *   CFG-hosted — `0.0.0.0`, so core-server can reach the published port.
 *                Auth is the per-session JWT (see `control/auth.ts`).
 *
 * API:
 *   POST /v1/recordings            { guildId, voiceChannelId, textChannelId?, transcription?, threadId? } → { recordingId }
 *   POST /v1/recordings/:id/pause  → 204
 *   POST /v1/recordings/:id/resume → 204
 *   POST /v1/recordings/:id/stop   → 200   (blocks until delivery complete)
 *   POST /v1/recordings/:id/consent { discordUserId, consented } → 204  (CFG-hosted consent push)
 *   GET  /v1/recordings/:id        → { status, startedAt, speakerCount, paused }
 *   GET  /v1/recordings            → [ ... ]
 *   GET  /v1/recordings/:id/webhooks       → categorized cfg-resesh-* + foreign webhook list
 *   POST /v1/recordings/:id/webhooks/sweep → delete stale cfg-resesh-rec-* webhooks
 *   GET  /healthz                  → { ok, botReady, activeRecordings }
 */

import Fastify, { type FastifyInstance } from 'fastify'
import { GuildConflictError, SessionNotFoundError } from '../recording/recording-service.js'
import type { RecordingService } from '../recording/recording-service.js'
import type { ControlAuthResult } from './auth.js'
import type { Logger } from '../logger.js'

export interface ControlServerParams {
  service: RecordingService
  port: number
  /**
   * Per-request authenticator built by `createControlAuthenticator`. It
   * decides whether a given Authorization header is acceptable.
   */
  authenticate: (authHeader: string | undefined) => Promise<ControlAuthResult>
  /**
   * Bind host. `127.0.0.1` for self-host, `0.0.0.0` when CFG-hosted (so
   * core-server can reach the published port).
   */
  host: string
  logger: Logger
}

interface StartBody {
  guildId?: string
  voiceChannelId?: string
  textChannelId?: string
  transcription?: boolean
  invokerUserId?: string
  /** Reuse this thread instead of creating one — see StartRecordingRequest. */
  threadId?: string
}

interface ConsentBody {
  discordUserId?: string
  consented?: boolean
}

/**
 * Build + start the control server. Returns the Fastify instance so the
 * caller can `close()` it on shutdown.
 */
export async function startControlServer(params: ControlServerParams): Promise<FastifyInstance> {
  const { service, port, authenticate, host, logger } = params
  const app = Fastify({ logger: false })

  // Auth — applied to every /v1/* route. `/healthz` stays open so core-server
  // (and Docker healthchecks) can poll readiness before they hold a token.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return
    const result = await authenticate(req.headers.authorization)
    if (!result.ok) {
      logger.warn({ url: req.url, reason: result.reason }, 'control: request rejected')
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
        threadId: body.threadId,
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
      // Block until runStop completes — mix + upload + Discord post +
      // cleanup all run synchronously from the caller's perspective. The
      // caller (core-server) is what kills the container afterward, so
      // returning early here causes the container to be killed mid-
      // delivery. Returns 200 on full completion. The caller-side fetch
      // timeout (10 min in core-server's controlStop) bounds the wait.
      await service.stop(id)
      return reply.status(200).send()
    } catch (err) {
      return notFoundOr500(reply, err, logger)
    }
  })

  // CFG-hosted consent push. core-server upserts the RecordingConsent row,
  // then POSTs here so the live consent gate honors the change immediately.
  // Idempotent on the worker side (ConsentManager apply* are idempotent).
  app.post('/v1/recordings/:id/consent', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as ConsentBody
    if (!body.discordUserId || typeof body.consented !== 'boolean') {
      return reply.status(400).send({ error: 'discordUserId and consented are required' })
    }
    try {
      service.pushConsent(id, body.discordUserId, body.consented)
      return reply.status(204).send()
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

  // ── Webhook hygiene ────────────────────────────────────────────────────
  // GET  /v1/recordings/:id/webhooks       → categorized list of all
  //        cfg-resesh-* webhooks in the session's destination channel
  //        (kind = mine | recording-stale | resesh-other-feature | foreign).
  //        Useful for ops to see what's eating the channel's 15-webhook
  //        cap before deciding to sweep.
  // POST /v1/recordings/:id/webhooks/sweep → delete stale cfg-resesh-rec-*
  //        webhooks (any recordingId != this session's). Leaves other-
  //        feature ReSesh webhooks (e.g. future CiC) and foreign
  //        integrations alone. Returns the sweep result counts.
  // Both run against the active session's destination channel; cross-
  //        channel cleanup is an out-of-band admin task.
  app.get('/v1/recordings/:id/webhooks', async (req, reply) => {
    const { id } = req.params as { id: string }
    const audit = await service.auditWebhooks(id)
    if (audit === null) {
      return reply
        .status(503)
        .send({ error: 'webhook_audit_unavailable', message: 'no active session OR bot lacks MANAGE_WEBHOOKS' })
    }
    return reply.send({ recordingId: id, webhooks: audit })
  })

  app.post('/v1/recordings/:id/webhooks/sweep', async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = await service.sweepWebhooks(id)
    if (result === null) return reply.status(404).send({ error: 'not_found' })
    if (result.unavailable) {
      return reply
        .status(503)
        .send({ error: 'webhook_sweep_unavailable', message: 'bot lacks MANAGE_WEBHOOKS or fetch failed' })
    }
    return reply.send({ recordingId: id, ...result })
  })

  await app.listen({ host, port })
  logger.info({ host, port }, 'control server listening')
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
