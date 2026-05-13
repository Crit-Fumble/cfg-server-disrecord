/**
 * Unit tests for VoiceReceiver — the worker-side SSE consumer.
 *
 * Mocks global fetch to return a controllable ReadableStream so we can
 * drive the SSE event protocol directly.
 */

import { VoiceReceiver } from '../../../src/worker/voice-receiver.js'
import type { RecordingSession } from '../../../src/worker/recording-session.js'

// Mock @discordjs/opus so we don't need native bindings in unit tests.
const decodeMock = jest.fn((opusBuf: Buffer) => Buffer.concat([Buffer.from('pcm:'), opusBuf]))
jest.mock('@discordjs/opus', () => ({
  __esModule: true,
  default: {
    OpusEncoder: jest.fn(function () {
      return { decode: decodeMock }
    }),
  },
}))

const ORIG_FETCH = global.fetch

afterEach(() => {
  global.fetch = ORIG_FETCH
  decodeMock.mockClear()
})

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]))
      } else {
        controller.close()
      }
    },
  })
}

function mockFetchOk(body: ReadableStream<Uint8Array>): jest.Mock {
  const fn = jest.fn(async () => ({
    ok: true,
    status: 200,
    body,
    text: async () => '',
  }))
  global.fetch = fn as unknown as typeof fetch
  return fn
}

function fakeSession(): jest.Mocked<RecordingSession> {
  return {
    onSpeakerStart: jest.fn(async () => undefined),
    onSpeakerData: jest.fn(() => undefined),
    onSpeakerEnd: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
    addConsentedUser: jest.fn(async () => undefined),
    addDeclinedUser: jest.fn(() => undefined),
    paused: false,
  } as unknown as jest.Mocked<RecordingSession>
}

function makeReceiver(session: RecordingSession): VoiceReceiver {
  return new VoiceReceiver({
    coreServerUrl: 'http://core:3001',
    token: 'jwt.placeholder.token',
    installationId: 'inst-1',
    session,
  })
}

describe('VoiceReceiver — connect + auth', () => {
  it('GETs core-server /api/internal/disrecord/sessions/:id/audio with bearer + event-stream accept', async () => {
    const stream = streamFromChunks([''])
    const fetchMock = mockFetchOk(stream)
    const session = fakeSession()
    const r = makeReceiver(session)
    await r.run()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://core:3001/api/internal/disrecord/sessions/inst-1/audio')
    expect(init.headers.authorization).toBe('Bearer jwt.placeholder.token')
    expect(init.headers.accept).toBe('text/event-stream')
  })

  it('throws when the connect returns non-2xx', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      body: null,
      text: async () => 'unauthorized',
    })) as unknown as typeof fetch
    const r = makeReceiver(fakeSession())
    await expect(r.run()).rejects.toThrow(/SSE connect 401/)
  })
})

describe('VoiceReceiver — SSE event dispatch', () => {
  it('dispatches speaker-start to session.onSpeakerStart', async () => {
    const stream = streamFromChunks(['event: speaker-start\ndata: {"speakerId":"u1"}\n\n'])
    mockFetchOk(stream)
    const session = fakeSession()
    await makeReceiver(session).run()
    expect(session.onSpeakerStart).toHaveBeenCalledWith('u1')
  })

  it('decodes opus base64 and forwards PCM to session.onSpeakerData', async () => {
    const opusFrame = Buffer.from('opus-bytes')
    const stream = streamFromChunks([
      `event: speaker-data\ndata: {"speakerId":"u1","opus":"${opusFrame.toString('base64')}"}\n\n`,
    ])
    mockFetchOk(stream)
    const session = fakeSession()
    await makeReceiver(session).run()
    expect(decodeMock).toHaveBeenCalledTimes(1)
    expect(session.onSpeakerData).toHaveBeenCalledWith('u1', expect.any(Buffer))
  })

  it('dispatches speaker-end to session.onSpeakerEnd', async () => {
    const stream = streamFromChunks(['event: speaker-end\ndata: {"speakerId":"u1"}\n\n'])
    mockFetchOk(stream)
    const session = fakeSession()
    await makeReceiver(session).run()
    expect(session.onSpeakerEnd).toHaveBeenCalledWith('u1')
  })

  it('handles multi-event chunks split across the buffer boundary', async () => {
    // First chunk has half of event 1; second chunk has rest + a full event 2.
    const stream = streamFromChunks([
      'event: speaker-start\ndata: {"speak',
      'erId":"u1"}\n\nevent: speaker-end\ndata: {"speakerId":"u1"}\n\n',
    ])
    mockFetchOk(stream)
    const session = fakeSession()
    await makeReceiver(session).run()
    expect(session.onSpeakerStart).toHaveBeenCalledWith('u1')
    expect(session.onSpeakerEnd).toHaveBeenCalledWith('u1')
  })

  it('aborts on session-end event', async () => {
    const stream = streamFromChunks([
      'event: speaker-start\ndata: {"speakerId":"u1"}\n\n',
      'event: session-end\ndata: {"reason":"host-stopped"}\n\n',
    ])
    mockFetchOk(stream)
    const session = fakeSession()
    const r = makeReceiver(session)
    await r.run()
    expect(session.onSpeakerStart).toHaveBeenCalledWith('u1')
  })

  it('survives a single bad event (logs warning, continues)', async () => {
    const stream = streamFromChunks([
      'event: speaker-data\ndata: {bad-json}\n\n',
      'event: speaker-start\ndata: {"speakerId":"u2"}\n\n',
    ])
    mockFetchOk(stream)
    const session = fakeSession()
    await makeReceiver(session).run()
    expect(session.onSpeakerStart).toHaveBeenCalledWith('u2')
  })

  it('ignores unknown event types', async () => {
    const stream = streamFromChunks([
      'event: unknown-future-event\ndata: {"x":1}\n\n',
      'event: speaker-start\ndata: {"speakerId":"u3"}\n\n',
    ])
    mockFetchOk(stream)
    const session = fakeSession()
    await makeReceiver(session).run()
    expect(session.onSpeakerStart).toHaveBeenCalledWith('u3')
  })
})

describe('VoiceReceiver — destroy', () => {
  it('aborts an in-flight subscription', async () => {
    // Stream that never closes naturally — destroy() must abort it.
    const stream = new ReadableStream<Uint8Array>({
      start() {
        /* no chunks, no close */
      },
    })
    mockFetchOk(stream)
    const r = makeReceiver(fakeSession())
    const runPromise = r.run()
    await new Promise((r) => setImmediate(r)) // let run() get into pump()
    await r.destroy()
    await expect(runPromise).resolves.toBeUndefined()
  })
})
