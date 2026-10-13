/**
 * startGateway hands its endpoints to the client.
 *
 * `discord-endpoints.test.ts` covers the pieces. This covers the join: a
 * configured base that never reaches `new Client(...)` would leave the
 * container logging in to Discord with a token meant for another server.
 */

import { startGateway } from '../../../src/gateway/discord-gateway.js'

const constructed: Array<Record<string, unknown>> = []
const restGet = jest.fn(async (route: string) => (route === '/gateway/bot' ? { url: 'ws://public.invalid', shards: 1 } : { route }))

jest.mock('discord.js', () => ({
  GatewayIntentBits: { Guilds: 1, GuildVoiceStates: 2, GuildMembers: 4, GuildMessages: 8, MessageContent: 16 },
  Routes: { gatewayBot: () => '/gateway/bot' },
  Client: jest.fn().mockImplementation((options: Record<string, unknown>) => {
    constructed.push(options)
    return {
      rest: { get: restGet },
      on: jest.fn(),
      // Ready at once: this test is about what the client was built with.
      once: jest.fn((event: string, fn: () => void) => {
        if (event === 'clientReady') queueMicrotask(fn)
      }),
      login: jest.fn(async () => 'tok'),
      user: null,
    }
  }),
}))

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never

beforeEach(() => {
  constructed.length = 0
  restGet.mockClear()
})

describe('startGateway — endpoints', () => {
  it('builds the client with no rest option when no endpoints are given', async () => {
    await startGateway('tok', silentLogger)
    expect(constructed).toHaveLength(1)
    expect(constructed[0]).not.toHaveProperty('rest')
  })

  it('builds the client on the configured API base', async () => {
    await startGateway('tok', silentLogger, { apiBase: 'http://spacebar:3001/api' })
    expect(constructed[0]?.rest).toEqual({ api: 'http://spacebar:3001/api' })
  })

  it('leaves the gateway answer alone when no gateway URL is set', async () => {
    const client = await startGateway('tok', silentLogger, { apiBase: 'http://spacebar:3001/api' })
    expect(await client.rest.get('/gateway/bot')).toEqual({ url: 'ws://public.invalid', shards: 1 })
  })

  it('pins the gateway URL when one is set', async () => {
    const client = await startGateway('tok', silentLogger, {
      apiBase: 'http://spacebar:3001/api',
      gatewayUrl: 'ws://spacebar-gateway:3002',
    })
    expect(await client.rest.get('/gateway/bot')).toEqual({ url: 'ws://spacebar-gateway:3002', shards: 1 })
  })
})
