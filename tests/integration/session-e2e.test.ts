/**
 * @jest-environment node
 */

/**
 * End-to-end recording session integration test.
 *
 * Wires REAL CoreServerClient + RecordingSession + VoiceReceiver +
 * startWorker against mocked I/O boundaries (fetch, Deepgram WebSocket,
 * @discordjs/opus). The unit tests exercise each piece in isolation;
 * this test exercises them composed.
 *
 * Scenario: 2-speaker session, u1 consented, u2 not consented. Both
 * speak. u1's audio reaches Deepgram, a final transcript fires, the
 * worker POSTs it back. u2's audio is redacted — one [redacted]
 * placeholder POSTs. Billing tick fires once on a 15-minute mark.
 * SIGTERM tears down. Final billing tick posts.
 *
 * What this covers that the unit tests don't:
 *   - CoreServerClient's fetch wiring (URLs, auth headers, body shape)
 *   - VoiceReceiver's SSE parser fed by a real ReadableStream
 *   - RecordingSession dispatching transcript events to the
 *     callback that wraps core.postTranscript
 *   - The full closure-over startWorker's billing-tick + teardown
 *     logic running against real timers (jest fake) with all real
 *     collaborators wired up
 *
 * Why this matters: every piece is small + plausible in isolation;
 * the real risk is the joints between them. Recording is the one
 * platform feature in production today (#119/#124 ship history) —
 * an integration test that asserts the joints would have caught
 * #63 (Deepgram reconnect during silence) and the early redacted-
 * marker spam bugs before they hit users.
 */

import { jest } from '@jest/globals'
import { EventEmitter } from 'node:events'

// ─── Mock @discordjs/opus ──────────────────────────────────────────────
// Real opus decoder pulls native bindings at construction and complains
// when fed test bytes. We stub with a pass-through: any base64 frame
// becomes a 4-byte PCM buffer. RecordingSession doesn't inspect PCM
// contents; it just forwards to Deepgram.send().
jest.mock('@discordjs/opus', () => ({
  __esModule: true,
  default: {
    OpusEncoder: class {
      constructor() {}
      decode(input: Buffer): Buffer {
        return Buffer.from([0x01, 0x02, 0x03, 0x04, input.length & 0xff])
      }
    },
  },
}))

// ─── Mock `ws` (Deepgram WebSocket) ────────────────────────────────────
// One MockWS per instantiation. Each is an EventEmitter we expose via
// `mockOpenWebsockets[]` so the test can drive transcript events.
const mockOpenWebsockets: Array<{
  ws: any
  url: string
  send: jest.Mock
  open: () => void
  close: () => void
  emitTranscript: (text: string, isFinal?: boolean) => void
}> = []

jest.mock('ws', () => {
  const { EventEmitter } = require('node:events')
  class MockWS extends EventEmitter {
    static readonly OPEN = 1
    static readonly CONNECTING = 0
    readyState = 0
    send = jest.fn()
    terminate = jest.fn()
  }
  return {
    WebSocket: class {
      static readonly OPEN = 1
      static readonly CONNECTING = 0
      constructor(url: string) {
        const w = new MockWS()
        const entry = {
          ws: w,
          url,
          send: w.send,
          open(): void {
            w.readyState = 1
            w.emit('open')
          },
          close(): void {
            w.readyState = 3
            w.emit('close', 1000, Buffer.from('normal'))
          },
          emitTranscript(text: string, isFinal = true): void {
            const msg = {
              type: 'Results',
              start: 0,
              duration: text.split(' ').length * 0.3,
              is_final: isFinal,
              speech_final: isFinal,
              channel: {
                alternatives: [
                  {
                    transcript: text,
                    confidence: 0.97,
                    words: text.split(' ').map((word, i) => ({
                      word,
                      start: i * 0.3,
                      end: (i + 1) * 0.3,
                      confidence: 0.97,
                    })),
                  },
                ],
              },
            }
            w.emit('message', Buffer.from(JSON.stringify(msg)))
          },
        }
        mockOpenWebsockets.push(entry)
        return w as any
      }
    },
  }
})

// ─── Mock fetch + capture per-URL handlers ─────────────────────────────
//
// We capture every fetch() the SUT makes so the test can assert on POST
// bodies. The SSE audio endpoint is given a ReadableStream we control
// from the test (via `pushSseEvent`).

interface SseEvent {
  event: string
  data: unknown
}

let mockSseController: ReadableStreamDefaultController<Uint8Array> | null = null
let mockSseStream: ReadableStream<Uint8Array> | null = null

function makeSseStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      mockSseController = controller
    },
  })
}

function pushSseEvent(ev: SseEvent): void {
  if (!mockSseController) throw new Error('SSE controller not initialized')
  const block = `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`
  mockSseController.enqueue(new TextEncoder().encode(block))
}

function closeSseStream(): void {
  try {
    mockSseController?.close()
  } catch {
    // Controller already closed — abort signal got there first. Fine.
  }
  mockSseController = null
}

