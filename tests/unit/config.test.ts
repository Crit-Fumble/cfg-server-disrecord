/**
 * Verifies env-driven config resolution per mode.
 */
import { resolveConfig } from '../../src/config.js'

const GATEWAY_ENV = {
  DISRECORD_DISCORD_TOKEN: 'tok',
  DISRECORD_DISCORD_PUBLIC_KEY: 'pubkey',
  CORE_SERVER_URL: 'http://core:3001',
  DISRECORD_GATEWAY_BEARER: 'gw-bearer',
}

const WORKER_ENV = {
  DISRECORD_GATEWAY_URL: 'http://gateway:4400',
  DISRECORD_SESSION_TOKEN: 'sess-tok',
  DISRECORD_INSTALLATION_ID: 'i1',
  DISRECORD_USER_ID: 'u1',
  DISRECORD_GUILD_ID: 'g1',
  DISRECORD_CHANNEL_ID: 'c1',
  DISRECORD_DEEPGRAM_MODE: 'platform',
  CORE_SERVER_URL: 'http://core:3001',
  CORE_SERVER_TOKEN: 'jwt.placeholder.token',
}

const ORIG = process.env

afterEach(() => {
  process.env = ORIG
})

function setEnv(vars: Record<string, string>): void {
  process.env = { ...ORIG, ...vars } as NodeJS.ProcessEnv
}

describe('resolveConfig — gateway mode', () => {
  it('returns a GatewayConfig from required env vars', () => {
    setEnv(GATEWAY_ENV)
    const c = resolveConfig('gateway')
    expect(c.mode).toBe('gateway')
    if (c.mode !== 'gateway') return
    expect(c.discordToken).toBe('tok')
    expect(c.coreServerUrl).toBe('http://core:3001')
    expect(c.port).toBe(4400)
  })

  it('throws when a required env var is missing', () => {
    setEnv({ ...GATEWAY_ENV, DISRECORD_DISCORD_TOKEN: '' })
    expect(() => resolveConfig('gateway')).toThrow(/DISRECORD_DISCORD_TOKEN/)
  })

  it('honors PORT override', () => {
    setEnv({ ...GATEWAY_ENV, PORT: '5000' })
    const c = resolveConfig('gateway')
    if (c.mode !== 'gateway') throw new Error('expected gateway mode')
    expect(c.port).toBe(5000)
  })
})

describe('resolveConfig — worker mode', () => {
  it('returns a WorkerConfig from the SSE handoff env', () => {
    setEnv(WORKER_ENV)
    const c = resolveConfig('worker')
    expect(c.mode).toBe('worker')
    if (c.mode !== 'worker') return
    expect(c.gatewayUrl).toBe('http://gateway:4400')
    expect(c.sessionToken).toBe('sess-tok')
    expect(c.installationId).toBe('i1')
    expect(c.deepgramMode).toBe('platform')
    expect(c.deepgramKey).toBeUndefined()
    expect(c.size).toBe('micro')
  })

  it('passes through deepgramKey when mode is byok', () => {
    setEnv({ ...WORKER_ENV, DISRECORD_DEEPGRAM_MODE: 'byok', DISRECORD_DEEPGRAM_KEY: 'dg-key' })
    const c = resolveConfig('worker')
    if (c.mode !== 'worker') throw new Error('expected worker mode')
    expect(c.deepgramMode).toBe('byok')
    expect(c.deepgramKey).toBe('dg-key')
  })

  it('throws when a required env var is missing', () => {
    setEnv({ ...WORKER_ENV, DISRECORD_SESSION_TOKEN: '' })
    expect(() => resolveConfig('worker')).toThrow(/DISRECORD_SESSION_TOKEN/)
  })

  it('honors DISRECORD_SIZE override', () => {
    setEnv({ ...WORKER_ENV, DISRECORD_SIZE: 'small' })
    const c = resolveConfig('worker')
    if (c.mode !== 'worker') throw new Error('expected worker mode')
    expect(c.size).toBe('small')
  })

  it('rejects invalid DISRECORD_SIZE', () => {
    setEnv({ ...WORKER_ENV, DISRECORD_SIZE: 'jumbo' })
    expect(() => resolveConfig('worker')).toThrow(/Invalid DISRECORD_SIZE/)
  })
})
