/**
 * Verifies env-driven config resolution per mode.
 */
import { resolveConfig } from '../../src/config.js'

const GATEWAY_ENV = {
  RESESH_DISCORD_TOKEN: 'tok',
  RESESH_DISCORD_PUBLIC_KEY: 'pubkey',
  CORE_SERVER_URL: 'http://core:3001',
  CORE_SERVER_AUTH_SECRET: 'secret',
}

const WORKER_ENV = {
  RESESH_VOICE_TOKEN: 'vtok',
  RESESH_VOICE_SESSION_ID: 'vsid',
  RESESH_VOICE_ENDPOINT: 'wss://discord',
  RESESH_GUILD_ID: 'g1',
  RESESH_CHANNEL_ID: 'c1',
  RESESH_USER_ID: 'u1',
  RESESH_INSTALLATION_ID: 'i1',
  RESESH_DEEPGRAM_MODE: 'platform',
  CORE_SERVER_URL: 'http://core:3001',
  CORE_SERVER_AUTH_SECRET: 'secret',
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
    setEnv({ ...GATEWAY_ENV, RESESH_DISCORD_TOKEN: '' })
    expect(() => resolveConfig('gateway')).toThrow(/RESESH_DISCORD_TOKEN/)
  })

  it('honors PORT override', () => {
    setEnv({ ...GATEWAY_ENV, PORT: '5000' })
    const c = resolveConfig('gateway')
    if (c.mode !== 'gateway') throw new Error('expected gateway mode')
    expect(c.port).toBe(5000)
  })
})

describe('resolveConfig — worker mode', () => {
  it('returns a WorkerConfig from the voice handoff env', () => {
    setEnv(WORKER_ENV)
    const c = resolveConfig('worker')
    expect(c.mode).toBe('worker')
    if (c.mode !== 'worker') return
    expect(c.voiceToken).toBe('vtok')
    expect(c.installationId).toBe('i1')
    expect(c.deepgramMode).toBe('platform')
    expect(c.deepgramKey).toBeUndefined()
  })

  it('passes through deepgramKey when mode is byok', () => {
    setEnv({ ...WORKER_ENV, RESESH_DEEPGRAM_MODE: 'byok', RESESH_DEEPGRAM_KEY: 'dg-key' })
    const c = resolveConfig('worker')
    if (c.mode !== 'worker') throw new Error('expected worker mode')
    expect(c.deepgramMode).toBe('byok')
    expect(c.deepgramKey).toBe('dg-key')
  })

  it('throws when a required voice handoff env var is missing', () => {
    setEnv({ ...WORKER_ENV, RESESH_VOICE_TOKEN: '' })
    expect(() => resolveConfig('worker')).toThrow(/RESESH_VOICE_TOKEN/)
  })
})
