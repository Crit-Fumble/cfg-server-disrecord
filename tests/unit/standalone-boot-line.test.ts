/**
 * The boot line says which settings file the container reads and where
 * "Discord" is.
 *
 * A launch is checked from outside by reading the worker's log, so the line
 * has to carry what the launch chose. It must not carry a credential: the
 * API base and the gateway address are URLs, and a URL can hold a user and a
 * password. Only the host is logged.
 */

const mockInfo = jest.fn()
jest.mock('../../src/logger.js', () => {
  const log = { info: (...args: unknown[]) => mockInfo(...args), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: () => log }
  return { logger: log }
})

// The boot line is the first thing startStandalone does; failing the gateway
// login right after it ends the boot before anything reaches the network.
jest.mock('../../src/gateway/discord-gateway.js', () => ({
  startGateway: jest.fn(async () => {
    throw new Error('stopped after the boot line')
  }),
  stopGateway: jest.fn(),
}))

import { resolveStandaloneConfig } from '../../src/config.js'
import { startStandalone } from '../../src/standalone.js'

const ORIG = process.env
const BOOT_LINE = 'starting cfg-server-disrecord in serve mode'

afterEach(() => {
  process.env = ORIG
})

async function bootLine(env: Record<string, string>): Promise<Record<string, unknown>> {
  process.env = { ...ORIG, DISRECORD_DISCORD_TOKEN: 'test-bot-token', ...env } as NodeJS.ProcessEnv
  await expect(startStandalone(resolveStandaloneConfig())).rejects.toThrow('stopped after the boot line')
  const call = mockInfo.mock.calls.find(([, msg]) => msg === BOOT_LINE)
  expect(call).toBeDefined()
  return call![0] as Record<string, unknown>
}

describe('startStandalone — the boot line', () => {
  it('points at Discord itself, and the default settings file, when nothing is set', async () => {
    const line = await bootLine({})
    expect(line).toMatchObject({
      settingsPath: '/data/disrecord/worlds.json',
      discordApiHost: 'discord.com',
      discordGatewayHost: null,
    })
  })

  it('names the settings file and the hosts it was given', async () => {
    const line = await bootLine({
      DISRECORD_SETTINGS_PATH: '/data/disrecord/other.json',
      DISRECORD_DISCORD_API_BASE: 'http://cfg-platform-spacebar-test:3001/api',
      DISRECORD_DISCORD_GATEWAY_URL: 'ws://cfg-platform-spacebar-gateway-test:3002',
    })
    expect(line).toMatchObject({
      settingsPath: '/data/disrecord/other.json',
      discordApiHost: 'cfg-platform-spacebar-test:3001',
      discordGatewayHost: 'cfg-platform-spacebar-gateway-test:3002',
    })
  })

  it('logs the host alone: never a user, a password or the path of either URL', async () => {
    const line = await bootLine({
      DISRECORD_DISCORD_API_BASE: 'https://bot:hunter2@spacebar.example.invalid/api',
      DISRECORD_DISCORD_GATEWAY_URL: 'wss://bot:hunter2@gateway.example.invalid/?token=abc',
    })
    expect(line.discordApiHost).toBe('spacebar.example.invalid')
    expect(line.discordGatewayHost).toBe('gateway.example.invalid')
    const text = JSON.stringify(line)
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('token=abc')
    expect(text).not.toContain('test-bot-token')
  })
})
