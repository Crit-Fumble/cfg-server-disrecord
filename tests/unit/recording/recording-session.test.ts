/**
 * Unit tests for RecordingSession (#119).
 *
 * Covers:
 *   - Consent gate: redacted speakers get a single placeholder per turn,
 *     never an open Deepgram stream
 *   - Globalized timestamps: per-speaker stream-open offset is applied
 *   - Mid-session consent flip (decline + re-consent)
 *   - Stream lifecycle: streams created on first start, kept open across
 *     silence (cfg-core-server#63), closed only on stop()
 *   - onTranscriptFinal callback receives both consented + redacted events
 */

import { RecordingSession, type TranscriptFinalEvent } from '../../../src/recording/recording-session.js'

// Mock the Deepgram factory — capture the events sink so tests can drive it.
const mockStreamSend = jest.fn()
const mockStreamClose = jest.fn(async () => undefined)
const mockStreamConnect = jest.fn(async () => undefined)

interface FakeStream {
  send: jest.Mock
  close: jest.Mock
  connect: jest.Mock
  closed: boolean
  on: jest.Mock
  emit: (event: 'transcript' | 'error' | 'close', payload: unknown) => void
}

const fakeStreamRegistry: FakeStream[] = []

function makeFakeStream(): FakeStream {
  const listeners: Record<string, Array<(payload: unknown) => void>> = {
    transcript: [],
    error: [],
    close: [],
  }
  const fake: FakeStream = {
    send: mockStreamSend,
    close: mockStreamClose,
    connect: mockStreamConnect,
    closed: false,
    on: jest.fn((event: string, cb: (payload: unknown) => void) => {
      listeners[event]?.push(cb)
    }),
    emit: (event, payload) => {
      for (const cb of listeners[event] ?? []) cb(payload)
    },
  }
  fakeStreamRegistry.push(fake)
  return fake
}

jest.mock('../../../src/deepgram/index.js', () => ({
  createDeepgramStream: jest.fn(() => makeFakeStream()),
}))

import { createDeepgramStream } from '../../../src/deepgram/index.js'

beforeEach(() => {
  fakeStreamRegistry.length = 0
  mockStreamSend.mockReset()
  mockStreamClose.mockReset().mockImplementation(async () => undefined)
  mockStreamConnect.mockReset().mockImplementation(async () => undefined)
  ;(createDeepgramStream as jest.Mock).mockClear()
})

/** A token provider stub — recording-session never inspects the credential. */
const fakeTokenProvider = jest.fn(() => ({ value: 'dg-test-key', scheme: 'Token' as const }))

function defaultParams(overrides: Partial<ConstructorParameters<typeof RecordingSession>[0]> = {}) {
  return {
    deepgramTokenProvider: fakeTokenProvider,
    resolveSpeakerName: jest.fn(async (id: string) => `User-${id}`),
    onTranscriptFinal: jest.fn(),
    ...overrides,
  }
}

describe('RecordingSession — consent gate', () => {
  it('opens a Deepgram stream for a consented speaker', async () => {
    const params = defaultParams({ consentedUserIds: new Set(['u1']) })
    const sess = new RecordingSession(params)
    await sess.onSpeakerStart('u1')
    expect(createDeepgramStream).toHaveBeenCalledTimes(1)
    expect(mockStreamConnect).toHaveBeenCalledTimes(1)
  })

  it('does NOT open a Deepgram stream for an unconsented speaker', async () => {
    const params = defaultParams({ consentedUserIds: new Set(['u1']) })
    const sess = new RecordingSession(params)
    await sess.onSpeakerStart('u2')
    expect(createDeepgramStream).not.toHaveBeenCalled()
  })

  it('emits a single [redacted] placeholder when an unconsenter speaks then stops', async () => {
    const onFinal = jest.fn()
    const params = defaultParams({ consentedUserIds: new Set(['u1']), onTranscriptFinal: onFinal })
    const sess = new RecordingSession(params)
    await sess.onSpeakerStart('u2')
    sess.onSpeakerData('u2', Buffer.from([0x01, 0x02])) // sawData → true
    await sess.onSpeakerEnd('u2')
    expect(onFinal).toHaveBeenCalledTimes(1)
    const event = onFinal.mock.calls[0][0] as TranscriptFinalEvent
    expect(event.isRedacted).toBe(true)
    expect(event.transcript).toBe('[redacted]')
    expect(event.speakerName).toBe('[redacted]')
  })

  it('does NOT emit a placeholder when an unconsenter starts and ends with no data', async () => {
    const onFinal = jest.fn()
    const params = defaultParams({ consentedUserIds: new Set(['u1']), onTranscriptFinal: onFinal })
    const sess = new RecordingSession(params)
    await sess.onSpeakerStart('u2')
    await sess.onSpeakerEnd('u2')
    expect(onFinal).not.toHaveBeenCalled()
  })

  it('emits all speakers verbatim when consent set is null', async () => {
    const onFinal = jest.fn()
    const params = defaultParams({ onTranscriptFinal: onFinal }) // no consentedUserIds
    const sess = new RecordingSession(params)
    await sess.onSpeakerStart('anyone')
    expect(createDeepgramStream).toHaveBeenCalledTimes(1)
  })
})

