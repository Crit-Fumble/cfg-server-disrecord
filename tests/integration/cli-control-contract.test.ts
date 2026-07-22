/**
 * CLI ↔ control-server HTTP contract.
 *
 * The CLI talks to the control server with a real `fetch` over a real socket,
 * so `inject()` can't cover it — a malformed request only fails once Fastify
 * parses it off the wire. That is exactly how `stop` broke: the CLI declared
 * `content-type: application/json` on a request with no body, and Fastify
 * rejected it with 400 before the route ever ran.
 */
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { startControlServer } from '../../src/control/server.js'
import { createControlAuthenticator } from '../../src/control/auth.js'
import type { RecordingService } from '../../src/recording/recording-service.js'
import { logger } from '../../src/logger.js'
import { runCli } from '../../src/cli.js'

function fakeService(overrides: Partial<RecordingService> = {}): RecordingService {
  const base = {
    botReady: true,
    activeCount: 0,
    start: jest.fn(async () => 'rec-new'),
    pause: jest.fn(),
    resume: jest.fn(),
    stop: jest.fn(async () => undefined),
    pushConsent: jest.fn(),
    describe: jest.fn(() => ({ status: 'recording' })),
    list: jest.fn(() => []),
  }
  return { ...base, ...overrides } as unknown as RecordingService
}

describe('CLI → control server', () => {
  let app: FastifyInstance
  let service: RecordingService
  const envPort = process.env.CONTROL_PORT
  const envToken = process.env.CONTROL_TOKEN

  beforeEach(async () => {
    service = fakeService()
    app = await startControlServer({
      service,
      port: 0,
      host: '127.0.0.1',
      authenticate: createControlAuthenticator({}),
      logger,
    })
    process.env.CONTROL_PORT = String((app.server.address() as AddressInfo).port)
    delete process.env.CONTROL_TOKEN
    process.exitCode = undefined
  })

  afterEach(async () => {
    await app.close()
    if (envPort === undefined) delete process.env.CONTROL_PORT
    else process.env.CONTROL_PORT = envPort
    if (envToken === undefined) delete process.env.CONTROL_TOKEN
    else process.env.CONTROL_TOKEN = envToken
    process.exitCode = undefined
  })

  // Regression: #8 — `disrecord stop <id>` always 400'd, so the route never ran.
  it('stop reaches the route and does not fail the process', async () => {
    await runCli(['stop', 'rec-1'])

    expect(service.stop).toHaveBeenCalledWith('rec-1')
    expect(process.exitCode).toBeUndefined()
  })

  it('status reaches the route', async () => {
    await runCli(['status', 'rec-1'])

    expect(service.describe).toHaveBeenCalledWith('rec-1')
    expect(process.exitCode).toBeUndefined()
  })

  // The body-bearing path must keep working — the fix must not drop
  // content-type where it is genuinely required.
  it('start still sends a parsed JSON body', async () => {
    process.env.START_GUILD_ID = 'g1'
    process.env.START_VOICE_CHANNEL_ID = 'v1'
    try {
      await runCli(['start'])
    } finally {
      delete process.env.START_GUILD_ID
      delete process.env.START_VOICE_CHANNEL_ID
    }

    expect(service.start).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: 'g1', voiceChannelId: 'v1' }),
    )
    expect(process.exitCode).toBeUndefined()
  })
})
