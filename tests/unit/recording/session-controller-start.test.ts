/**
 * Unit tests for SessionController.start() — issue #5 fixes (revised).
 *
 * The recording hot path. start() must satisfy three constraints at once:
 *
 *   (a) CAPTURE STARTS ASAP — voice.join() (the ONLY thing that establishes the
 *       VoiceConnection + audio receiver; @discordjs/voice has no pre-buffer)
 *       must NOT be delayed behind thread creation. Delaying it permanently
 *       drops the opening audio, including the auto-consented host's
 *       session-start narration. So voice.join() runs BEFORE createRecordingThread.
 *
 *   (b) NO PARENT-CHANNEL CONSENT LEAK — because the voice listeners go live
 *       (via join()) BEFORE the thread id is wired, a consent prompt could fire
 *       with threadId still null. Rather than leak to the parent channel, the
 *       manager QUEUES the prompt (signalled by expectThread()) and flushes it
 *       INTO the thread once setThreadId() resolves. The genuine no-thread case
 *       (creation failed) still falls back to the parent channel.
 *
 *   (c) BACK-TO-TOP / consent surface NOT gated on invokerUserId — auto-started
 *       sessions have no invoker, so the announcement (firstThreadMessageId
 *       anchor + in-thread consent buttons) must post whenever a thread exists,
 *       regardless of invoker.
 *
 * The heavy collaborators (Deepgram, voice/opus, pcm, webhooks, thread poster)
 * are mocked at the module boundary so the test exercises ONLY start()'s
 * orchestration ordering — the unit under test.
 */

// ── Collaborator module mocks ───────────────────────────────────────────────
// A shared call-order log lets us assert relative ordering of the operations
// that matter: voice.join vs. createRecordingThread vs. setThreadId.
const callOrder: string[] = []

