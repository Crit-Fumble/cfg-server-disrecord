/**
 * ⚠️ THE LEAK CANARY.
 *
 * Boots a control server whose every credential is a unique sentinel string,
 * then walks EVERY REGISTERED ROUTE and asserts no response body or header
 * contains any of them.
 *
 * ## Why enumerate instead of listing routes here
 *
 * A hard-coded list is a snapshot: it passes forever while the surface grows
 * past it, which is exactly the failure it is supposed to catch. Enumeration
 * means the day someone adds `GET /v1/config`, or a debug route that dumps the
 * spawn env, this test covers it without anyone remembering to update it. The
 * `onRoute` hook in `ControlServerParams` exists for this and nothing else.
 *
 * ## Why it matters more here than in most services
 *
 * The CFG-hosted bot token is SHARED — `container-spawn.ts` falls back to the
 * single platform token for every user's container. One leak is a
 * platform-wide compromise, not one user's. The platform Deepgram key never
 * enters the container at all (short-lived grant tokens instead), and the
 * per-session `coreServerToken` can stop recordings, so none of them may ever
 * appear in a response.
 */

import type { FastifyInstance } from 'fastify'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startControlServer } from '../../../src/control/server.js'
import { createControlAuthenticator } from '../../../src/control/auth.js'
import { testSettingsStore } from '../../_lib/settings.js'
import type { CfgHostedConfig } from '../../../src/config.js'

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

/**
 * The CFG-hosted bearer must be a DECODABLE JWT carrying the right scope and
 * installationId — `createControlAuthenticator` bytecompares it AND runs
 * `decodeJwt` on it (auth.ts). A plain string fails that, which is what made
 * the first version of this test authenticate on 2 routes out of 35 and scan
 * nothing but 401 bodies. The signature is never verified (the container holds
 * no AUTH_SECRET), so a hand-built token is enough.
 */
const HOSTED_JWT = [
  b64url({ alg: 'HS256', typ: 'JWT' }),
  b64url({ scope: 'disrecord-worker', installationId: 'inst-1', sentinel: 'SENTINEL-CORE-SERVER-TOKEN-dddd' }),
  'c2lnbmF0dXJlLW5ldmVyLXZlcmlmaWVk',
].join('.')

/**
 * Unique, unmistakable, and not substrings of each other — a sentinel that
 * shares a prefix with another would make a partial leak look like a pass.
 *
 * ⚠️ `botToken` and `deepgramKey` are NOT currently reachable from the control
 * server: it never receives them, so no route could echo them today. They stay
 * because the guard's job is the future — the day either is plumbed in to
 * support some new endpoint, this test is already watching for it.
 */
const SENTINELS = {
  botToken: 'SENTINEL-DISCORD-BOT-TOKEN-aaaa',
  deepgramKey: 'SENTINEL-DEEPGRAM-KEY-bbbb',
  controlToken: 'SENTINEL-CONTROL-TOKEN-cccc',
  coreServerToken: HOSTED_JWT,
} as const

const ALL_SENTINELS = Object.values(SENTINELS)

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
} as never

/** A RecordingService stand-in that reports the sentinel-bearing config back. */
function fakeService() {
  return {
    botReady: true,
    activeCount: 0,
    // `diagnostics()` is the most likely accidental leak site — it exists to
    // dump state, and already returns bot identity.
    diagnostics: () => ({
      botReady: true,
      botTag: 'DisRecord#0001',
      guildCount: 1,
      intents: ['Guilds', 'GuildVoiceStates'],
      activeRecordings: 0,
    }),
    listGuilds: () => [{ id: '1', name: 'Guild', voiceChannels: [], textChannels: [] }],
    list: () => [],
    describe: () => null,
    auditWebhooks: async () => null,
    sweepWebhooks: async () => null,
    start: async () => 'rec-1',
    pause: () => undefined,
    resume: () => undefined,
    stop: async () => undefined,
    pushConsent: () => undefined,
    stopAll: async () => undefined,
  } as never
}

interface SeenRoute {
  method: string
  url: string
}

