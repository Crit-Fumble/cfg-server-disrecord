/**
 * Unit tests for CoreServerClient — worker → core-server HTTP callbacks.
 */

import { CoreServerClient } from '../../../src/worker/core-server-client.js'

const ORIG_FETCH = global.fetch

afterEach(() => {
  global.fetch = ORIG_FETCH
})

function mockFetch(impl: (url: string, init: any) => Promise<{ ok: boolean; status: number; body: unknown }>): jest.Mock {
  const fn = jest.fn(async (url: string, init: any) => {
    const r = await impl(url, init)
    return {
      ok: r.ok,
      status: r.status,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
      json: async () => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body),
    }
  })
  global.fetch = fn as unknown as typeof fetch
  return fn
}

function makeClient(): CoreServerClient {
  return new CoreServerClient({
    baseUrl: 'http://core:3001/',
    authSecret: 'secret',
    installationId: 'inst-1',
  })
}

describe('CoreServerClient.fetchSessionPolicy', () => {
  it('GETs the right URL with bearer auth and parses JSON', async () => {
    const fetchMock = mockFetch(async () => ({
      ok: true,
      status: 200,
      body: { consentedUserIds: ['u1', 'u2'], speakerNames: { u1: 'Alice' } },
    }))
    const policy = await makeClient().fetchSessionPolicy()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://core:3001/api/v1/recording/session-policy/inst-1')
    expect(init.method).toBe('GET')
    expect(init.headers.authorization).toBe('Bearer secret')
    expect(policy).toEqual({ consentedUserIds: ['u1', 'u2'], speakerNames: { u1: 'Alice' } })
  })

  it('returns sensible defaults on non-2xx', async () => {
    mockFetch(async () => ({ ok: false, status: 500, body: 'server error' }))
    const policy = await makeClient().fetchSessionPolicy()
    expect(policy).toEqual({ consentedUserIds: [], speakerNames: {} })
  })

  it('returns sensible defaults when fetch throws', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('network')
    }) as unknown as typeof fetch
    const policy = await makeClient().fetchSessionPolicy()
    expect(policy).toEqual({ consentedUserIds: [], speakerNames: {} })
  })
})

describe('CoreServerClient.postTranscript', () => {
  it('POSTs to /api/v1/recording/transcripts with installationId + payload', async () => {
    const fetchMock = mockFetch(async () => ({ ok: true, status: 200, body: '' }))
    await makeClient().postTranscript({
      speakerId: 'u1',
      speakerName: 'Alice',
      transcript: 'hello',
      isRedacted: false,
      startSec: 1.2,
      endSec: 1.8,
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://core:3001/api/v1/recording/transcripts')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toMatchObject({
      installationId: 'inst-1',
      speakerId: 'u1',
      transcript: 'hello',
      isRedacted: false,
    })
  })

  it('logs but does not throw on non-2xx', async () => {
    mockFetch(async () => ({ ok: false, status: 503, body: 'down' }))
    await expect(
      makeClient().postTranscript({
        speakerId: 'u1',
        speakerName: 'Alice',
        transcript: 'hi',
        isRedacted: false,
        startSec: 0,
        endSec: 1,
      }),
    ).resolves.toBeUndefined()
  })
})

describe('CoreServerClient.postBillingTick', () => {
  it('POSTs to /api/v1/billing/uptime-tick with installationId + payload', async () => {
    const fetchMock = mockFetch(async () => ({ ok: true, status: 200, body: '' }))
    await makeClient().postBillingTick({
      resourceType: 'bot_container',
      minutes: 15.0,
      ctPerMinute: 8,
      label: 'Recording Server (micro): 15 min',
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://core:3001/api/v1/billing/uptime-tick')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      installationId: 'inst-1',
      resourceType: 'bot_container',
      minutes: 15.0,
      ctPerMinute: 8,
      label: 'Recording Server (micro): 15 min',
    })
  })

  it('logs but does not throw when fetch throws', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('boom')
    }) as unknown as typeof fetch
    await expect(
      makeClient().postBillingTick({
        resourceType: 'transcription',
        minutes: 1,
        ctPerMinute: 2,
        label: 'tx',
      }),
    ).resolves.toBeUndefined()
  })
})
