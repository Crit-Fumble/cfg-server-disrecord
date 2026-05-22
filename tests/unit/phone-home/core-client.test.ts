/**
 * CoreServerClient — blank-slate-boot no-op behavior + hosted best-effort.
 *
 * The load-bearing property: with `undefined` config (no CORE_SERVER_URL)
 * every method is a clean no-op and NEVER touches `fetch`.
 */
import { CoreServerClient } from '../../../src/phone-home/core-client.js'
import type { CfgHostedConfig } from '../../../src/config.js'
import { logger } from '../../../src/logger.js'

const HOSTED: CfgHostedConfig = {
  coreServerUrl: 'http://core:3001',
  coreServerToken: 'jwt-token',
  installationId: 'inst-1',
  userId: 'user-1',
  ctPerMinute: 13,
  size: 'small',
}

describe('CoreServerClient — self-host (no CFG config)', () => {
  let fetchSpy: jest.SpyInstance

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('reports disabled', () => {
    expect(new CoreServerClient(undefined, logger).enabled).toBe(false)
  })

  it('fetchSessionPolicy returns an empty policy and never calls fetch', async () => {
    const client = new CoreServerClient(undefined, logger)
    const policy = await client.fetchSessionPolicy()
    expect(policy).toEqual({ consentedUserIds: [], speakerNames: {} })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('postTranscript is a no-op and never calls fetch', async () => {
    const client = new CoreServerClient(undefined, logger)
    await client.postTranscript({
      speakerId: 's',
      speakerName: 'S',
      transcript: 'hi',
      isRedacted: false,
      startSec: 0,
      endSec: 1,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('postBillingTick is a no-op and never calls fetch', async () => {
    const client = new CoreServerClient(undefined, logger)
    await client.postBillingTick({ resourceType: 'server_uptime', minutes: 1, ctPerMinute: 13, label: 'x' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetchDeepgramToken returns null and never calls fetch (self-host record-only)', async () => {
    const client = new CoreServerClient(undefined, logger)
    expect(await client.fetchDeepgramToken()).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('CoreServerClient — CFG-hosted', () => {
  let fetchSpy: jest.SpyInstance

  afterEach(() => {
    fetchSpy?.mockRestore()
  })

  it('reports enabled', () => {
    expect(new CoreServerClient(HOSTED, logger).enabled).toBe(true)
  })

  it('fetchSessionPolicy GETs the policy with the JWT bearer', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ consentedUserIds: ['u1'], speakerNames: {} }), { status: 200 }),
    )
    const client = new CoreServerClient(HOSTED, logger)
    const policy = await client.fetchSessionPolicy()
    expect(policy.consentedUserIds).toEqual(['u1'])
    const [url, opts] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe('http://core:3001/api/v1/recording/session-policy/inst-1')
    expect((opts as RequestInit).headers).toMatchObject({ authorization: 'Bearer jwt-token' })
  })

  it('fetchSessionPolicy falls back to an empty policy when core is unreachable', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    const client = new CoreServerClient(HOSTED, logger)
    const policy = await client.fetchSessionPolicy()
    expect(policy).toEqual({ consentedUserIds: [], speakerNames: {} })
  })

  it('postBillingTick POSTs the installationId + payload', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    const client = new CoreServerClient(HOSTED, logger)
    await client.postBillingTick({ resourceType: 'server_uptime', minutes: 2.5, ctPerMinute: 13, label: 'x' })
    const [url, opts] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe('http://core:3001/api/v1/billing/uptime-tick')
    expect(JSON.parse((opts as RequestInit).body as string)).toMatchObject({
      installationId: 'inst-1',
      minutes: 2.5,
      resourceType: 'server_uptime',
    })
  })

  it('fetchDeepgramToken POSTs to the deepgram-token route and returns the grant', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'grant-abc', expiresIn: 3600 }), { status: 200 }),
    )
    const client = new CoreServerClient(HOSTED, logger)
    const grant = await client.fetchDeepgramToken()
    expect(grant).toEqual({ accessToken: 'grant-abc', expiresIn: 3600 })
    const [url, opts] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe('http://core:3001/api/v1/disrecord/deepgram-token')
    expect((opts as RequestInit).method).toBe('POST')
    expect((opts as RequestInit).headers).toMatchObject({ authorization: 'Bearer jwt-token' })
  })

  it('fetchDeepgramToken returns null on a non-2xx (graceful record-only fallback)', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }))
    const client = new CoreServerClient(HOSTED, logger)
    expect(await client.fetchDeepgramToken()).toBeNull()
  })

  it('fetchDeepgramToken returns null when core-server is unreachable', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    const client = new CoreServerClient(HOSTED, logger)
    expect(await client.fetchDeepgramToken()).toBeNull()
  })

  it('postTranscript swallows a non-2xx response', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }))
    const client = new CoreServerClient(HOSTED, logger)
    await expect(
      client.postTranscript({
        speakerId: 's',
        speakerName: 'S',
        transcript: 'hi',
        isRedacted: false,
        startSec: 0,
        endSec: 1,
      }),
    ).resolves.toBeUndefined()
  })
})
