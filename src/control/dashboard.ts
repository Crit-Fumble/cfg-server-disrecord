/**
 * Minimal self-host dashboard (#9).
 *
 * DisRecord is a back-end server, deliberately: a self-hoster brings their own
 * Discord bot and drives the container over its HTTP control API, normally by
 * building their own frontend the way cfg-core-server does. That is the right
 * architecture and this does not change it — but it puts the floor for a solo
 * self-hoster high. To record one session they must write an HTTP client and
 * know the control-API shape. One built-in page removes that floor without
 * turning DisRecord into a product.
 *
 * Deliberately ONE page, and deliberately small. Accounts, billing, campaigns
 * and transcript browsing are out of scope — those belong to core-server. If
 * this grows past a single page it has gone wrong.
 *
 * ── Self-host only ──────────────────────────────────────────────────────────
 * Not registered at all when CFG-hosted: core-server owns that surface, and
 * the container isn't reachable from a browser there anyway.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * The page itself is served unauthenticated, like `/healthz`, because it is
 * inert markup — every action it can take goes through `/v1/*`, which the
 * control server's auth hook already covers. With `CONTROL_TOKEN` set the page
 * asks for the token and sends it as a bearer; without one, the container is
 * on loopback and already open. `assertOpenSurfaceBindIsSafe` is what keeps that
 * reasoning true.
 */

import type { FastifyInstance } from 'fastify'
import type { RecordingService } from '../recording/recording-service.js'
import { DASHBOARD_HTML } from './dashboard-html.js'

/**
 * Refuse to serve the dashboard on a non-loopback bind without a
 * `CONTROL_TOKEN`.
 *
 * The self-host control server binds `127.0.0.1`, and the "no token ⇒ every
 * request allowed" rule is only defensible because of that. A dashboard
 * inherits the same bind — so if the bind ever widens, the token has to stop
 * being optional. A boot-time refusal beats a line in the docs: the failure it
 * prevents is an open, unauthenticated recording surface on a public
 * interface, which is not something anyone should learn about from a doc they
 * did not read.
 *
 * Today `standalone.ts` hardcodes the loopback bind in self-host, so this
 * cannot fire. It exists for whoever makes that configurable.
 */
export function assertOpenSurfaceBindIsSafe(
  host: string,
  controlToken: string | undefined,
  /**
   * What is about to be served, for the error message. Defaults to the
   * dashboard, which is what this originally guarded; the settings write API
   * asks the identical question, so it reuses this rather than restating the
   * reasoning.
   */
  surface = 'self-host dashboard',
): void {
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (loopback || controlToken) return
  throw new Error(
    `refusing to serve the ${surface} on ${host} without CONTROL_TOKEN — ` +
      'a non-loopback bind with no auth is an open recording surface. Set CONTROL_TOKEN, ' +
      'or set CONTROL_HOST=127.0.0.1 (a container needs the wide bind, so set the token).',
  )
}

/**
 * Register the dashboard page and the two read-only endpoints it needs.
 *
 * `/v1/guilds` and `/v1/diagnostics` sit under `/v1/` so they inherit the same
 * auth hook as every other control route — they expose guild and channel
 * names, which is not something to hand out unauthenticated just because a
 * browser asked.
 */
export function registerDashboard(app: FastifyInstance, service: RecordingService): void {
  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(DASHBOARD_HTML))

  app.get('/v1/guilds', async () => ({ guilds: service.listGuilds() }))

  app.get('/v1/diagnostics', async () => service.diagnostics())
}
