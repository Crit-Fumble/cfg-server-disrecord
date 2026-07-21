import { recoverVoiceConnection, type VoiceReconnectDeps } from '../../../src/gateway/voice-reconnect.js'

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as VoiceReconnectDeps['logger']

/**
 * Build deps with a virtual clock. `sleep` advances the clock instead of
 * waiting, so a 10-minute recovery window runs instantly and deterministically.
 */
function makeDeps(overrides: Partial<VoiceReconnectDeps> = {}) {
  let clock = 0
  const calls = { rejoin: 0, awaitReady: 0, slept: [] as number[] }

  const deps: VoiceReconnectDeps = {
    rejoin: () => {
      calls.rejoin++
      return true
    },
    awaitReady: async () => {
      calls.awaitReady++
    },
    isDestroyed: () => false,
    sleep: async (ms) => {
      calls.slept.push(ms)
      clock += ms
    },
    now: () => clock,
    logger: silentLogger,
    ...overrides,
  }

  return { deps, calls, tick: (ms: number) => (clock += ms) }
}

describe('recoverVoiceConnection', () => {
  it('recovers on the first attempt when the adapter is available', async () => {
    const { deps, calls } = makeDeps()

    await expect(recoverVoiceConnection(deps, {})).resolves.toBe(true)
    expect(calls.rejoin).toBe(1)
    expect(calls.awaitReady).toBe(1)
    expect(calls.slept).toHaveLength(0) // no backoff needed
  })

  it('keeps retrying while rejoin() reports the adapter unavailable, then succeeds', async () => {
    // rejoin() === false is the AdapterUnavailable case: the MAIN gateway
    // websocket is down, so the join payload cannot be sent. This is exactly
    // a momentary Discord API lapse — it must NOT be treated as terminal.
    let attempts = 0
    const { deps, calls } = makeDeps({
      rejoin: () => {
        attempts++
        return attempts > 4 // adapter comes back on the 5th attempt
      },
    })

    await expect(recoverVoiceConnection(deps, {})).resolves.toBe(true)
    expect(attempts).toBe(5)
    expect(calls.awaitReady).toBe(1) // only awaited once rejoin actually sent
  })

  it('retries when the connection rejoins but never reaches Ready', async () => {
    let readyCalls = 0
    const { deps } = makeDeps({
      awaitReady: async () => {
        readyCalls++
        if (readyCalls < 3) throw new Error('ready timeout')
      },
    })

    await expect(recoverVoiceConnection(deps, {})).resolves.toBe(true)
    expect(readyCalls).toBe(3)
  })

  it('gives up only after the full recovery window has elapsed', async () => {
    let attempts = 0
    const { deps, calls } = makeDeps({
      rejoin: () => {
        attempts++
        return false // adapter never comes back
      },
    })

    await expect(
      recoverVoiceConnection(deps, { windowMs: 60_000, retryDelayMs: 5_000 }),
    ).resolves.toBe(false)

    // Persisted for the whole window rather than bailing on first failure:
    // a 60s window at 5s per attempt is ~12 tries.
    expect(attempts).toBeGreaterThanOrEqual(11)
    expect(calls.slept.every((ms) => ms === 5_000)).toBe(true)
  })

  it('aborts immediately and reports no-recovery when the session was stopped', async () => {
    // leave()/stop() destroys the connection. Recovery must not fight it or
    // resurrect voice for a session that is deliberately over.
    const { deps, calls } = makeDeps({ isDestroyed: () => true })

    await expect(recoverVoiceConnection(deps, {})).resolves.toBe(false)
    expect(calls.rejoin).toBe(0)
  })

  it('stops retrying as soon as the connection is destroyed mid-recovery', async () => {
    let attempts = 0
    const { deps } = makeDeps({
      rejoin: () => {
        attempts++
        return false
      },
      isDestroyed: () => attempts >= 3,
    })

    await expect(recoverVoiceConnection(deps, {})).resolves.toBe(false)
    expect(attempts).toBe(3)
  })

  it('surfaces a rejoin() that throws as a retry, not a crash', async () => {
    let attempts = 0
    const { deps } = makeDeps({
      rejoin: () => {
        attempts++
        if (attempts === 1) throw new Error('adapter exploded')
        return true
      },
    })

    await expect(recoverVoiceConnection(deps, {})).resolves.toBe(true)
    expect(attempts).toBe(2)
  })
})
