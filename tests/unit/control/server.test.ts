/**
 * HTTP control server — auth + routing.
 *
 * Uses Fastify's `inject()` so no real socket is opened. The server is
 * started on an ephemeral port and closed after each test.
 */
import type { FastifyInstance } from 'fastify'
import { startControlServer } from '../../../src/control/server.js'
import { createControlAuthenticator } from '../../../src/control/auth.js'
import { GuildConflictError, SessionNotFoundError } from '../../../src/recording/recording-service.js'
import type { RecordingService } from '../../../src/recording/recording-service.js'
import { logger } from '../../../src/logger.js'

/** Minimal RecordingService stand-in. */
function fakeService(overrides: Partial<RecordingService> = {}): RecordingService {
  const base = {
    botReady: true,
    activeCount: 0,
    start: jest.fn(async () => 'rec-new'),
    pause: jest.fn(),
    resume: jest.fn(),
    stop: jest.fn(),
    pushConsent: jest.fn(),
    describe: jest.fn(() => null),
    list: jest.fn(() => []),
  }
  return { ...base, ...overrides } as unknown as RecordingService
}

async function makeServer(service: RecordingService, token?: string): Promise<FastifyInstance> {
  return startControlServer({
    service,
    port: 0,
    host: '127.0.0.1',
    authenticate: createControlAuthenticator({ controlToken: token }),
    logger,
  })
}

describe('control server', () => {
  let app: FastifyInstance | null = null

  afterEach(async () => {
    if (app) await app.close()
    app = null
  })

  describe('auth (static control token)', () => {
    it('allows /healthz without a token even when auth is enabled', async () => {
      app = await makeServer(fakeService(), 'secret')
      const res = await app.inject({ method: 'GET', url: '/healthz' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ ok: true, botReady: true })
    })

    it('rejects /v1/* without the bearer token when auth is enabled', async () => {
      app = await makeServer(fakeService(), 'secret')
      const res = await app.inject({ method: 'GET', url: '/v1/recordings' })
      expect(res.statusCode).toBe(401)
    })

    it('rejects /v1/* with the wrong bearer token', async () => {
      app = await makeServer(fakeService(), 'secret')
      const res = await app.inject({
        method: 'GET',
        url: '/v1/recordings',
        headers: { authorization: 'Bearer wrong' },
      })
      expect(res.statusCode).toBe(401)
    })

    it('accepts /v1/* with the correct bearer token', async () => {
      app = await makeServer(fakeService(), 'secret')
      const res = await app.inject({
        method: 'GET',
        url: '/v1/recordings',
        headers: { authorization: 'Bearer secret' },
      })
      expect(res.statusCode).toBe(200)
    })

    it('allows /v1/* unauthenticated when no token is configured', async () => {
      app = await makeServer(fakeService())
      const res = await app.inject({ method: 'GET', url: '/v1/recordings' })
      expect(res.statusCode).toBe(200)
    })
  })

  describe('routing', () => {
    it('POST /v1/recordings returns 201 + the recording id', async () => {
      const service = fakeService()
      app = await makeServer(service)
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recordings',
        payload: { guildId: 'g1', voiceChannelId: 'vc1' },
      })
      expect(res.statusCode).toBe(201)
      expect(res.json()).toEqual({ recordingId: 'rec-new' })
      expect(service.start).toHaveBeenCalledWith(
        expect.objectContaining({ guildId: 'g1', voiceChannelId: 'vc1' }),
      )
    })

    it('POST /v1/recordings 400s without guildId / voiceChannelId', async () => {
      app = await makeServer(fakeService())
      const res = await app.inject({ method: 'POST', url: '/v1/recordings', payload: {} })
      expect(res.statusCode).toBe(400)
    })

    it('POST /v1/recordings 409s on a guild conflict', async () => {
      const service = fakeService({
        start: jest.fn(async () => {
          throw new GuildConflictError('rec-existing')
        }) as unknown as RecordingService['start'],
      })
      app = await makeServer(service)
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recordings',
        payload: { guildId: 'g1', voiceChannelId: 'vc1' },
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ conflictingRecordingId: 'rec-existing' })
    })

    it('pause / resume / stop hit the service and return 204 / 204 / 200', async () => {
      // Stop now blocks until runStop completes (mix + upload + Discord
      // post) so the container isn't killed mid-delivery; the endpoint
      // returns 200 on full completion rather than the old fire-and-
      // forget 202.
      const service = fakeService()
      app = await makeServer(service)
      expect((await app.inject({ method: 'POST', url: '/v1/recordings/r1/pause' })).statusCode).toBe(204)
      expect((await app.inject({ method: 'POST', url: '/v1/recordings/r1/resume' })).statusCode).toBe(204)
      expect((await app.inject({ method: 'POST', url: '/v1/recordings/r1/stop' })).statusCode).toBe(200)
      expect(service.pause).toHaveBeenCalledWith('r1')
      expect(service.resume).toHaveBeenCalledWith('r1')
      expect(service.stop).toHaveBeenCalledWith('r1')
    })

    it('pause 404s for an unknown recording id', async () => {
      const service = fakeService({
        pause: jest.fn(() => {
          throw new SessionNotFoundError('missing')
        }),
      })
      app = await makeServer(service)
      const res = await app.inject({ method: 'POST', url: '/v1/recordings/missing/pause' })
      expect(res.statusCode).toBe(404)
    })

    it('POST /v1/recordings/:id/consent applies the update and returns 204', async () => {
      const service = fakeService()
      app = await makeServer(service)
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recordings/r1/consent',
        payload: { discordUserId: 'u1', consented: true },
      })
      expect(res.statusCode).toBe(204)
      expect(service.pushConsent).toHaveBeenCalledWith('r1', 'u1', true)
    })

    it('POST /v1/recordings/:id/consent 400s on a malformed body', async () => {
      app = await makeServer(fakeService())
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recordings/r1/consent',
        payload: { discordUserId: 'u1' },
      })
      expect(res.statusCode).toBe(400)
    })

    it('POST /v1/recordings/:id/consent 404s for an unknown recording', async () => {
      const service = fakeService({
        pushConsent: jest.fn(() => {
          throw new SessionNotFoundError('missing')
        }),
      })
      app = await makeServer(service)
      const res = await app.inject({
        method: 'POST',
        url: '/v1/recordings/missing/consent',
        payload: { discordUserId: 'u1', consented: false },
      })
      expect(res.statusCode).toBe(404)
    })

    it('GET /v1/recordings/:id 404s when the session is unknown', async () => {
      app = await makeServer(fakeService())
      const res = await app.inject({ method: 'GET', url: '/v1/recordings/missing' })
      expect(res.statusCode).toBe(404)
    })

    it('GET /v1/recordings/:id returns the session snapshot', async () => {
      const snapshot = {
        recordingId: 'r1',
        guildId: 'g1',
        voiceChannelId: 'vc1',
        status: 'recording' as const,
        startedAt: 123,
        speakerCount: 2,
        paused: false,
      }
      const service = fakeService({ describe: jest.fn(() => snapshot) })
      app = await makeServer(service)
      const res = await app.inject({ method: 'GET', url: '/v1/recordings/r1' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual(snapshot)
    })
  })
})
