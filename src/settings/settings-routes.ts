/**
 * Control-API surface for the container's own settings.
 *
 * Registered under `/v1/`, so it inherits the control server's existing auth
 * hook unchanged — there is no second auth model here, and adding one would be
 * the wrong shape (see "Authorization" below).
 *
 *   GET    /v1/worlds                              every configured guild
 *   GET    /v1/worlds/:guildId                     one world
 *   PUT    /v1/worlds/:guildId/defaults            world-level defaults
 *   GET    /v1/worlds/:guildId/scenes/:channelId   { effective, override }
 *   PUT    /v1/worlds/:guildId/scenes/:channelId   one channel's override
 *   DELETE /v1/worlds/:guildId/scenes/:channelId   clear the override
 *   GET    /v1/worlds/:guildId/grants              optional access grants
 *   PUT    /v1/worlds/:guildId/grants              replace them wholesale
 *   GET    /v1/settings/export                     the whole document, as a download
 *   PUT    /v1/settings/import                     replace the whole document
 *
 * ⚠️ NOTHING READS THESE SETTINGS YET. This step gives the document a surface;
 * the recording path still takes its keywords from the CFG session policy and
 * names threads itself. Wiring `session-controller` to the store is the next
 * step — until it lands, a configured value is stored faithfully and ignored.
 *
 * ## PUT, not PATCH
 *
 * Whole-object replace of a very small object. Merge-patch semantics — where
 * `undefined` leaves a field alone and `null` clears it — is where most of the
 * complexity in core-server's equivalent route lives, and the client already
 * holds the complete object in form state. PUT costs the caller nothing and is
 * idempotent.
 *
 * ## `/v1/guilds` is a different question and stays separate
 *
 * That route (dashboard.ts) answers *what channels exist*, live from the
 * Discord gateway cache. These answer *what is configured*, from disk. Merging
 * them would couple reading your own settings to gateway liveness, so a Discord
 * hiccup would break the settings screen. Keep them apart.
 *
 * ## Authorization: deliberately none beyond the existing token
 *
 * The container has no identity concept, and this does not add one. Whoever
 * holds the control credential may read and write every world — which is
 * already the rule for `POST /v1/recordings`, a route that starts a recording
 * in any guild the bot is in. A per-user ACL on a keyword list, while
 * start-recording stayed token-only, would be incoherent security theatre.
 *
 * ## ⚠️ Single writer
 *
 * Self-host  → the CONTAINER writes (this API, and the dashboard on top of it).
 * CFG-hosted → CORE-SERVER writes, directly to the file; this API is READ-ONLY.
 *
 * `readOnly` enforces the hosted half: every write verb answers 405. Two
 * writers would need reconciling, and a whole-document replace means the loser
 * of a race loses everything, not one field. This mirrors `ConsentSync`, which
 * is likewise never constructed CFG-hosted for the same reason.
 *
 * Core writes the file rather than calling this API because the hosted
 * container only exists *during a recording*, and settings are edited between
 * them — an API-only write path would serve the minority case and be
 * unavailable for the majority.
 */

import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  parseSettingsFile,
  pickChannelSettings,
  SettingsWriteError,
  type AccessGrant,
  type SettingsStore,
} from './settings-store.js'
import type { Logger } from '../logger.js'

export interface SettingsRoutesOptions {
  /**
   * Refuse every write. TRUE when CFG-hosted, where core-server owns the file.
   * See the single-writer note above.
   */
  readOnly: boolean
  logger: Logger
}

/** Discord snowflake. Path params are untrusted input. */
function isSnowflake(value: string): boolean {
  return /^\d{1,20}$/.test(value)
}

const READ_ONLY_BODY = {
  error: 'read_only',
  message:
    'This container does not own its settings — core-server does. Edit them through the ' +
    'platform; the container reads the file it is given.',
} as const

