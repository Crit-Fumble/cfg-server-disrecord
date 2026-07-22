/**
 * Thread captions coalesce consecutive finals into a paragraph (#11).
 *
 * Edit-in-place already solved interim → final WITHIN one utterance, but
 * nothing coalesced final → final. A monologue segmented into 30 finals became
 * 30 thread messages — past Discord's ~5-per-5s ceiling, where 429s start
 * dropping lines silently, and a wall of one-liners in the artifact people
 * scroll back through.
 *
 * A paragraph stays open for a speaker and closes on: another speaker posting,
 * a long silence, or approaching the 2000-char cap.
 *
 * VTT/caption timing is deliberately NOT under test here — it must remain
 * per-utterance, and lives on a separate path (`captions[]` / postTranscript).
 */

jest.mock('../../../src/gateway/voice-capture.js', () => ({
  VoiceCapture: jest.fn().mockImplementation(() => ({
    join: jest.fn(async () => undefined),
    leave: jest.fn(),
  })),
}))

jest.mock('../../../src/recording/pcm-capture.js', () => ({
  PcmCapture: jest.fn().mockImplementation(() => ({
    onSessionStop: jest.fn(async () => undefined),
    getResult: jest.fn(() => null),
    speakerCount: 0,
    setPaused: jest.fn(),
  })),
}))

jest.mock('../../../src/recording/recording-session.js', () => ({
  RecordingSession: jest.fn().mockImplementation(() => ({
    addConsentedUser: jest.fn(),
    addDeclinedUser: jest.fn(),
    stop: jest.fn(async () => undefined),
    setPaused: jest.fn(),
  })),
}))

jest.mock('../../../src/deepgram/index.js', () => ({
  buildDeepgramTokenProvider: jest.fn(() => null),
}))

jest.mock('../../../src/discord/speaker-webhook.js', () => ({
  SpeakerWebhookManager: jest.fn().mockImplementation(() => ({
    init: jest.fn(async () => undefined),
    cleanup: jest.fn(async () => undefined),
  })),
}))

jest.mock('../../../src/discord/thread-poster.js', () => ({
  createRecordingThread: jest.fn(async () => 'thread-123'),
  postRecording: jest.fn(async () => undefined),
  tempDirOf: jest.fn(() => '/tmp'),
}))

import {
  SessionController,
  type SessionControllerParams,
} from '../../../src/recording/session-controller.js'

const silentLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as never

function baseParams(): SessionControllerParams {
  return {
    recordingId: 'rec-1',
    client: {
      on: jest.fn(),
      off: jest.fn(),
      user: { id: 'bot-self' },
      channels: {
        fetch: jest.fn(async () => ({
          isSendable: () => true,
          send: jest.fn(async () => ({ id: 'msg-1' })),
        })),
      },
    } as never,
    guildId: 'guild-1',
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    transcription: true,
    deepgramMode: 'disabled',
    deepgramKey: null,
    deepgramModel: 'nova-3',
    deepgramLanguage: 'en',
    chunkMinutes: 0,
    sink: {} as never,
    cfg: undefined,
    core: {
      fetchSessionPolicy: jest.fn(async () => ({ consentedUserIds: [], speakerNames: {} })),
      postTranscript: jest.fn(),
      postBillingTick: jest.fn(async () => ({ insufficientCoins: false })),
      postRecordingThread: jest.fn(async () => undefined),
    } as never,
    logger: silentLogger,
  }
}

interface Privates {
  postFinalCaption(event: unknown): void
  postCaption(speakerId: string, speakerName: string, content: string): Promise<string | null>
  editCaption(speakerId: string, messageId: string, content: string): Promise<void>
  threadId: string | null
  speakerOpQueue: Map<string, Promise<void>>
}
const priv = (c: SessionController) => c as unknown as Privates

function finalEvent(speakerId: string, transcript: string, speakerName = 'GM') {
  return { speakerId, speakerName, transcript, isRedacted: false, startSec: 0, endSec: 1, words: [] }
}

/** Let every queued per-speaker op settle. */
async function drain(c: SessionController): Promise<void> {
  await Promise.all(Array.from(priv(c).speakerOpQueue.values()))
  await Promise.resolve()
}

async function makeController(): Promise<{
  controller: SessionController
  posts: string[]
  edits: Array<{ id: string; content: string }>
}> {
  const controller = new SessionController(baseParams())
  await controller.start()
  priv(controller).threadId = 'thread-123'

  const posts: string[] = []
  const edits: Array<{ id: string; content: string }> = []
  let n = 0

  jest.spyOn(priv(controller), 'postCaption').mockImplementation(async (_s, _n2, content) => {
    posts.push(content)
    return `msg-${++n}`
  })
  jest.spyOn(priv(controller), 'editCaption').mockImplementation(async (_s, id, content) => {
    edits.push({ id, content })
  })

  return { controller, posts, edits }
}

beforeEach(() => jest.clearAllMocks())
afterEach(() => jest.restoreAllMocks())

describe('consecutive finals from one speaker', () => {
  it('post ONE message and edit it, not one message per final', async () => {
    const { controller, posts, edits } = await makeController()

    for (let i = 1; i <= 30; i++) {
      priv(controller).postFinalCaption(finalEvent('gm', `sentence ${i}.`))
      await drain(controller)
    }

    expect(posts).toHaveLength(1)
    expect(edits).toHaveLength(29)
  })

  it('accumulate the text rather than replacing it', async () => {
    const { controller, edits } = await makeController()

    priv(controller).postFinalCaption(finalEvent('gm', 'The door creaks open.'))
    await drain(controller)
    priv(controller).postFinalCaption(finalEvent('gm', 'Inside, torchlight flickers.'))
    await drain(controller)

    expect(edits.at(-1)?.content).toBe('The door creaks open. Inside, torchlight flickers.')
  })
})

describe('paragraph close conditions', () => {
  it('another speaker posting closes the paragraph', async () => {
    const { controller, posts } = await makeController()

    priv(controller).postFinalCaption(finalEvent('gm', 'You enter the hall.'))
    await drain(controller)
    priv(controller).postFinalCaption(finalEvent('player', 'I draw my sword.', 'Player'))
    await drain(controller)
    // The GM speaking again must NOT append to a message that is no longer
    // last in the thread — that would render text out of order.
    priv(controller).postFinalCaption(finalEvent('gm', 'Roll initiative.'))
    await drain(controller)

    expect(posts).toEqual(['You enter the hall.', 'I draw my sword.', 'Roll initiative.'])
  })

  it('approaching the 2000-char cap starts a new message', async () => {
    const { controller, posts } = await makeController()
    const chunk = 'x'.repeat(300)

    for (let i = 0; i < 10; i++) {
      priv(controller).postFinalCaption(finalEvent('gm', chunk))
      await drain(controller)
    }

    expect(posts.length).toBeGreaterThan(1)
    // No message may exceed Discord's hard limit.
    for (const p of posts) expect(p.length).toBeLessThan(2000)
  })

  it('a long silence starts a new paragraph', async () => {
    jest.useFakeTimers()
    try {
      const { controller, posts } = await makeController()

      priv(controller).postFinalCaption(finalEvent('gm', 'We break for snacks.'))
      await drain(controller)

      jest.advanceTimersByTime(120_000)

      priv(controller).postFinalCaption(finalEvent('gm', 'Back to the dungeon.'))
      await drain(controller)

      expect(posts).toEqual(['We break for snacks.', 'Back to the dungeon.'])
    } finally {
      jest.useRealTimers()
    }
  })
})
