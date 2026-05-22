/**
 * Unit tests for buildDeepgramTokenProvider — the platform/byok/disabled fork
 * that resolves a Deepgram websocket credential.
 */
import { buildDeepgramTokenProvider } from '../../../src/deepgram/token-provider.js'
import type { CoreServerClient } from '../../../src/phone-home/core-client.js'
import { logger } from '../../../src/logger.js'

/** A CoreServerClient stub — only fetchDeepgramToken is exercised here. */
function fakeCore(token: Awaited<ReturnType<CoreServerClient['fetchDeepgramToken']>>): CoreServerClient {
  return { fetchDeepgramToken: jest.fn(async () => token) } as unknown as CoreServerClient
}

describe('buildDeepgramTokenProvider', () => {
  it('returns null for disabled mode (record-only)', () => {
    const provider = buildDeepgramTokenProvider({ mode: 'disabled', core: fakeCore(null), logger })
    expect(provider).toBeNull()
  })

  it('returns null for byok mode without a static key', () => {
    const provider = buildDeepgramTokenProvider({ mode: 'byok', core: fakeCore(null), logger })
    expect(provider).toBeNull()
  })

  it('byok mode returns the static key with the Token scheme', async () => {
    const provider = buildDeepgramTokenProvider({
      mode: 'byok',
      staticKey: 'user-byok-key',
      core: fakeCore(null),
      logger,
    })
    expect(provider).not.toBeNull()
    await expect(Promise.resolve(provider!())).resolves.toEqual({ value: 'user-byok-key', scheme: 'Token' })
  })

  it('platform mode mints a grant token and uses the Bearer scheme', async () => {
    const core = fakeCore({ accessToken: 'grant-xyz', expiresIn: 3600 })
    const provider = buildDeepgramTokenProvider({ mode: 'platform', core, logger })
    expect(provider).not.toBeNull()
    await expect(Promise.resolve(provider!())).resolves.toEqual({ value: 'grant-xyz', scheme: 'Bearer' })
    expect(core.fetchDeepgramToken).toHaveBeenCalledTimes(1)
  })

  it('platform mode resolves to null when grant minting fails (fail-safe to record-only)', async () => {
    const provider = buildDeepgramTokenProvider({ mode: 'platform', core: fakeCore(null), logger })
    expect(provider).not.toBeNull()
    await expect(Promise.resolve(provider!())).resolves.toBeNull()
  })
})