export function registerSettingsRoutes(
  app: FastifyInstance,
  store: SettingsStore,
  opts: SettingsRoutesOptions,
): void {
  const { readOnly, logger } = opts

  /**
   * Run a store write and, if it fails, answer with a status that says what
   * happened. Returns false when it already replied.
   *
   * Scoped per-handler rather than via `app.setErrorHandler`, because this
   * registers onto the SHARED control-server instance — an error handler here
   * would silently take over the recording routes, which do their own careful
   * mapping in `notFoundOr500`.
   *
   *   locked → 409, the file on disk is unreadable and refuses to be clobbered
   *   io     → 500, the write itself failed (disk full, read-only mount)
   *
   * Answering 200 for a change that never reached disk is the worst outcome
   * available here, so neither case is swallowed.
   */
  async function persisted(reply: FastifyReply, op: () => Promise<void>): Promise<boolean> {
    try {
      await op()
      return true
    } catch (err) {
      if (!(err instanceof SettingsWriteError)) throw err
      logger.error({ err, reason: err.reason }, 'settings write rejected')
      void reply
        .status(err.reason === 'locked' ? 409 : 500)
        .send({ error: `settings_write_${err.reason}`, message: err.message })
      return false
    }
  }

  /**
   * Guard a write verb. Returns true when the request has been answered.
   *
   * 405 carries an `Allow` header — RFC 9110 requires it, and it is the only
   * thing that tells a client what it CAN do here instead of just what it
   * cannot.
   */
  function refusedForReadOnly(reply: FastifyReply): boolean {
    if (!readOnly) return false
    void reply.status(405).header('allow', 'GET').send(READ_ONLY_BODY)
    return true
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  app.get('/v1/worlds', async () => {
    const file = await store.load()
    return { worlds: file.worlds }
  })

  app.get('/v1/worlds/:guildId', async (req, reply) => {
    const { guildId } = req.params as { guildId: string }
    if (!isSnowflake(guildId)) return reply.status(400).send({ error: 'invalid_guild_id' })
    const world = await store.world(guildId)
    if (!world) return reply.status(404).send({ error: 'not_found' })
    return reply.send(world)
  })

  app.get('/v1/worlds/:guildId/scenes/:channelId', async (req, reply) => {
    const { guildId, channelId } = req.params as { guildId: string; channelId: string }
    if (!isSnowflake(guildId) || !isSnowflake(channelId)) {
      return reply.status(400).send({ error: 'invalid_id' })
    }
    const world = await store.world(guildId)
    // `effective` is what the recording will actually use; `override` is only
    // what this channel sets itself. The settings UI needs both — showing the
    // resolved value in an input would make every inherited field look
    // explicitly set, and saving the form would freeze the inheritance.
    return reply.send({
      effective: await store.effective(guildId, channelId),
      override: world?.scenes?.[channelId] ?? {},
    })
  })

  app.get('/v1/worlds/:guildId/grants', async (req, reply) => {
    const { guildId } = req.params as { guildId: string }
    if (!isSnowflake(guildId)) return reply.status(400).send({ error: 'invalid_guild_id' })
    const world = await store.world(guildId)
    return reply.send({ grants: world?.grants ?? [] })
  })

  app.get('/v1/settings/export', async (_req, reply) => {
    const file = await store.load()
    // A download, not an API payload — the operator saves this, edits it, and
    // uploads it back. Safe to hand over by construction: the document carries
    // no credentials and no platform identifiers (see settings-store.ts).
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', 'attachment; filename="disrecord-settings.json"')
      .send(JSON.stringify(file, null, 2))
  })

  // ── Writes ───────────────────────────────────────────────────────────────

  app.put('/v1/worlds/:guildId/defaults', async (req, reply) => {
    if (refusedForReadOnly(reply)) return
    const { guildId } = req.params as { guildId: string }
    if (!isSnowflake(guildId)) return reply.status(400).send({ error: 'invalid_guild_id' })
    // pickChannelSettings is the allow-list — unknown keys never reach disk.
    const settings = pickChannelSettings(req.body)
    if (!(await persisted(reply, () => store.setWorldDefaults(guildId, settings)))) return
    logger.info({ guildId, fields: Object.keys(settings) }, 'world defaults updated')
    return reply.send({ defaults: settings })
  })

  app.put('/v1/worlds/:guildId/scenes/:channelId', async (req, reply) => {
    if (refusedForReadOnly(reply)) return
    const { guildId, channelId } = req.params as { guildId: string; channelId: string }
    if (!isSnowflake(guildId) || !isSnowflake(channelId)) {
      return reply.status(400).send({ error: 'invalid_id' })
    }
    const settings = pickChannelSettings(req.body)
    if (!(await persisted(reply, () => store.setScene(guildId, channelId, settings)))) return
    logger.info({ guildId, channelId, fields: Object.keys(settings) }, 'scene settings updated')
    return reply.send({
      effective: await store.effective(guildId, channelId),
      override: settings,
    })
  })

  app.delete('/v1/worlds/:guildId/scenes/:channelId', async (req, reply) => {
    if (refusedForReadOnly(reply)) return
    const { guildId, channelId } = req.params as { guildId: string; channelId: string }
    if (!isSnowflake(guildId) || !isSnowflake(channelId)) {
      return reply.status(400).send({ error: 'invalid_id' })
    }
    if (!(await persisted(reply, () => store.clearScene(guildId, channelId)))) return
    logger.info({ guildId, channelId }, 'scene settings cleared — inherits world defaults')
    return reply.status(204).send()
  })

  app.put('/v1/worlds/:guildId/grants', async (req, reply) => {
    if (refusedForReadOnly(reply)) return
    const { guildId } = req.params as { guildId: string }
    if (!isSnowflake(guildId)) return reply.status(400).send({ error: 'invalid_guild_id' })
    const body = req.body as { grants?: unknown } | undefined
    const raw = Array.isArray(body) ? body : body?.grants
    if (!Array.isArray(raw)) return reply.status(400).send({ error: 'grants_array_required' })
    // The store normalizes — malformed entries are dropped, not stored.
    if (!(await persisted(reply, () => store.setGrants(guildId, raw as AccessGrant[])))) return
    const world = await store.world(guildId)
    logger.info({ guildId, count: world?.grants?.length ?? 0 }, 'access grants replaced')
    return reply.send({ grants: world?.grants ?? [] })
  })

  app.put('/v1/settings/import', async (req, reply) => {
    if (refusedForReadOnly(reply)) return
    if (!req.body || typeof req.body !== 'object') {
      return reply.status(400).send({ error: 'invalid_document' })
    }
    // Normalize before storing: this is an uploaded file, so it is the least
    // trusted input the container takes. Unknown keys, non-snowflake ids and
    // malformed grants are dropped rather than rejected — a partially
    // hand-edited file should still import what it got right.
    const parsed = parseSettingsFile(req.body)
    if (!(await persisted(reply, () => store.replaceAll(parsed)))) return
    const worldCount = Object.keys(parsed.worlds).length
    logger.info({ worlds: worldCount }, 'settings document imported')
    return reply.send({ worlds: worldCount })
  })
}
