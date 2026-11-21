/**
 * Standalone (serve mode) config resolution.
 */
import { resolveStandaloneConfig } from '../../src/config.js'

const BASE_ENV = {
  DISRECORD_DISCORD_TOKEN: 'bot-token',
}

const ORIG = process.env

afterEach(() => {
  process.env = ORIG
})

function setEnv(vars: Record<string, string>): void {
  process.env = { ...ORIG, ...vars } as NodeJS.ProcessEnv
}

describe('resolveStandaloneConfig', () => {
  it('resolves required vars + serve-mode defaults', () => {
    setEnv(BASE_ENV)
    const c = resolveStandaloneConfig()
    expect(c.discordToken).toBe('bot-token')
    expect(c.deepgramKey).toBeUndefined()
    expect(c.deepgramModel).toBe('nova-3')
    expect(c.deepgramLanguage).toBe('en')
    expect(c.outputDir).toBe('/data/recordings')
    expect(c.controlPort).toBe(8080)
    expect(c.controlToken).toBeUndefined()
  })

  it('throws when the bot token is missing', () => {
    setEnv({})
    expect(() => resolveStandaloneConfig()).toThrow(/DISRECORD_DISCORD_TOKEN/)
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

  describe('billing-rate envs are ignored (pricing is core-side)', () => {
    const CFG_ENV = {
      ...BASE_ENV,
      CORE_SERVER_URL: 'http://core:3001',
      CORE_SERVER_TOKEN: 'jwt',
      DISRECORD_INSTALLATION_ID: 'inst-1',
      DISRECORD_USER_ID: 'user-1',
    }

    it('resolves a hosted config with no rate fields, even when an older core injects them', () => {
      setEnv({ ...CFG_ENV, DISRECORD_CT_PER_MIN: '13', DISRECORD_TRANSCRIPTION_CT_PER_MIN: '2.5' })
      const cfg = resolveStandaloneConfig().cfg
      expect(cfg).toBeDefined()
      // The worker knows no prices — the fields must not exist on the config
      // at all, so nothing downstream can quietly start reading them again.
      expect(cfg as object).not.toHaveProperty('ctPerMinute')
      expect(cfg as object).not.toHaveProperty('transcriptionCtPerMinute')
    })

    it('does not reject garbage in a dead rate env (the vars are inert)', () => {
      setEnv({ ...CFG_ENV, DISRECORD_CT_PER_MIN: 'abc', DISRECORD_TRANSCRIPTION_CT_PER_MIN: '0' })
      expect(() => resolveStandaloneConfig()).not.toThrow()
    })

    it('cfg stays undefined for a self-host container regardless of rate envs', () => {
      setEnv({ ...BASE_ENV, DISRECORD_TRANSCRIPTION_CT_PER_MIN: '2' })
      expect(resolveStandaloneConfig().cfg).toBeUndefined()
    })
  })
})