/** Substitute a plausible value for every `:param` so the route resolves. */
function concreteUrl(url: string): string {
  return url
    .replace(/:guildId/g, '100000000000000001')
    .replace(/:channelId/g, '200000000000000002')
    .replace(/:id/g, 'rec-1')
    .replace(/\*/g, 'x')
}

async function bootAndCollect(
  cfg: CfgHostedConfig | undefined,
): Promise<{ app: FastifyInstance; routes: SeenRoute[] }> {
  const routes: SeenRoute[] = []
  const app = await startControlServer({
    service: fakeService(),
    port: 0,
    host: '127.0.0.1',
    controlToken: SENTINELS.controlToken,
    authenticate: createControlAuthenticator({ cfg, controlToken: SENTINELS.controlToken }),
    // Dashboard ON so its routes are in scope too — it is the surface most
    // likely to grow a "show me the config" endpoint.
    dashboard: true,
    settingsStore: testSettingsStore(join(dir, 'worlds.json')),
    settingsReadOnly: !!cfg,
    onRoute: (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method]
      for (const method of methods) routes.push({ method, url: route.url })
    },
    logger: silentLogger,
  })
  return { app, routes }
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'disrecord-leak-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('⚠️ no route leaks a credential', () => {
  it.each([
    ['self-host', undefined],
    [
      'CFG-hosted',
      {
        coreServerUrl: 'http://core.invalid',
        coreServerToken: SENTINELS.coreServerToken,
        installationId: 'inst-1',
        userId: 'user-1',
        size: 'small',
      } as CfgHostedConfig,
    ],
  ])('%s: every registered route is clean', async (_label, cfg) => {
    const { app, routes } = await bootAndCollect(cfg)
    try {
      // If enumeration ever silently returns nothing, the test would pass
      // while checking zero routes — the exact vacuous-green failure this
      // whole file exists to avoid.
      expect(routes.length).toBeGreaterThan(8)

      // ⚠️ The bearer must match the mode, or every /v1/ route answers 401 and
      // the scan inspects nothing but error bodies. The first version of this
      // test sent the control token in BOTH modes; CFG-hosted compares against
      // `coreServerToken`, so its whole run was vacuous.
      const bearer = cfg ? SENTINELS.coreServerToken : SENTINELS.controlToken
      let authorized = 0

      for (const route of routes) {
        if (route.method === 'HEAD' || route.method === 'OPTIONS') continue
        const res = await app.inject({
          method: route.method as 'GET',
          url: concreteUrl(route.url),
          headers: { authorization: `Bearer ${bearer}` },
          payload: route.method === 'GET' || route.method === 'DELETE' ? undefined : {},
        })
        if (res.statusCode !== 401 && res.statusCode !== 404) authorized++

        const haystack = `${res.body}\n${JSON.stringify(res.headers)}`
        for (const sentinel of ALL_SENTINELS) {
          if (haystack.includes(sentinel)) {
            throw new Error(
              `${route.method} ${route.url} leaked a credential (${sentinel}). ` +
                'No control route may echo the bot token, the Deepgram key, the control ' +
                'token or the core-server token — the hosted bot token is shared across ' +
                'every user, so this is a platform-wide compromise, not a local one.',
            )
          }
        }
      }

      // The scan is only meaningful against routes that actually RAN. Without
      // this, a wrong bearer or a broken URL substitution turns the whole suite
      // into "401 bodies contain no secrets", which is true and worthless.
      expect(authorized).toBeGreaterThan(routes.length / 2)
    } finally {
      await app.close()
    }
  })

  it('covers the settings and dashboard routes, not just the recording ones', async () => {
    const { app, routes } = await bootAndCollect(undefined)
    try {
      const urls = routes.map((r) => r.url)
      // Guards the guard: if registration moves and enumeration quietly stops
      // seeing a whole family of routes, the scan above would still be green.
      expect(urls).toEqual(expect.arrayContaining(['/v1/worlds', '/v1/settings/export', '/v1/diagnostics']))
    } finally {
      await app.close()
    }
  })
})
