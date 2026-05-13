/**
 * Worker config resolution.
 */
import { resolveConfig } from '../../src/config.js'

const WORKER_ENV = {
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

describe('resolveConfig', () => {
  it('returns a WorkerConfig from the spawn-time env', () => {
    setEnv(WORKER_ENV)
    const c = resolveConfig()
    expect(c.installationId).toBe('i1')
    expect(c.userId).toBe('u1')
    expect(c.guildId).toBe('g1')
    expect(c.channelId).toBe('c1')
    expect(c.deepgramMode).toBe('platform')
    expect(c.deepgramKey).toBeUndefined()
    expect(c.coreServerUrl).toBe('http://core:3001')
    expect(c.coreServerToken).toBe('jwt.placeholder.token')
    expect(c.size).toBe('micro')
  })

  it('passes through deepgramKey when mode is byok', () => {
    setEnv({ ...WORKER_ENV, DISRECORD_DEEPGRAM_MODE: 'byok', DISRECORD_DEEPGRAM_KEY: 'dg-key' })
    const c = resolveConfig()
    expect(c.deepgramMode).toBe('byok')
    expect(c.deepgramKey).toBe('dg-key')
  })

  it('throws when a required env var is missing', () => {
    setEnv({ ...WORKER_ENV, CORE_SERVER_TOKEN: '' })
    expect(() => resolveConfig()).toThrow(/CORE_SERVER_TOKEN/)
  })

  it('honors DISRECORD_SIZE override', () => {
    setEnv({ ...WORKER_ENV, DISRECORD_SIZE: 'small' })
    const c = resolveConfig()
    expect(c.size).toBe('small')
  })

  it('rejects invalid DISRECORD_SIZE', () => {
    setEnv({ ...WORKER_ENV, DISRECORD_SIZE: 'jumbo' })
    expect(() => resolveConfig()).toThrow(/Invalid DISRECORD_SIZE/)
  })
})
