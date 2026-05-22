/**
 * Standalone (serve mode) config resolution.
 */
import { resolveStandaloneConfig } from '../../src/config.js'

const BASE_ENV = {
  DISRECORD_DISCORD_TOKEN: 'bot-token',
  DISRECORD_DISCORD_CLIENT_ID: '1504164101553656028',
}

const ORIG = process.env

afterEach(() => {
  process.env = ORIG
})

function setEnv(vars: Record<string, string>): void {
  process.env = { ...ORIG, ...vars } as NodeJS.ProcessEnv
}

describe('resolveStandaloneConfig', () => {
  it('resolves required vars + Phase 1 defaults', () => {
    setEnv(BASE_ENV)
    const c = resolveStandaloneConfig()
    expect(c.discordToken).toBe('bot-token')
    expect(c.discordClientId).toBe('1504164101553656028')
    expect(c.deepgramKey).toBeUndefined()
    expect(c.deepgramModel).toBe('nova-3')
    expect(c.deepgramLanguage).toBe('en')
    expect(c.outputDir).toBe('/data/recordings')
    expect(c.controlPort).toBe(8080)
    expect(c.controlToken).toBeUndefined()
  })

  it('throws when the bot token is missing', () => {
    setEnv({ DISRECORD_DISCORD_CLIENT_ID: 'x' })
    expect(() => resolveStandaloneConfig()).toThrow(/DISRECORD_DISCORD_TOKEN/)
  })

  it('throws when the client id is missing', () => {
    setEnv({ DISRECORD_DISCORD_TOKEN: 'x' })
    expect(() => resolveStandaloneConfig()).toThrow(/DISRECORD_DISCORD_CLIENT_ID/)
  })

  it('treats an empty Deepgram key as record-only (undefined)', () => {
    setEnv({ ...BASE_ENV, DEEPGRAM_API_KEY: '' })
    expect(resolveStandaloneConfig().deepgramKey).toBeUndefined()
  })

  it('passes through a Deepgram key when set', () => {
    setEnv({ ...BASE_ENV, DEEPGRAM_API_KEY: 'dg-key', DEEPGRAM_MODEL: 'nova-2', DEEPGRAM_LANGUAGE: 'es' })
    const c = resolveStandaloneConfig()
    expect(c.deepgramKey).toBe('dg-key')
    expect(c.deepgramModel).toBe('nova-2')
    expect(c.deepgramLanguage).toBe('es')
  })

  it('honors CONTROL_PORT and CONTROL_TOKEN overrides', () => {
    setEnv({ ...BASE_ENV, CONTROL_PORT: '9999', CONTROL_TOKEN: 'secret' })
    const c = resolveStandaloneConfig()
    expect(c.controlPort).toBe(9999)
    expect(c.controlToken).toBe('secret')
  })

  it('rejects a non-numeric / out-of-range CONTROL_PORT', () => {
    setEnv({ ...BASE_ENV, CONTROL_PORT: 'abc' })
    expect(() => resolveStandaloneConfig()).toThrow(/CONTROL_PORT/)
    setEnv({ ...BASE_ENV, CONTROL_PORT: '70000' })
    expect(() => resolveStandaloneConfig()).toThrow(/CONTROL_PORT/)
  })
})
