/**
 * Where "Discord" is: the REST base, the gateway address and posted links.
 *
 * Each defaults to Discord itself. The failure these guard is a quiet one: a
 * container pointed at another server that still sends its bot token, or one
 * call, to discord.com because a URL stayed hard-coded.
 */

import { Routes } from 'discord.js'
import { resolveStandaloneConfig } from '../../../src/config.js'
import { DEFAULT_DISCORD_API_BASE, DEFAULT_DISCORD_WEB_BASE, messageLink } from '../../../src/discord/endpoints.js'
import { pinGatewayUrl } from '../../../src/gateway/discord-gateway.js'
import { fetchInteractionDelivery } from '../../../src/gateway/interaction-delivery.js'

const ORIG = process.env
const realFetch = global.fetch

afterEach(() => {
  process.env = ORIG
  global.fetch = realFetch
})

function setEnv(vars: Record<string, string>): void {
  process.env = { ...ORIG, DISRECORD_DISCORD_TOKEN: 'bot-token', ...vars } as NodeJS.ProcessEnv
}

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never

describe('resolveStandaloneConfig — discord endpoints', () => {
  it('points at Discord itself when nothing is set', () => {
    setEnv({})
    expect(resolveStandaloneConfig().discord).toEqual({
      apiBase: DEFAULT_DISCORD_API_BASE,
      gatewayUrl: undefined,
      webBase: DEFAULT_DISCORD_WEB_BASE,
    })
  })

  it('takes all three from the environment, without a trailing slash', () => {
    setEnv({
      DISRECORD_DISCORD_API_BASE: 'http://spacebar:3001/api/',
      DISRECORD_DISCORD_GATEWAY_URL: 'ws://spacebar-gateway:3002/',
      DISRECORD_DISCORD_WEB_BASE: 'https://chat.example.invalid/app',
    })
    expect(resolveStandaloneConfig().discord).toEqual({
      apiBase: 'http://spacebar:3001/api',
      gatewayUrl: 'ws://spacebar-gateway:3002',
      webBase: 'https://chat.example.invalid/app',
    })
  })

  it('treats an empty value as unset', () => {
    setEnv({ DISRECORD_DISCORD_API_BASE: '', DISRECORD_DISCORD_GATEWAY_URL: '' })
    const { discord } = resolveStandaloneConfig()
    expect(discord.apiBase).toBe(DEFAULT_DISCORD_API_BASE)
    expect(discord.gatewayUrl).toBeUndefined()
  })

  it.each([
    ['DISRECORD_DISCORD_API_BASE', 'spacebar:3001/api'],
    ['DISRECORD_DISCORD_API_BASE', 'ws://spacebar:3001/api'],
    ['DISRECORD_DISCORD_GATEWAY_URL', 'http://spacebar-gateway:3002'],
    ['DISRECORD_DISCORD_WEB_BASE', 'not a url'],
  ])('refuses to boot on a malformed %s, and does not echo the value', (name, value) => {
    setEnv({ [name]: value })
    expect(() => resolveStandaloneConfig()).toThrow(new RegExp(`Invalid ${name}`))
    try {
      resolveStandaloneConfig()
    } catch (err) {
      expect((err as Error).message).not.toContain(value)
    }
  })
})

describe('pinGatewayUrl', () => {
  function fakeClient(answers: Record<string, unknown>) {
    const get = jest.fn(async (route: string) => answers[route])
    return { client: { rest: { get } } as never, get }
  }

  it('replaces only the url of the /gateway/bot answer', async () => {
    const limits = { total: 1000, remaining: 999, reset_after: 0, max_concurrency: 1 }
    const { client } = fakeClient({
      [Routes.gatewayBot()]: { url: 'ws://localhost:11000/public', shards: 1, session_start_limit: limits },
    })
    pinGatewayUrl(client, 'ws://spacebar-gateway:3002')
    const answer = await (client as { rest: { get: (route: string) => Promise<unknown> } }).rest.get(Routes.gatewayBot())
    expect(answer).toEqual({ url: 'ws://spacebar-gateway:3002', shards: 1, session_start_limit: limits })
  })

  it('passes every other route through untouched, with its options', async () => {
    const channel = { id: '1', url: 'https://not-a-gateway.invalid' }
    const { client, get } = fakeClient({ [Routes.channel('1')]: channel })
    pinGatewayUrl(client, 'ws://spacebar-gateway:3002')
    const rest = (client as { rest: { get: (route: string, options?: unknown) => Promise<unknown> } }).rest
    expect(await rest.get(Routes.channel('1'), { auth: false })).toBe(channel)
    expect(get).toHaveBeenCalledWith(Routes.channel('1'), { auth: false })
  })
})

describe('fetchInteractionDelivery — api base', () => {
  function mockFetch() {
    const fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({}) }))
    global.fetch = fetchMock as never
    return fetchMock
  }

  it('asks Discord when no base is given', async () => {
    const fetchMock = mockFetch()
    await fetchInteractionDelivery('tok', silentLogger)
    expect(fetchMock).toHaveBeenCalledWith('https://discord.com/api/v10/applications/@me', expect.anything())
  })

  it('asks the configured base, and nowhere else', async () => {
    const fetchMock = mockFetch()
    await fetchInteractionDelivery('tok', silentLogger, 'http://spacebar:3001/api')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('http://spacebar:3001/api/v10/applications/@me', expect.anything())
  })
})

describe('messageLink', () => {
  it('builds the link a Discord client uses', () => {
    expect(messageLink(DEFAULT_DISCORD_WEB_BASE, '10', '20', '30')).toBe('https://discord.com/channels/10/20/30')
  })

  it('follows the web base', () => {
    expect(messageLink('https://chat.example.invalid/app', '10', '20', '30')).toBe('https://chat.example.invalid/app/channels/10/20/30')
  })
})