const mockTranscriptPosts: any[] = []
const mockBillingPosts: any[] = []
let mockSessionPolicyResponse: any = null

function installFetchMock() {
  const fetchSpy = jest.fn(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    const method = init?.method ?? 'GET'

    // ─── GET session-policy ───
    if (method === 'GET' && url.includes('/api/v1/recording/session-policy/')) {
      return new Response(JSON.stringify(mockSessionPolicyResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    // ─── GET audio SSE ───
    if (method === 'GET' && url.includes('/api/internal/disrecord/sessions/')) {
      mockSseStream = makeSseStream()
      return new Response(mockSseStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }

    // ─── POST transcript ───
    if (method === 'POST' && url.endsWith('/api/v1/recording/transcripts')) {
      mockTranscriptPosts.push(JSON.parse(init.body as string))
      return new Response(null, { status: 204 })
    }

    // ─── POST billing tick ───
    if (method === 'POST' && url.endsWith('/api/v1/billing/uptime-tick')) {
      mockBillingPosts.push(JSON.parse(init.body as string))
      return new Response(null, { status: 204 })
    }

    throw new Error(`Unexpected fetch in test: ${method} ${url}`)
  })
  // @ts-expect-error — global fetch reassignment for tests
  globalThis.fetch = fetchSpy
  return fetchSpy
}

// ─── Process-signal capture (avoid leaking real listeners) ─────────────

function spyOnProcessSignals() {
  const handlers: Record<string, Array<(...a: any[]) => void>> = {}
  const original = process.on.bind(process)
  jest.spyOn(process, 'on').mockImplementation(((event: string, handler: any) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      handlers[event] = handlers[event] ?? []
      handlers[event].push(handler)
      return process
    }
    return original(event as any, handler)
  }) as any)
  return {
    fire(event: 'SIGTERM' | 'SIGINT') {
      for (const h of handlers[event] ?? []) h(event)
    },
  }
}

async function tick(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

/**
 * Drain pending async work until a predicate holds (or give up after
 * `maxIters` microtask flushes). The async chain from SSE event →
 * RecordingSession dispatch → postTranscript fetch involves many
 * promise hops; a fixed tick(8) is too brittle.
 */
async function waitFor(predicate: () => boolean, maxIters = 200): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    if (predicate()) return
    await Promise.resolve()
  }
}

// ─── Test config + policy ──────────────────────────────────────────────

const CONFIG = {
  installationId: 'inst-e2e',
  guildId: 'guild-1',
  channelId: 'channel-1',
  coreServerUrl: 'http://core:3001',
  coreServerToken: 'jwt-token',
  deepgramKey: 'dg-key',
  deepgramMode: 'enabled' as const,
  size: 'small' as const,
  ctPerMinute: 7,
} as any

const POLICY = {
  consentedUserIds: ['u1'], // u2 NOT in set → redacted
  speakerNames: { u1: 'Alice', u2: 'Bob' },
  keywords: ['Eldritch'],
  keyterms: ['Whispering Cabal'],
}

const FAKE_OPUS_B64 = Buffer.from([0xfc, 0xff, 0xfe]).toString('base64')

