/**
 * CoreServerClient.postRecordingEnded — the report that closes the loop on
 * worker-side stops (cfg-core-server#366).
 *
 *   - self-host: never touches fetch
 *   - hosted: POST /api/v1/recording/ended { installationId, reason } with the
 *     session bearer, time-bounded
 *   - the recording's length rides along as `durationSeconds` only when it is
 *     a real one (#74) — core never overwrites, so a bad value would stick
 *   - a 404 (core without the route yet) is tolerated: ship-ahead safety
 *   - a 5xx or a thrown fetch never propagates — the stop pipeline that calls
 *     this must complete whatever core does
 */
import { CoreServerClient } from '../../../src/phone-home/core-client.js'
import type { CfgHostedConfig } from '../../../src/config.js'
import { logger } from '../../../src/logger.js'

const HOSTED: CfgHostedConfig = {
  coreServerUrl: 'http://core:3001/',
  coreServerToken: 'jwt-token',
  installationId: 'inst-1',
  userId: 'user-1',
  size: 'small',
}

describe('CoreServerClient.postRecordingEnded', () => {
  let fetchSpy: jest.SpyInstance
  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('self-host is a no-op and never calls fetch', async () => {
    await new CoreServerClient(undefined, logger).postRecordingEnded('channel-empty')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('hosted posts the reason with the installation id and the session bearer', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }))
    await new CoreServerClient(HOSTED, logger).postRecordingEnded('bot-disconnected')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://core:3001/api/v1/recording/ended')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer jwt-token')
    expect(JSON.parse(init.body as string)).toEqual({ installationId: 'inst-1', reason: 'bot-disconnected' })
    // Time-bounded: the stop pipeline must never hang on core.
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([
    [5_400_000, 5_400],
    [1_234, 1.234],
  ])('carries a %d ms recording as durationSeconds %d', async (durationMs, durationSeconds) => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }))
    await new CoreServerClient(HOSTED, logger).postRecordingEnded('user-button', durationMs)
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ installationId: 'inst-1', reason: 'user-button', durationSeconds })
  })

  // 0 included: probeDuration returns 0 when ffprobe fails, and core keeps the first value it gets.
  it.each([undefined, NaN, Infinity, -1, 0])('leaves durationSeconds off for %p — no length is better than a wrong one', async (durationMs) => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }))
    await new CoreServerClient(HOSTED, logger).postRecordingEnded('channel-empty', durationMs)
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ installationId: 'inst-1', reason: 'channel-empty' })
  })

  it.each([404, 500])('a %d never throws', async (status) => {
    fetchSpy.mockResolvedValue(new Response(null, { status }))
    await expect(new CoreServerClient(HOSTED, logger).postRecordingEnded('user-button')).resolves.toBeUndefined()
  })

  it('a thrown fetch never throws', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(new CoreServerClient(HOSTED, logger).postRecordingEnded('shutdown')).resolves.toBeUndefined()
  })
})
