/**
 * Self-host dashboard (#9).
 *
 * Three things matter more than the markup: it must not exist at all when
 * CFG-hosted, its data endpoints must sit behind the same auth as every other
 * control route, and it must refuse to boot on a bind where it would be an
 * open recording surface.
 */
import type { FastifyInstance } from 'fastify'
import { startControlServer } from '../../../src/control/server.js'
import { assertDashboardBindIsSafe } from '../../../src/control/dashboard.js'
import { createControlAuthenticator } from '../../../src/control/auth.js'
import type { RecordingService } from '../../../src/recording/recording-service.js'
import { logger } from '../../../src/logger.js'

const GUILDS = [
  {
    id: 'g-1',
    name: 'Table of Doom',
    voiceChannels: [{ id: 'v-1', name: 'Session Hall' }],
    textChannels: [{ id: 't-1', name: 'general' }],
  },
]

function fakeService(): RecordingService {
  return {
    botReady: true,
    activeCount: 0,
    start: jest.fn(async () => 'rec-new'),
    pause: jest.fn(),
    resume: jest.fn(),
    stop: jest.fn(),
    pushConsent: jest.fn(),
    describe: jest.fn(() => null),
    list: jest.fn(() => []),
    listGuilds: jest.fn(() => GUILDS),
    diagnostics: jest.fn(() => ({
      botReady: true,
      botTag: 'MyBot#0001',
      guildCount: 1,
      intents: ['Guilds', 'GuildVoiceStates'],
      activeRecordings: 0,
    })),
  } as unknown as RecordingService
}

async function makeServer(opts: { dashboard: boolean; token?: string }): Promise<FastifyInstance> {
  return startControlServer({
    service: fakeService(),
    port: 0,
    host: '127.0.0.1',
    dashboard: opts.dashboard,
    controlToken: opts.token,
    authenticate: createControlAuthenticator({ controlToken: opts.token }),
    logger,
  })
}

describe('self-host dashboard', () => {
  let app: FastifyInstance | null = null

  afterEach(async () => {
    if (app) await app.close()
    app = null
  })

  it('serves a self-contained page at / in self-host', async () => {
    app = await makeServer({ dashboard: true })
    const res = await app.inject({ method: 'GET', url: '/' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.body).toContain('<title>DisRecord</title>')
  })

  it('ships a page whose script actually parses', async () => {
    // The page's JS lives inside a TS template literal, where the compiler
    // sees nothing but an opaque string — a syntax error in there typechecks
    // clean and ships. This compiles the script without running it, so that
    // class of edit fails here rather than in someone's browser. (Verified by
    // mutation: breaking `renderRecordings()`'s signature gives 0 typecheck
    // errors and turns this spec red.)
    //
    // It is a SYNTAX check only. An accidental `${...}` that deletes a whole
    // statement still parses, and a DOM or logic error still parses — those
    // need the page actually driven in a browser.
    app = await makeServer({ dashboard: true })
    const body = (await app.inject({ method: 'GET', url: '/' })).body

    const script = /<script>([\s\S]*?)<\/script>/.exec(body)?.[1]
    expect(script).toBeTruthy()
    expect(script!.length).toBeGreaterThan(500)
    expect(() => new Function(script!)).not.toThrow()
  })

  it('has NO page and NO data endpoints when CFG-hosted', async () => {
    // core-server owns that surface, and the container is not reachable from a
    // browser there anyway — so the routes must not exist, not merely 403.
    app = await makeServer({ dashboard: false })

    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/v1/guilds' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/v1/diagnostics' })).statusCode).toBe(404)
  })

  it('keeps the data endpoints behind the control token', async () => {
    // They expose guild and channel names — not something to hand out
    // unauthenticated just because a browser asked.
    app = await makeServer({ dashboard: true, token: 'secret' })

    expect((await app.inject({ method: 'GET', url: '/v1/guilds' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/v1/diagnostics' })).statusCode).toBe(401)

    const ok = await app.inject({
      method: 'GET',
      url: '/v1/guilds',
      headers: { authorization: 'Bearer secret' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ guilds: GUILDS })
  })

  it('serves the page itself without a token — it is inert markup', async () => {
    // Every action it can take goes through /v1/*, which is still gated above.
    app = await makeServer({ dashboard: true, token: 'secret' })
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200)
  })

  it('reports diagnostics the operator needs to see', async () => {
    app = await makeServer({ dashboard: true })
    const res = await app.inject({ method: 'GET', url: '/v1/diagnostics' })

    expect(res.json()).toMatchObject({ botReady: true, botTag: 'MyBot#0001', guildCount: 1 })
  })
})

describe('assertDashboardBindIsSafe', () => {
  it('allows a loopback bind with no token — the existing self-host contract', () => {
    expect(() => assertDashboardBindIsSafe('127.0.0.1', undefined)).not.toThrow()
    expect(() => assertDashboardBindIsSafe('::1', undefined)).not.toThrow()
    expect(() => assertDashboardBindIsSafe('localhost', undefined)).not.toThrow()
  })

  it('allows a wide bind when a control token is set', () => {
    expect(() => assertDashboardBindIsSafe('0.0.0.0', 'secret')).not.toThrow()
  })

  it('refuses a wide bind with no token', () => {
    // "no CONTROL_TOKEN ⇒ every request allowed" is only defensible on
    // loopback. Widening the bind without a token would put an open recording
    // surface on a public interface — a boot-time refusal, not a doc line.
    expect(() => assertDashboardBindIsSafe('0.0.0.0', undefined)).toThrow(/CONTROL_TOKEN/)
    expect(() => assertDashboardBindIsSafe('10.0.0.5', '')).toThrow(/open recording surface/)
  })

  it('refuses at boot rather than after the port is listening', async () => {
    await expect(
      startControlServer({
        service: fakeService(),
        port: 0,
        host: '0.0.0.0',
        dashboard: true,
        controlToken: undefined,
        authenticate: createControlAuthenticator({ controlToken: undefined }),
        logger,
      }),
    ).rejects.toThrow(/CONTROL_TOKEN/)
  })
})
