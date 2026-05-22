/**
 * @jest-environment node
 */

/**
 * Unit tests for DeepgramStreamingClient credential resolution at connect().
 *
 * The client takes a token PROVIDER, not a static key. connect() invokes the
 * provider once, then authenticates the websocket with the returned
 * credential's scheme (`Token` for API keys, `Bearer` for grant tokens). A
 * provider that returns null aborts the connection.
 */

import { DeepgramStreamingClient } from '@/deepgram/client'

let mockWsInstance: any
let capturedWsOptions: any

jest.mock('ws', () => {
  const { EventEmitter } = require('node:events')

  class MockWS extends EventEmitter {
    static readonly OPEN = 1
    readyState = 0
    send = jest.fn()
    terminate = jest.fn()
    open(): void {
      this.readyState = 1
      this.emit('open')
    }
  }

  return {
    WebSocket: class {
      static readonly OPEN = 1
      constructor(_url: string, options: unknown) {
        capturedWsOptions = options
        mockWsInstance = new MockWS()
        return mockWsInstance as any
      }
    },
  }
})

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  mockWsInstance = undefined
  capturedWsOptions = undefined
})

describe('DeepgramStreamingClient — connect() credential resolution', () => {
  it('authenticates with Token scheme for a static (byok) key', async () => {
    const client = new DeepgramStreamingClient(() => ({ value: 'byok-key', scheme: 'Token' }))
    const connecting = client.connect()
    await flush()
    mockWsInstance.open()
    await connecting
    expect(capturedWsOptions.headers.Authorization).toBe('Token byok-key')
  })

  it('authenticates with Bearer scheme for a platform grant token', async () => {
    const client = new DeepgramStreamingClient(async () => ({ value: 'grant-xyz', scheme: 'Bearer' }))
    const connecting = client.connect()
    await flush()
    mockWsInstance.open()
    await connecting
    expect(capturedWsOptions.headers.Authorization).toBe('Bearer grant-xyz')
  })

  it('rejects connect() and opens no websocket when the provider returns null', async () => {
    const client = new DeepgramStreamingClient(async () => null)
    await expect(client.connect()).rejects.toThrow(/no credential/)
    expect(mockWsInstance).toBeUndefined()
  })

  it('propagates a provider error and opens no websocket', async () => {
    const client = new DeepgramStreamingClient(async () => {
      throw new Error('grant mint failed')
    })
    await expect(client.connect()).rejects.toThrow(/grant mint failed/)
    expect(mockWsInstance).toBeUndefined()
  })
})
