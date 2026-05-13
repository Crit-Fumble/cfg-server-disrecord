/**
 * @jest-environment node
 */

/**
 * Unit tests for DeepgramStreamingClient keepalive timer cleanup.
 *
 * Verifies that every setInterval created for WebSocket keepalive is
 * properly cleared on all exit paths: close, error, and process signals.
 * Prevents zombie timers that leak memory in long-running sessions (#236).
 */

import { DeepgramStreamingClient } from '@/deepgram/client'

// ---------------------------------------------------------------------------
// Mock `ws` — replace WebSocket with an EventEmitter that simulates
// the open/close/error lifecycle without touching the network.
// Jest hoists jest.mock() above all declarations, so the factory must
// use only inline literals and the `require` it receives.
// ---------------------------------------------------------------------------

let mockWsInstance: any

jest.mock('ws', () => {
  const { EventEmitter } = require('node:events')

  class MockWS extends EventEmitter {
    static readonly OPEN = 1
    static readonly CONNECTING = 0
    readyState = 0 // CONNECTING
    send = jest.fn()
    terminate = jest.fn()

    open(): void {
      this.readyState = 1 // OPEN
      this.emit('open')
    }
    serverClose(code = 1000, reason = ''): void {
      this.readyState = 3 // CLOSED
      this.emit('close', code, Buffer.from(reason))
    }
    triggerError(msg = 'mock error'): void {
      this.emit('error', new Error(msg))
    }
  }

  return {
    WebSocket: class {
      static readonly OPEN = 1
      static readonly CONNECTING = 0
      constructor() {
        mockWsInstance = new MockWS()
        return mockWsInstance as any
      }
    },
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createClient(): DeepgramStreamingClient {
  return new DeepgramStreamingClient('test-api-key')
}

/** Call close() and advance fake timers so the internal 3s timeout resolves. */
async function closeClient(client: DeepgramStreamingClient): Promise<void> {
  const p = client.close()
  jest.advanceTimersByTime(3_000)
  await p
}

/** Count active timers by checking the private field via bracket notation. */
function hasKeepaliveTimer(client: DeepgramStreamingClient): boolean {
  return (client as any).keepaliveTimer != null
}

function sigintListenerCount(): number {
  return process.listenerCount('SIGINT')
}

function sigtermListenerCount(): number {
  return process.listenerCount('SIGTERM')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeepgramStreamingClient — keepalive timer cleanup (#236)', () => {
  let baselineSigint: number
  let baselineSigterm: number

  beforeEach(() => {
    jest.useFakeTimers()
    baselineSigint = sigintListenerCount()
    baselineSigterm = sigtermListenerCount()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('starts keepalive timer on connect', async () => {
    const client = createClient()
    const connecting = client.connect()
    mockWsInstance.open()
    await connecting

    expect(hasKeepaliveTimer(client)).toBe(true)
    expect(sigintListenerCount()).toBe(baselineSigint + 1)
    expect(sigtermListenerCount()).toBe(baselineSigterm + 1)

    await closeClient(client)
  })

  it('clears timer and signal listeners on explicit close()', async () => {
    const client = createClient()
    client.on('error', () => {}) // prevent unhandled
    const connecting = client.connect()
    mockWsInstance.open()
    await connecting

    await closeClient(client)

    expect(hasKeepaliveTimer(client)).toBe(false)
    expect(sigintListenerCount()).toBe(baselineSigint)
    expect(sigtermListenerCount()).toBe(baselineSigterm)
  })

  it('clears timer on server-initiated close', async () => {
    const client = createClient()
    const connecting = client.connect()
    mockWsInstance.open()
    await connecting

    mockWsInstance.serverClose(1000, 'normal')

    expect(hasKeepaliveTimer(client)).toBe(false)
    expect(sigintListenerCount()).toBe(baselineSigint)
    expect(sigtermListenerCount()).toBe(baselineSigterm)
  })

  it('clears timer on WebSocket error', async () => {
    const client = createClient()
    client.on('error', () => {}) // prevent unhandled rejection
    const connecting = client.connect()
    mockWsInstance.open()
    await connecting

    expect(hasKeepaliveTimer(client)).toBe(true)
    mockWsInstance.triggerError('connection reset')

    expect(hasKeepaliveTimer(client)).toBe(false)
    expect(sigintListenerCount()).toBe(baselineSigint)
    expect(sigtermListenerCount()).toBe(baselineSigterm)
  })

  it('clears timer on error during connect (before open)', async () => {
    const client = createClient()
    client.on('error', () => {})
    const connecting = client.connect().catch(() => {})
    // Error fires before open — keepalive was never started, but
    // stopKeepalive is still called defensively and must not throw.
    mockWsInstance.triggerError('handshake failed')
    await connecting

    expect(hasKeepaliveTimer(client)).toBe(false)
    expect(sigintListenerCount()).toBe(baselineSigint)
    expect(sigtermListenerCount()).toBe(baselineSigterm)
  })

  it('no pending timers remain after open + close cycle', async () => {
    const client = createClient()
    const connecting = client.connect()
    mockWsInstance.open()
    await connecting

    // Advance time to prove the keepalive interval fires
    jest.advanceTimersByTime(8_000)
    expect(mockWsInstance.send).toHaveBeenCalledWith(JSON.stringify({ type: 'KeepAlive' }))

    await closeClient(client)

    // After close, advancing time must NOT trigger more keepalive sends.
    const callCount = mockWsInstance.send.mock.calls.length
    jest.advanceTimersByTime(24_000)
    expect(mockWsInstance.send.mock.calls.length).toBe(callCount)
  })

  it('close() is idempotent — calling twice does not throw', async () => {
    const client = createClient()
    const connecting = client.connect()
    mockWsInstance.open()
    await connecting

    await closeClient(client)
    await closeClient(client) // second call is a no-op

    expect(hasKeepaliveTimer(client)).toBe(false)
  })

  it('stopKeepalive is idempotent — calling without a timer does not throw', () => {
    const client = createClient()
    // Never connected, so no timer exists.
    ;(client as any).stopKeepalive()
    expect(hasKeepaliveTimer(client)).toBe(false)
  })
})