const mockVoiceJoin = jest.fn(async () => {
  callOrder.push('voice.join')
})
jest.mock('../../../src/gateway/voice-capture.js', () => ({
  VoiceCapture: jest.fn().mockImplementation(() => ({
    join: mockVoiceJoin,
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

// createRecordingThread returns our fake thread id. postRecording/tempDirOf
// aren't reached by start().
const mockCreateThread = jest.fn(async () => {
  callOrder.push('createRecordingThread')
  return 'thread-123'
})
jest.mock('../../../src/discord/thread-poster.js', () => ({
  createRecordingThread: (...args: unknown[]) => mockCreateThread(...args),
  postRecording: jest.fn(async () => undefined),
  tempDirOf: jest.fn(() => '/tmp'),
}))

import { SessionController, type SessionControllerParams } from '../../../src/recording/session-controller.js'
import { ConsentManager } from '../../../src/consent/consent-manager.js'
import type { CoreServerClient } from '../../../src/phone-home/core-client.js'

const silentLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as never

/** A Discord client stub with just enough surface for start(). */
function fakeClient(voiceMemberIds: string[]) {
  return {
    on: jest.fn(),
    off: jest.fn(),
    user: { id: 'bot-self' },
    channels: {
      fetch: jest.fn(async (id: string) => {
        // voiceChannelId lookup → a voice-based channel with members.
        if (id === 'vc-1') {
          const members = new Map<string, unknown>()
          for (const m of voiceMemberIds) members.set(m, {})
          members.set('bot-self', {})
          return {
            isVoiceBased: () => true,
            name: 'Table 1',
            members,
          }
        }
        return null
      }),
    },
  } as never
}

/** A no-op phone-home core client (self-host shape). */
function fakeCore(): CoreServerClient {
  return {
    fetchSessionPolicy: jest.fn(async () => ({ consentedUserIds: [], speakerNames: {} })),
    postTranscript: jest.fn(),
    postBillingTick: jest.fn(),
  } as never
}

function baseParams(overrides: Partial<SessionControllerParams> = {}): SessionControllerParams {
  return {
    recordingId: 'rec-1',
    client: fakeClient(['u-speaker', 'u-listener']),
    guildId: 'guild-1',
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    transcription: true,
    deepgramMode: 'disabled',
    deepgramKey: null,
    deepgramModel: 'nova-3',
    deepgramLanguage: 'en',
    sink: {} as never,
    core: fakeCore(),
    logger: silentLogger,
    ...overrides,
  }
}

beforeEach(() => {
  callOrder.length = 0
  jest.clearAllMocks()
  // jest.clearAllMocks() resets the createThread impl back to undefined for
  // the one test that uses mockResolvedValueOnce; restore the default here.
  mockCreateThread.mockImplementation(async () => {
    callOrder.push('createRecordingThread')
    return 'thread-123'
  })
  mockVoiceJoin.mockImplementation(async () => {
    callOrder.push('voice.join')
  })
})

describe('SessionController.start() — issue #5 (revised)', () => {
  // ── (a) capture isn't delayed by thread creation ──────────────────────────
  it('runs voice.join() BEFORE createRecordingThread (capture starts ASAP, not behind thread creation)', async () => {
    const controller = new SessionController(baseParams())
    await controller.start()

    const joinIdx = callOrder.indexOf('voice.join')
    const threadIdx = callOrder.indexOf('createRecordingThread')
    expect(joinIdx).toBeGreaterThanOrEqual(0)
    expect(threadIdx).toBeGreaterThanOrEqual(0)
    // The whole point of the revision: the audio receiver is live before we
    // spend ~4 Discord round-trips creating the thread, so the opening audio
    // (incl. the auto-consented host's narration) isn't dropped.
    expect(joinIdx).toBeLessThan(threadIdx)
  })

  it('signals expectThread() BEFORE voice.join() so an early prompt is queued, not leaked', async () => {
    const expectThreadSpy = jest
      .spyOn(ConsentManager.prototype, 'expectThread')
      .mockImplementation(function (this: ConsentManager) {
        callOrder.push('expectThread')
        ;(this as unknown as { threadExpected: boolean }).threadExpected = true
      })

    const controller = new SessionController(baseParams())
    await controller.start()

    const expectIdx = callOrder.indexOf('expectThread')
    const joinIdx = callOrder.indexOf('voice.join')
    expect(expectIdx).toBeGreaterThanOrEqual(0)
    // expectThread must be set before the voice listeners go live, otherwise a
    // prompt firing the instant join() registers them would still leak.
    expect(expectIdx).toBeLessThan(joinIdx)

    expectThreadSpy.mockRestore()
  })

  it('wires setThreadId() AFTER createRecordingThread resolves (flushing the queue into the thread)', async () => {
    const origSetThreadId = ConsentManager.prototype.setThreadId
    const setThreadIdSpy = jest
      .spyOn(ConsentManager.prototype, 'setThreadId')
      .mockImplementation(function (this: ConsentManager, id: string | null) {
        callOrder.push('setThreadId')
        return origSetThreadId.call(this, id)
      })

    const controller = new SessionController(baseParams())
    await controller.start()

    const threadIdx = callOrder.indexOf('createRecordingThread')
    const setIdx = callOrder.indexOf('setThreadId')
    expect(setIdx).toBeGreaterThan(threadIdx)

    setThreadIdSpy.mockRestore()
  })

  // ── (b) Back-to-Top anchor without an invoker ─────────────────────────────
  it('sets the Back-to-Top anchor (firstThreadMessageId) even with NO invoker (auto-started session)', async () => {
    const postSessionStartSpy = jest
      .spyOn(ConsentManager.prototype, 'postSessionStart')
      .mockResolvedValue('start-msg-1')

    // No invokerUserId — the auto-start case from issue #5.
    const controller = new SessionController(baseParams({ invokerUserId: undefined }))
    await controller.start()

    // The announcement was posted despite no invoker...
    expect(postSessionStartSpy).toHaveBeenCalledTimes(1)
    const [invokerArg, threadArg] = postSessionStartSpy.mock.calls[0]
    expect(invokerArg).toBeNull()
    expect(threadArg).toBe('thread-123')

    // ...and the Back-to-Top anchor was captured from its return value.
    expect(
      (controller as unknown as { firstThreadMessageId: string | null }).firstThreadMessageId,
    ).toBe('start-msg-1')

    postSessionStartSpy.mockRestore()
  })

  it('passes the voice members as the announcement mention list when there is no invoker', async () => {
    const postSessionStartSpy = jest
      .spyOn(ConsentManager.prototype, 'postSessionStart')
      .mockResolvedValue('start-msg-1')

    const controller = new SessionController(baseParams({ invokerUserId: undefined }))
    await controller.start()

    const [, , , memberArg] = postSessionStartSpy.mock.calls[0]
    expect(memberArg).toEqual(expect.arrayContaining(['u-speaker', 'u-listener']))

    postSessionStartSpy.mockRestore()
  })

  it('still posts the announcement (and sets the anchor) WITH an invoker (manual start)', async () => {
    const postSessionStartSpy = jest
      .spyOn(ConsentManager.prototype, 'postSessionStart')
      .mockResolvedValue('start-msg-2')

    const controller = new SessionController(baseParams({ invokerUserId: 'u-invoker' }))
    await controller.start()

    expect(postSessionStartSpy).toHaveBeenCalledTimes(1)
    expect(postSessionStartSpy.mock.calls[0][0]).toBe('u-invoker')
    expect(
      (controller as unknown as { firstThreadMessageId: string | null }).firstThreadMessageId,
    ).toBe('start-msg-2')

    postSessionStartSpy.mockRestore()
  })

  it('does NOT post the announcement when thread creation failed (null thread)', async () => {
    mockCreateThread.mockResolvedValueOnce(null as never)
    const postSessionStartSpy = jest
      .spyOn(ConsentManager.prototype, 'postSessionStart')
      .mockResolvedValue('start-msg-3')

    const controller = new SessionController(baseParams({ invokerUserId: 'u-invoker' }))
    await controller.start()

    // No thread ⇒ no in-thread announcement (deliver() refuses the parent
    // channel for privacy; an announcement there would be the same leak).
    expect(postSessionStartSpy).not.toHaveBeenCalled()
    expect(
      (controller as unknown as { firstThreadMessageId: string | null }).firstThreadMessageId,
    ).toBeNull()

    postSessionStartSpy.mockRestore()
  })

  // ── join-failure hardening (MEDIUM) ───────────────────────────────────────
  it('aborts cleanly when voice.join() throws — no thread created, no announcement, consent listener detached', async () => {
    mockVoiceJoin.mockImplementationOnce(async () => {
      callOrder.push('voice.join')
      throw new Error('voice connection never reached Ready')
    })
    const postSessionStartSpy = jest
      .spyOn(ConsentManager.prototype, 'postSessionStart')
      .mockResolvedValue('start-msg')
    const consentStopSpy = jest.spyOn(ConsentManager.prototype, 'stop')

    const controller = new SessionController(baseParams({ invokerUserId: 'u-invoker' }))
    await expect(controller.start()).rejects.toThrow('voice connection never reached Ready')

    // join() runs BEFORE thread creation, so a join failure leaves NO orphaned
    // thread + posted "click to consent" announcement.
    expect(mockCreateThread).not.toHaveBeenCalled()
    expect(postSessionStartSpy).not.toHaveBeenCalled()
    // The consent manager's interactionCreate listener is detached on abort —
    // the controller is never committed to the registry, so runStop() (which
    // would otherwise call consent.stop()) never runs.
    expect(consentStopSpy).toHaveBeenCalledTimes(1)

    postSessionStartSpy.mockRestore()
    consentStopSpy.mockRestore()
  })
})

// ── Consent manager: thread-gated queue / flush ──────────────────────────────
describe('ConsentManager — thread-gated consent (no parent leak)', () => {
  /**
   * A client stub that records which channel each consent prompt was sent to,
   * and supports the thread path (add member + send) used by tryPostToThread.
   */
  function trackingClient() {
    const sends: Array<{ channelId: string; content: string }> = []
    const client = {
      on: jest.fn(),
      off: jest.fn(),
      channels: {
        fetch: jest.fn(async (id: string) => {
          const isThread = id.startsWith('thread-')
          return {
            id,
            isThread: () => isThread,
            isSendable: () => true,
            members: { add: jest.fn(async () => undefined) },
            send: jest.fn(async (msg: { content: string }) => {
              sends.push({ channelId: id, content: msg.content })
              return { id: `msg-${sends.length}` }
            }),
          }
        }),
      },
    } as never
    return { client, sends }
  }

  function makeManager(client: never) {
    return new ConsentManager({
      recordingId: 'rec-1',
      buttonKey: 'rec-1',
      client,
      textChannelId: 'tc-parent',
      logger: silentLogger,
    })
  }

  it('QUEUES a prompt that fires after expectThread() but before setThreadId() — nothing posted to the parent', async () => {
    const { client, sends } = trackingClient()
    const mgr = makeManager(client)

    mgr.expectThread()
    // A speaker fires in the thread-creation window.
    mgr.noteSpeaker('u-early')
    // Let any (incorrect) async send flush.
    await new Promise((r) => setImmediate(r))

    // Nothing was posted anywhere — the prompt is queued, NOT leaked to parent.
    expect(sends).toHaveLength(0)
  })

  it('FLUSHES the queued prompt INTO the thread once setThreadId(threadId) runs', async () => {
    const { client, sends } = trackingClient()
    const mgr = makeManager(client)

    mgr.expectThread()
    mgr.noteSpeaker('u-early')
    await new Promise((r) => setImmediate(r))
    expect(sends).toHaveLength(0)

    mgr.setThreadId('thread-abc')
    await new Promise((r) => setImmediate(r))

    // The queued prompt now posts INTO the thread, never the parent channel.
    expect(sends).toHaveLength(1)
    expect(sends[0].channelId).toBe('thread-abc')
    expect(sends[0].content).toContain('<@u-early>')
  })

  it('genuine no-thread fallback: setThreadId(null) flushes the queued prompt to the PARENT channel', async () => {
    const { client, sends } = trackingClient()
    const mgr = makeManager(client)

    mgr.expectThread()
    mgr.noteSpeaker('u-early')
    await new Promise((r) => setImmediate(r))
    expect(sends).toHaveLength(0)

    // Thread creation failed → setThreadId(null). The window is over, so the
    // queued prompt takes the genuine no-thread fallback: the parent channel.
    mgr.setThreadId(null)
    await new Promise((r) => setImmediate(r))

    expect(sends).toHaveLength(1)
    expect(sends[0].channelId).toBe('tc-parent')
    expect(sends[0].content).toContain('<@u-early>')
  })

  it('NO expectThread + null thread ⇒ classic parent-channel fallback (a session that truly has no thread)', async () => {
    const { client, sends } = trackingClient()
    const mgr = makeManager(client)

    // expectThread() is never called — this session has no thread at all.
    mgr.noteSpeaker('u-walkin')
    await new Promise((r) => setImmediate(r))

    // Posts straight to the parent channel, as before — no queueing.
    expect(sends).toHaveLength(1)
    expect(sends[0].channelId).toBe('tc-parent')
  })

  it('after the thread is set, a NEW late-joiner prompt posts directly into the thread (no queue)', async () => {
    const { client, sends } = trackingClient()
    const mgr = makeManager(client)

    mgr.expectThread()
    mgr.setThreadId('thread-xyz')
    await new Promise((r) => setImmediate(r))
    expect(sends).toHaveLength(0) // nothing was queued

    // A genuine late joiner speaks AFTER the thread is wired.
    mgr.noteSpeaker('u-late')
    await new Promise((r) => setImmediate(r))

    expect(sends).toHaveLength(1)
    expect(sends[0].channelId).toBe('thread-xyz')
    expect(sends[0].content).toContain('<@u-late>')
  })
})

describe('ConsentManager.postSessionStart — invoker-independent (issue #5)', () => {
  function consentClient(threadSendId: string) {
    const sent: Array<{ content: string }> = []
    const client = {
      on: jest.fn(),
      off: jest.fn(),
      channels: {
        fetch: jest.fn(async () => ({
          isSendable: () => true,
          send: jest.fn(async (msg: { content: string }) => {
            sent.push(msg)
            return { id: threadSendId }
          }),
        })),
      },
    } as never
    return { client, sent }
  }

  it('returns the message id (the Back-to-Top anchor) with a null invoker', async () => {
    const { client } = consentClient('msg-xyz')
    const mgr = new ConsentManager({
      recordingId: 'rec-1',
      buttonKey: 'rec-1',
      client,
      textChannelId: 'tc-1',
      logger: silentLogger,
    })
    const id = await mgr.postSessionStart(null, 'thread-1', true, ['m1', 'm2'])
    expect(id).toBe('msg-xyz')
  })

  it('mentions the voice members even when invoker is null', async () => {
    const { client, sent } = consentClient('msg-xyz')
    const mgr = new ConsentManager({
      recordingId: 'rec-1',
      buttonKey: 'rec-1',
      client,
      textChannelId: 'tc-1',
      logger: silentLogger,
    })
    await mgr.postSessionStart(null, 'thread-1', false, ['m1', 'm2'])
    expect(sent[0].content).toContain('<@m1>')
    expect(sent[0].content).toContain('<@m2>')
  })

  it('produces a grammatical announcement with neither invoker nor members', async () => {
    const { client, sent } = consentClient('msg-xyz')
    const mgr = new ConsentManager({
      recordingId: 'rec-1',
      buttonKey: 'rec-1',
      client,
      textChannelId: 'tc-1',
      logger: silentLogger,
    })
    await mgr.postSessionStart(null, 'thread-1', false, [])
    // No dangling "<@undefined>" or leading "A starting".
    expect(sent[0].content).not.toContain('undefined')
    expect(sent[0].content.startsWith('Starting a')).toBe(true)
  })
})