describe('integration: 2-speaker session, mixed consent, billing, SIGTERM teardown', () => {
  beforeEach(() => {
    mockOpenWebsockets.length = 0
    mockTranscriptPosts.length = 0
    mockBillingPosts.length = 0
    mockSseController = null
    mockSseStream = null
    mockSessionPolicyResponse = POLICY
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
    // @ts-expect-error — restore global fetch to whatever was there
    delete globalThis.fetch
  })

  it('records consented speakers, redacts non-consented, ticks billing, posts final tick on SIGTERM', async () => {
    jest.useFakeTimers()
    installFetchMock()
    const signals = spyOnProcessSignals()

    // Load the SUT fresh against the current mock registry.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { startWorker } = require('../../src/worker')

    const done = startWorker(CONFIG)
    // Let policy fetch + collaborator wiring settle.
    await tick()

    // VoiceReceiver should now be connected to the SSE stream.
    expect(mockSseController).not.toBeNull()

    // ─── 1. u1 speaks (consented) → Deepgram stream opens ────────────
    pushSseEvent({ event: 'speaker-start', data: { speakerId: 'u1' } })
    await tick()
    expect(mockOpenWebsockets).toHaveLength(1)
    // Open the Deepgram WS — connect() resolves on open.
    mockOpenWebsockets[0].open()
    await tick()

    pushSseEvent({ event: 'speaker-data', data: { speakerId: 'u1', opus: FAKE_OPUS_B64 } })
    pushSseEvent({ event: 'speaker-data', data: { speakerId: 'u1', opus: FAKE_OPUS_B64 } })
    await waitFor(() => (mockOpenWebsockets[0].send as jest.Mock).mock.calls.length >= 2)
    // Deepgram WS received PCM frames (mocked opus → 5-byte PCM each).
    expect(mockOpenWebsockets[0].send).toHaveBeenCalled()

    // Deepgram returns a final transcript for u1.
    mockOpenWebsockets[0].emitTranscript('hello world from alice')
    await waitFor(() => mockTranscriptPosts.length >= 1)

    // ─── 2. u2 speaks (NOT consented) → redacted path ────────────────
    pushSseEvent({ event: 'speaker-start', data: { speakerId: 'u2' } })
    pushSseEvent({ event: 'speaker-data', data: { speakerId: 'u2', opus: FAKE_OPUS_B64 } })
    pushSseEvent({ event: 'speaker-end', data: { speakerId: 'u2' } })
    await waitFor(() => mockTranscriptPosts.length >= 2)

    // No second Deepgram WS — u2 was never streamed.
    expect(mockOpenWebsockets).toHaveLength(1)

    // Two transcripts have POSTed by now: u1 verbatim + u2 redacted.
    expect(mockTranscriptPosts).toHaveLength(2)
    const u1Post = mockTranscriptPosts.find((t) => t.speakerId === 'u1')
    expect(u1Post).toBeDefined()
    expect(u1Post.speakerName).toBe('Alice')
    expect(u1Post.transcript).toBe('hello world from alice')
    expect(u1Post.isRedacted).toBe(false)
    expect(u1Post.installationId).toBe('inst-e2e')

    const u2Post = mockTranscriptPosts.find((t) => t.speakerId === 'u2')
    expect(u2Post).toBeDefined()
    expect(u2Post.speakerName).toBe('[redacted]')
    expect(u2Post.transcript).toBe('[redacted]')
    expect(u2Post.isRedacted).toBe(true)

    // ─── 3. 15 min elapses → periodic billing tick ───────────────────
    await jest.advanceTimersByTimeAsync(15 * 60_000)
    expect(mockBillingPosts).toHaveLength(1)
    expect(mockBillingPosts[0].resourceType).toBe('bot_container')
    expect(mockBillingPosts[0].minutes).toBeCloseTo(15, 0)
    expect(mockBillingPosts[0].ctPerMinute).toBe(7)
    expect(mockBillingPosts[0].label).not.toMatch(/final/)
    expect(mockBillingPosts[0].installationId).toBe('inst-e2e')

    // ─── 4. SIGTERM teardown → final tick + clean shutdown ───────────
    await jest.advanceTimersByTimeAsync(3 * 60_000) // 3 min of post-tick activity
    signals.fire('SIGTERM')
    // The signal handler aborts the receiver; close the SSE to let the
    // pump loop exit cleanly.
    closeSseStream()
    // Also close the Deepgram WS so session.stop() can resolve its
    // close()-pending promise instead of hitting the 3s terminate timeout.
    mockOpenWebsockets[0].close()
    // Keep fake timers ON through `await done`. The worker uses Date.now()
    // to compute `finalMinutes = (now - lastTickAt) / 60_000` for the
    // final tick; flipping to real timers here would mix a fake-time
    // anchor with a real-time now and the difference goes negative,
    // suppressing the final tick under the `if (finalMinutes > 0)` guard.
    await done
    jest.useRealTimers()

    // Final tick posted with `final` label.
    expect(mockBillingPosts.length).toBeGreaterThanOrEqual(2)
    const finalTick = mockBillingPosts[mockBillingPosts.length - 1]
    expect(finalTick.label).toMatch(/final/)
    expect(finalTick.minutes).toBeGreaterThan(0)
    expect(finalTick.minutes).toBeLessThan(15)
  })

  it('falls back to default policy when session-policy fetch returns non-2xx', async () => {
    // Override fetch to 500 on policy. Worker should still wire up,
    // but with empty consent + no keywords/keyterms.
    installFetchMock()
    const originalFetch = globalThis.fetch
    // @ts-expect-error — wrap original to short-circuit policy fetch
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/recording/session-policy/')) {
        return new Response('boom', { status: 500 })
      }
      return originalFetch(input, init)
    }

    spyOnProcessSignals()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { startWorker } = require('../../src/worker')

    const done = startWorker(CONFIG)
    await tick()

    // SSE connected → policy failure didn't abort startup.
    expect(mockSseController).not.toBeNull()

    // With consent set empty, every speaker is redacted.
    pushSseEvent({ event: 'speaker-start', data: { speakerId: 'u1' } })
    pushSseEvent({ event: 'speaker-data', data: { speakerId: 'u1', opus: FAKE_OPUS_B64 } })
    pushSseEvent({ event: 'speaker-end', data: { speakerId: 'u1' } })
    await waitFor(() => mockTranscriptPosts.length >= 1)

    // No Deepgram WS opened — empty consent set redacts everyone.
    expect(mockOpenWebsockets).toHaveLength(0)
    expect(mockTranscriptPosts).toHaveLength(1)
    expect(mockTranscriptPosts[0].isRedacted).toBe(true)

    closeSseStream()
    await done
  })
})
