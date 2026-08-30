/**
 * Control API — the lifecycle additions (cfg-server-disrecord#74).
 *
 *   POST /v1/recordings/:id/prompt-end → 204 (posts the end prompt), 404 unknown
 *   POST /v1/recordings forwards scheduledEndAt + discordEventId to the service
 */
import type { FastifyInstance } from 'fastify'
import { startControlServer } from '../../../src/control/server.js'
import { createControlAuthenticator } from '../../../src/control/auth.js'
import { SessionNotFoundError } from '../../../src/recording/recording-service.js'
import type { RecordingService } from '../../../src/recording/recording-service.js'
import { logger } from '../../../src/logger.js'
import { testSettingsStore } from '../../_lib/settings.js'

function fakeService(overrides: Partial<RecordingService> = {}): RecordingService {
  const base = {
    botReady: true,
    activeCount: 0,
    start: jest.fn(async () => 'rec-new'),
    pause: jest.fn(),
    resume: jest.fn(),
    stop: jest.fn(),
    promptEnd: jest.fn(async () => undefined),
    pushConsent: jest.fn(),
    describe: jest.fn(() => null),
    list: jest.fn(() => []),
  }
  return { ...base, ...overrides } as unknown as RecordingService
}

async function makeServer(service: RecordingService): Promise<FastifyInstance> {
  return startControlServer({
    service,
    port: 0,
    host: '127.0.0.1',
    authenticate: createControlAuthenticator({ controlToken: undefined }),
    settingsStore: testSettingsStore(),
    settingsReadOnly: true,
    logger,
  })
}

describe('control server — recording lifecycle', () => {
  let app: FastifyInstance | null = null
  afterEach(async () => {
    if (app) await app.close()
    app = null
  })

  it('POST /v1/recordings/:id/prompt-end → 204 and asks the service for an event-ended prompt', async () => {
    const service = fakeService()
    app = await makeServer(service)
    const res = await app.inject({ method: 'POST', url: '/v1/recordings/rec-1/prompt-end' })
    expect(res.statusCode).toBe(204)
    expect(service.promptEnd).toHaveBeenCalledWith('rec-1', 'event-ended')
  })

  it('POST /v1/recordings/:id/prompt-end → 404 for an unknown recording', async () => {
    const service = fakeService({
      promptEnd: jest.fn(async () => {
        throw new SessionNotFoundError('rec-x')
      }) as never,
    })
    app = await makeServer(service)
    const res = await app.inject({ method: 'POST', url: '/v1/recordings/rec-x/prompt-end' })
    expect(res.statusCode).toBe(404)
  })

  it('POST /v1/recordings forwards scheduledEndAt + discordEventId, and drops non-string values', async () => {
    const service = fakeService()
    app = await makeServer(service)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/recordings',
      payload: { guildId: 'g1', voiceChannelId: 'vc1', scheduledEndAt: '2026-09-02T03:30:00Z', discordEventId: 'evt-1' },
    })
    expect(res.statusCode).toBe(201)
    expect(service.start).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledEndAt: '2026-09-02T03:30:00Z', discordEventId: 'evt-1' }),
    )

    await app.inject({
      method: 'POST',
      url: '/v1/recordings',
      payload: { guildId: 'g1', voiceChannelId: 'vc1', scheduledEndAt: 12345, discordEventId: { nope: true } },
    })
    const second = (service.start as jest.Mock).mock.calls[1]![0] as Record<string, unknown>
    expect(second.scheduledEndAt).toBeUndefined()
    expect(second.discordEventId).toBeUndefined()
  })
})
