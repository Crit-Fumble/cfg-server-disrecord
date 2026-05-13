/**
 * Unit tests for gateway HTTP routes — wires the real route module against
 * mocked VoiceManager + WorkerSpawner so we exercise the handlers end-to-end
 * via Fastify's inject() without needing a real Discord connection.
 */

import Fastify, { type FastifyInstance } from 'fastify'
import { registerRoutes } from '../../../src/gateway/routes.js'
import { SessionStore } from '../../../src/gateway/session-store.js'
import { OpusBus } from '../../../src/gateway/opus-bus.js'

const AUTH = 'top-secret'

function fakeClient() {
  return { isReady: () => true } as any
}

function fakeVoiceManager() {
  return {
    join: jest.fn(async () => undefined),
    leave: jest.fn(() => undefined),
    has: jest.fn(() => false),
  } as any
}

function fakeSpawner() {
  return {
    spawn: jest.fn(async () => ({
      containerId: 'docker-abc',
      containerName: 'cfg-server-disrecord-worker-inst-1',
      hostPort: null,
    })),
    stop: jest.fn(async () => undefined),
    reconcile: jest.fn(async () => []),
  } as any
}

function buildApp(deps?: Partial<Parameters<typeof registerRoutes>[1]>): {
  app: FastifyInstance
  store: SessionStore
  bus: OpusBus
  voiceManager: ReturnType<typeof fakeVoiceManager>
  spawner: ReturnType<typeof fakeSpawner>
} {
  const app = Fastify({ logger: false })
  const store = new SessionStore()
  const bus = new OpusBus()
  const voiceManager = fakeVoiceManager()
  const spawner = fakeSpawner()
  registerRoutes(app, {
    client: fakeClient(),
    store,
    bus,
    voiceManager,
    spawner,
    authSecret: AUTH,
    ...deps,
  })
  return { app, store, bus, voiceManager, spawner }
}

describe('GET /health', () => {
  it('returns ok + discord ready + active sessions count', async () => {
    const { app } = buildApp()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ok')
    expect(body.discordReady).toBe(true)
    expect(body.activeSessions).toBe(0)
  })
})

describe('POST /v1/sessions — auth', () => {
  it('rejects missing bearer with 401', async () => {
    const { app } = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { installationId: 'i', guildId: 'g', channelId: 'c', userId: 'u', deepgramMode: 'disabled' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects wrong bearer with 401', async () => {
    const { app } = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: 'Bearer nope' },
      payload: { installationId: 'i', guildId: 'g', channelId: 'c', userId: 'u', deepgramMode: 'disabled' },
    })
    expect(res.statusCode).toBe(401)
  })
})

describe('POST /v1/sessions — happy path', () => {
  it('joins voice, spawns worker, commits state, returns 201', async () => {
    const { app, store, voiceManager, spawner } = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${AUTH}` },
      payload: {
        installationId: 'inst-1',
        guildId: 'g-1',
        channelId: 'c-1',
        userId: 'u-1',
        size: 'micro',
        deepgramMode: 'platform',
        workerToken: 'jwt.placeholder.token',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.sessionId).toBe('inst-1')
    expect(body.containerId).toBe('docker-abc')
    expect(voiceManager.join).toHaveBeenCalledWith('inst-1', 'g-1', 'c-1')
    expect(spawner.spawn).toHaveBeenCalledTimes(1)
    expect(spawner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ workerToken: 'jwt.placeholder.token' }),
    )
    expect(store.has('inst-1')).toBe(true)
    const stored = store.get('inst-1')!
    expect(stored.sessionToken).toMatch(/^[0-9a-f]{64}$/) // 32-byte hex
  })

  it('rejects 400 when workerToken is missing', async () => {
    const { app } = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${AUTH}` },
      payload: {
        installationId: 'inst-1',
        guildId: 'g-1',
        channelId: 'c-1',
        userId: 'u-1',
        size: 'micro',
        deepgramMode: 'platform',
        // workerToken intentionally omitted
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/workerToken/)
  })
})