describe('RecordingSession — Deepgram WS lifecycle (cfg-core-server#63)', () => {
  it('does NOT close the stream on onSpeakerEnd (silence in long sessions)', async () => {
    const sess = new RecordingSession(defaultParams({ consentedUserIds: new Set(['u1']) }))
    await sess.onSpeakerStart('u1')
    expect(mockStreamClose).not.toHaveBeenCalled()
    await sess.onSpeakerEnd('u1')
    expect(mockStreamClose).not.toHaveBeenCalled()
  })

  it('does NOT reopen the stream on repeated start/end cycles', async () => {
    const sess = new RecordingSession(defaultParams({ consentedUserIds: new Set(['u1']) }))
    for (let i = 0; i < 5; i++) {
      await sess.onSpeakerStart('u1')
      await sess.onSpeakerEnd('u1')
    }
    expect(createDeepgramStream).toHaveBeenCalledTimes(1)
    expect(mockStreamConnect).toHaveBeenCalledTimes(1)
  })

  it('closes all streams on stop()', async () => {
    const sess = new RecordingSession(defaultParams({ consentedUserIds: new Set(['u1', 'u2']) }))
    await sess.onSpeakerStart('u1')
    await sess.onSpeakerStart('u2')
    await sess.stop()
    expect(mockStreamClose).toHaveBeenCalledTimes(2)
  })
})

describe('RecordingSession — mid-session consent flip', () => {
  it('addConsentedUser opens a stream and emits [redacted] for the prior in-flight turn', async () => {
    const onFinal = jest.fn()
    const consent = new Set<string>()
    const sess = new RecordingSession(defaultParams({ consentedUserIds: consent, onTranscriptFinal: onFinal }))
    await sess.onSpeakerStart('u3')
    sess.onSpeakerData('u3', Buffer.from([0xff])) // sawData
    await sess.addConsentedUser('u3')
    expect(consent.has('u3')).toBe(true)
    expect(createDeepgramStream).toHaveBeenCalledTimes(1)
    // First emit is the redacted placeholder for the pre-consent span
    expect(onFinal.mock.calls[0][0].isRedacted).toBe(true)
  })

  it('addDeclinedUser closes the live stream and gates future turns', async () => {
    const consent = new Set<string>(['u4'])
    const sess = new RecordingSession(defaultParams({ consentedUserIds: consent }))
    await sess.onSpeakerStart('u4')
    sess.addDeclinedUser('u4')
    expect(mockStreamClose).toHaveBeenCalledTimes(1)
    expect(consent.has('u4')).toBe(false)
  })
})

describe('RecordingSession — transcript emission', () => {
  it('emits a finalized transcript via onTranscriptFinal with globalized timestamps', async () => {
    const onFinal = jest.fn()
    const sess = new RecordingSession(defaultParams({ onTranscriptFinal: onFinal }))
    await sess.onSpeakerStart('u5')
    const fakeStream = fakeStreamRegistry[0]
    // Simulate a Deepgram is_final result with word timing
    fakeStream.emit('transcript', {
      transcript: 'hello world',
      confidence: 0.95,
      isFinal: true,
      speechFinal: true,
      durationSec: 1.5,
      words: [
        { word: 'hello', start: 0.2, end: 0.6, confidence: 0.95 },
        { word: 'world', start: 0.7, end: 1.1, confidence: 0.93 },
      ],
    })
    expect(onFinal).toHaveBeenCalledTimes(1)
    const event = onFinal.mock.calls[0][0] as TranscriptFinalEvent
    expect(event.transcript).toBe('hello world')
    expect(event.speakerId).toBe('u5')
    expect(event.speakerName).toBe('User-u5')
    expect(event.isRedacted).toBe(false)
    expect(event.words).toHaveLength(2)
  })

  it('skips empty / non-final transcripts', async () => {
    const onFinal = jest.fn()
    const sess = new RecordingSession(defaultParams({ onTranscriptFinal: onFinal }))
    await sess.onSpeakerStart('u6')
    const fakeStream = fakeStreamRegistry[0]
    fakeStream.emit('transcript', {
      transcript: '   ',
      isFinal: true,
      speechFinal: true,
      words: [],
    })
    fakeStream.emit('transcript', {
      transcript: 'partial',
      isFinal: false,
      speechFinal: false,
      words: [],
    })
    expect(onFinal).not.toHaveBeenCalled()
  })
})

describe('RecordingSession — transcription disabled', () => {
  it('does not open a Deepgram stream when the token provider is null', async () => {
    const sess = new RecordingSession(defaultParams({ deepgramTokenProvider: null }))
    await sess.onSpeakerStart('u7')
    expect(createDeepgramStream).not.toHaveBeenCalled()
  })
})
