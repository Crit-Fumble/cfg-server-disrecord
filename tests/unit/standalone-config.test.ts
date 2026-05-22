/**
 * Standalone (serve mode) config resolution.
 */
import { resolveStandaloneConfig } from '../../src/config.js'

const BASE_ENV = {
  DISCORD_BOT_TOKEN: 'bot-token',
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
    expect(() => resolveStandaloneConfig()).toThrow(/DISCORD_BOT_TOKEN/)
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

  describe('CFG-hosted transcription surcharge', () => {
    const CFG_ENV = {
      ...BASE_ENV,
      CORE_SERVER_URL: 'http://core:3001',
      CORE_SERVER_TOKEN: 'jwt',
      DISRECORD_INSTALLATION_ID: 'inst-1',
      DISRECORD_USER_ID: 'user-1',
    }

    it('leaves transcriptionCtPerMinute undefined when the env var is absent', () => {
      setEnv(CFG_ENV)
      expect(resolveStandaloneConfig().cfg?.transcriptionCtPerMinute).toBeUndefined()
    })

    it('treats an empty DISRECORD_TRANSCRIPTION_CT_PER_MIN as absent (undefined)', () => {
      setEnv({ ...CFG_ENV, DISRECORD_TRANSCRIPTION_CT_PER_MIN: '' })
      expect(resolveStandaloneConfig().cfg?.transcriptionCtPerMinute).toBeUndefined()
    })

    it('resolves a numeric DISRECORD_TRANSCRIPTION_CT_PER_MIN', () => {
      setEnv({ ...CFG_ENV, DISRECORD_TRANSCRIPTION_CT_PER_MIN: '2.5' })
      expect(resolveStandaloneConfig().cfg?.transcriptionCtPerMinute).toBe(2.5)
    })

    it('rejects a non-numeric / non-positive surcharge rate', () => {
      setEnv({ ...CFG_ENV, DISRECORD_TRANSCRIPTION_CT_PER_MIN: 'abc' })
      expect(() => resolveStandaloneConfig()).toThrow(/DISRECORD_TRANSCRIPTION_CT_PER_MIN/)
      setEnv({ ...CFG_ENV, DISRECORD_TRANSCRIPTION_CT_PER_MIN: '0' })
      expect(() => resolveStandaloneConfig()).toThrow(/DISRECORD_TRANSCRIPTION_CT_PER_MIN/)
    })

    it('is undefined for a self-host container (no CORE_SERVER_URL)', () => {
      setEnv({ ...BASE_ENV, DISRECORD_TRANSCRIPTION_CT_PER_MIN: '2' })
      expect(resolveStandaloneConfig().cfg).toBeUndefined()
    })
  })
})