describe('POST /v1/sessions — guild conflict', () => {
  it('returns 409 when guild already has an active session', async () => {
    const { app, store } = buildApp()
    store.commit({
      installationId: 'inst-existing',
      guildId: 'g-1',
      channelId: 'c-1',
      userId: 'u-1',
      containerId: 'docker-existing',
      containerName: 'cfg-server-disrecord-worker-inst-existing',
      hostPort: null,
      sessionToken: 'old',
      status: 'ready',
      startedAt: Date.now(),
      endedAt: null,
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${AUTH}` },
      payload: {
        installationId: 'inst-new',
        guildId: 'g-1',
        channelId: 'c-1',
        userId: 'u-1',
        deepgramMode: 'platform',
        workerToken: 'jwt.placeholder.token',
      },
    })
    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.error).toBe('guild_conflict')
    expect(body.conflictingInstallationId).toBe('inst-existing')
  })
})

describe('POST /v1/sessions — voice join failure releases reservation', () => {
  it('releases guild reservation on voice join failure', async () => {
    const voiceManager = fakeVoiceManager()
    const { VoiceJoinError } = await import('../../../src/gateway/voice-manager.js')
    voiceManager.join.mockRejectedValueOnce(new VoiceJoinError('bot not invited'))
    const { app, store } = buildApp({ voiceManager })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${AUTH}` },
      payload: {
        installationId: 'inst-1',
        guildId: 'g-1',
        channelId: 'c-1',
        userId: 'u-1',
        deepgramMode: 'disabled',
        workerToken: 'jwt.placeholder.token',
      },
    })
    expect(res.statusCode).toBe(502)
    expect(res.json().error).toBe('voice_join_failed')
    // Guild slot released — a subsequent reserve should succeed
    expect(() => store.reserve('inst-2', 'g-1')).not.toThrow()
  })
})

describe('DELETE /v1/sessions/:id', () => {
  it('returns 401 without bearer', async () => {
    const { app } = buildApp()
    const res = await app.inject({ method: 'DELETE', url: '/v1/sessions/inst-1' })
    expect(res.statusCode).toBe(401)
  })

  it('returns 404 for an unknown installation', async () => {
    const { app } = buildApp()
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/sessions/nope',
      headers: { authorization: `Bearer ${AUTH}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('leaves voice + stops worker + removes from store, returns 204', async () => {
    const { app, store, voiceManager, spawner } = buildApp()
    store.commit({
      installationId: 'inst-1',
      guildId: 'g-1',
      channelId: 'c-1',
      userId: 'u-1',
      containerId: 'docker-abc',
      containerName: 'cfg-server-disrecord-worker-inst-1',
      hostPort: null,
      sessionToken: 'tok',
      status: 'ready',
      startedAt: Date.now(),
      endedAt: null,
    })
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/sessions/inst-1',
      headers: { authorization: `Bearer ${AUTH}` },
    })
    expect(res.statusCode).toBe(204)
    expect(voiceManager.leave).toHaveBeenCalledWith('inst-1', 'requested')
    expect(spawner.stop).toHaveBeenCalledWith('inst-1')
    expect(store.has('inst-1')).toBe(false)
  })
})

describe('GET /v1/sessions/:id/status', () => {
  it('returns offline status (200) for an unknown installation', async () => {
    const { app } = buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/v1/sessions/nope/status',
      headers: { authorization: `Bearer ${AUTH}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'offline', containerId: null })
  })

  it('returns ready + container + uptime for an active session', async () => {
    const { app, store } = buildApp()
    store.commit({
      installationId: 'inst-1',
      guildId: 'g-1',
      channelId: 'c-1',
      userId: 'u-1',
      containerId: 'docker-abc',
      containerName: 'cfg-server-disrecord-worker-inst-1',
      hostPort: 4401,
      sessionToken: 'tok',
      status: 'ready',
      startedAt: Date.now() - 5000,
      endedAt: null,
    })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/sessions/inst-1/status',
      headers: { authorization: `Bearer ${AUTH}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ready')
    expect(body.containerId).toBe('docker-abc')
    expect(body.hostPort).toBe(4401)
    expect(body.uptimeSec).toBeGreaterThan(4)
  })
})
