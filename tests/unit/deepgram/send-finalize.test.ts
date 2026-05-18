/**
 * @jest-environment node
 */

/**
 * Unit tests for DeepgramStreamingClient.send() + finalize() hot paths.
 *
 * Both methods get exercised on every recording session — send() runs at
 * ~50 Hz per active speaker, finalize() (currently unused but on the
 * critical-path candidate list) is the only way to flush in-flight
 * results without tearing down the connection.
 *
 * Coverage targets:
 *   - send() during CONNECTING — frames buffer + drain on 'open'
 *   - send() after close() — silently dropped (idempotent shutdown)
 *   - send() OPEN — straight to the wire
 *   - connect buffer cap — oldest frames dropped past MAX_CONNECT_BUFFER_BYTES
 *   - finalize() OPEN — emits Finalize JSON
 *   - finalize() closed / not-yet-open — no-op
 *
 * Companion to keepalive-cleanup.test.ts which uses the same WS mock;
 * kept separate to keep each file focused on one concern.
 */

import { DeepgramStreamingClient } from '@/deepgram/client'

let mockWsInstance: any

jest.mock('ws', () => {
  const { EventEmitter } = require('node:events')

  class MockWS extends EventEmitter {
    static readonly OPEN = 1
    static readonly CONNECTING = 0
    readyState = 0
    send = jest.fn()
    terminate = jest.fn()

    open(): void {
      this.readyState = 1
      this.emit('open')
    }
    serverClose(code = 1000, reason = ''): void {
      this.readyState = 3
      this.emit('close', code, Buffer.from(reason))
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

function makeClient(): DeepgramStreamingClient {
  return new DeepgramStreamingClient('test-key', { model: 'nova-3' })
}

/** Drive the connect() promise to resolved state. */
async function connectAndOpen(client: DeepgramStreamingClient): Promise<void> {
  const p = client.connect()
  // Microtask tick so the WS constructor + handlers register before we open.
  await Promise.resolve()
  mockWsInstance.open()
  await p
}

describe('DeepgramStreamingClient.send()', () => {
  beforeEach(() => {
    mockWsInstance = undefined
  })

  it('buffers frames while CONNECTING and drains them in order on open', async () => {
    const client = makeClient()
    const connectPromise = client.connect()
    await Promise.resolve()
    // Mock is now in CONNECTING state — these sends must buffer.
    client.send(Buffer.from([1, 2, 3]))
    client.send(Buffer.from([4, 5, 6]))
    client.send(Buffer.from([7, 8, 9]))
    expect(mockWsInstance.send).not.toHaveBeenCalled()

    // Opening drains the backlog BEFORE 'open' fires to listeners, so the
    // caller can't observe a moment of "open but not drained yet".
    mockWsInstance.open()
    await connectPromise

    const calls = mockWsInstance.send.mock.calls.map((c: any[]) => Array.from(c[0]))
    expect(calls).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ])
  })

  it('sends directly to the socket once OPEN', async () => {
    const client = makeClient()
    await connectAndOpen(client)
    mockWsInstance.send.mockClear()

    client.send(Buffer.from([10, 20]))
    client.send(Buffer.from([30, 40]))

    expect(mockWsInstance.send).toHaveBeenCalledTimes(2)
    expect(Array.from(mockWsInstance.send.mock.calls[0][0])).toEqual([10, 20])
    expect(Array.from(mockWsInstance.send.mock.calls[1][0])).toEqual([30, 40])
  })

  it('is a no-op after close() — drops frames silently', async () => {
    const client = makeClient()
    await connectAndOpen(client)
    mockWsInstance.send.mockClear()

    // close() sends CloseStream JSON + waits for the 'close' event. Fire
    // the server close immediately so the close() promise resolves.
    const closePromise = client.close()
    mockWsInstance.serverClose(1000, 'normal')
    await closePromise

    // The single send call recorded above is the CloseStream JSON,
    // not user audio — verify, then ensure subsequent sends are dropped.
    expect(mockWsInstance.send).toHaveBeenCalledTimes(1)
    expect(mockWsInstance.send.mock.calls[0][0]).toBe(
      JSON.stringify({ type: 'CloseStream' }),
    )
    mockWsInstance.send.mockClear()

    client.send(Buffer.from([1, 2, 3]))
    client.send(Buffer.from([4, 5, 6]))
    expect(mockWsInstance.send).not.toHaveBeenCalled()
  })

  it('drops oldest frames when the connect buffer exceeds MAX_CONNECT_BUFFER_BYTES', async () => {
    // MAX_CONNECT_BUFFER_BYTES = 480 KB. Push 100 frames × 5 KB = 500 KB and
    // verify the oldest got dropped before drain.
    const client = makeClient()
    const connectPromise = client.connect()
    await Promise.resolve()

    const FRAME_SIZE = 5 * 1024
    const sentinelBytes: number[] = []
    for (let i = 0; i < 100; i++) {
      const f = Buffer.alloc(FRAME_SIZE, i & 0xff)
      sentinelBytes.push(i & 0xff)
      client.send(f)
    }

    mockWsInstance.open()
    await connectPromise

    // We pushed 500 KB; budget is 480 KB. At minimum the oldest few frames
    // are gone. The newest frame must always be present (drain order is
    // FIFO over the remaining buffer).
    const drained = mockWsInstance.send.mock.calls.length
    expect(drained).toBeLessThan(100)
    expect(drained).toBeGreaterThan(0)

    // Verify drain order: each retained frame's first byte == its original
    // index. Since we dropped from the FRONT, the SEQUENCE of retained
    // indices is monotonically increasing.
    const retainedIndices = mockWsInstance.send.mock.calls.map(
      (c: any[]) => (c[0] as Buffer)[0],
    )
    for (let i = 1; i < retainedIndices.length; i++) {
      expect(retainedIndices[i]).toBeGreaterThan(retainedIndices[i - 1])
    }
    // The very last frame (index 99) is the one we most care about
    // preserving — newest audio.
    expect(retainedIndices[retainedIndices.length - 1]).toBe(99)
  })
})

describe('DeepgramStreamingClient.finalize()', () => {
  beforeEach(() => {
    mockWsInstance = undefined
  })

  it('emits a Finalize JSON message when OPEN', async () => {
    const client = makeClient()
    await connectAndOpen(client)
    mockWsInstance.send.mockClear()

    client.finalize()

    expect(mockWsInstance.send).toHaveBeenCalledTimes(1)
    expect(mockWsInstance.send.mock.calls[0][0]).toBe(
      JSON.stringify({ type: 'Finalize' }),
    )
  })

  it('is a no-op before connect() — no WebSocket exists yet', () => {
    const client = makeClient()
    // mockWsInstance is undefined because connect() never ran.
    expect(() => client.finalize()).not.toThrow()
    expect(mockWsInstance).toBeUndefined()
  })

  it('is a no-op after close() — closed flag wins', async () => {
    const client = makeClient()
    await connectAndOpen(client)

    const closePromise = client.close()
    mockWsInstance.serverClose(1000, 'normal')
    await closePromise

    mockWsInstance.send.mockClear()
    client.finalize()
    expect(mockWsInstance.send).not.toHaveBeenCalled()
  })

  it('is a no-op while still CONNECTING — needs OPEN to flush', async () => {
    const client = makeClient()
    const connectPromise = client.connect()
    await Promise.resolve()
    // Mock is in CONNECTING state.
    client.finalize()
    expect(mockWsInstance.send).not.toHaveBeenCalled()

    // Tidy up the dangling connect promise so jest doesn't whine about
    // open handles. Open + await + close — same shutdown as other tests.
    mockWsInstance.open()
    await connectPromise
    const closePromise = client.close()
    mockWsInstance.serverClose(1000, 'normal')
    await closePromise
  })
})
