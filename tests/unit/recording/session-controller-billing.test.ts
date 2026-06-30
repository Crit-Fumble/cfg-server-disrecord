/**
 * Unit tests for SessionController's #120 mid-session insufficient-Crit-Coin
 * graceful stop (worker side).
 *
 * Contract under test (worker side of LOCKED #120):
 *   - postBillingTicks AWAITS the `server_uptime` tick; a 402
 *     (insufficientCoins:true) triggers handleInsufficientCoins().
 *   - the `transcription` surcharge tick is fire-and-forget and NEVER drives
 *     the stop (only the unified server-uptime axis is the dunning signal).
 *   - handleInsufficientCoins() is guarded by a once-flag: exactly ONE
 *     "out of Crit-Coin" channel message and exactly ONE stop(), even though
 *     stop()'s own final tick would 402 again.
 *   - a 500 / network error is a best-effort no-op: NO message, NO stop
 *     (a flaky meter must never tear down an in-progress recording).
 *
 * Collaborators are mocked at the module boundary so the test exercises only
 * the controller's billing→stop orchestration.
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

import { SessionController, type SessionControllerParams } from '../../../src/recording/session-controller.js'
import type { CfgHostedConfig } from '../../../src/config.js'

const silentLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as never

const HOSTED: CfgHostedConfig = {
  coreServerUrl: 'http://core:3001',
  coreServerToken: 'jwt-token',
  installationId: 'inst-1',
  userId: 'user-1',
  ctPerMinute: 13,
  size: 'small',
}

/** A Discord client stub — channels.fetch returns a sendable channel. */
function fakeClient() {
  return {
    on: jest.fn(),
    off: jest.fn(),
    user: { id: 'bot-self' },
    channels: {
      fetch: jest.fn(async () => ({
        isSendable: () => true,
        send: jest.fn(async () => ({ id: 'msg-1' })),
      })),
    },
  } as never
}

/** A phone-home core client whose postBillingTick result we control per-test. */
function makeCore(insufficientByType: Partial<Record<'server_uptime' | 'transcription', boolean>>) {
  const postBillingTick = jest.fn(async (payload: { resourceType: 'server_uptime' | 'transcription' }) => ({
    insufficientCoins: insufficientByType[payload.resourceType] ?? false,
  }))
  return {
    fetchSessionPolicy: jest.fn(async () => ({ consentedUserIds: [], speakerNames: {} })),
    postTranscript: jest.fn(),
    postBillingTick,
  } as never
}

function baseParams(core: never, cfg: CfgHostedConfig | undefined): SessionControllerParams {
  return {
    recordingId: 'rec-1',
    client: fakeClient(),
    guildId: 'guild-1',
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    transcription: true,
    deepgramMode: 'disabled',
    deepgramKey: null,
    deepgramModel: 'nova-3',
    deepgramLanguage: 'en',
    sink: {} as never,
    cfg,
    core,
    logger: silentLogger,
  }
}

/** Reach into the controller's private surface for the unit-level drive. */
type Privates = {
  postBillingTicks(minutes: number, final: boolean): Promise<void>
  postBotMessage(content: string): Promise<string | null>
  threadId: string | null
  insufficientStopFired: boolean
}
function priv(c: SessionController): Privates {
  return c as unknown as Privates
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('SessionController #120 — insufficient-Crit-Coin graceful stop', () => {
  it('402 on server_uptime → exactly one stop() + exactly one channel message', async () => {
    const core = makeCore({ server_uptime: true })
    const controller = new SessionController(baseParams(core, HOSTED))
    // Wire a thread so the user-facing message has somewhere to land.
    priv(controller).threadId = 'thread-123'
    const stopSpy = jest.spyOn(controller, 'stop').mockResolvedValue(undefined)
    const postBotSpy = jest.spyOn(priv(controller), 'postBotMessage')

    await priv(controller).postBillingTicks(15, false)

    expect(stopSpy).toHaveBeenCalledTimes(1)
    expect(postBotSpy).toHaveBeenCalledTimes(1)
    expect(postBotSpy).toHaveBeenCalledWith('Out of Crit-Coin — recording ended.')
    expect(priv(controller).insufficientStopFired).toBe(true)
  })

  it('the once-flag prevents a double-fire across two 402 ticks', async () => {
    const core = makeCore({ server_uptime: true })
    const controller = new SessionController(baseParams(core, HOSTED))
    priv(controller).threadId = 'thread-123'
    const stopSpy = jest.spyOn(controller, 'stop').mockResolvedValue(undefined)
    const postBotSpy = jest.spyOn(priv(controller), 'postBotMessage')

    // First 402: the periodic tick. Second 402: e.g. the in-flight stop's
    // own final tick. The once-flag must collapse these to a single stop +
    // single message.
    await priv(controller).postBillingTicks(15, false)
    await priv(controller).postBillingTicks(1, true)

    expect(stopSpy).toHaveBeenCalledTimes(1)
    expect(postBotSpy).toHaveBeenCalledTimes(1)
  })

  it('a 500/transient (insufficientCoins:false) does NOT stop and does NOT message', async () => {
    const core = makeCore({}) // every tick resolves insufficientCoins:false
    const controller = new SessionController(baseParams(core, HOSTED))
    priv(controller).threadId = 'thread-123'
    const stopSpy = jest.spyOn(controller, 'stop').mockResolvedValue(undefined)
    const postBotSpy = jest.spyOn(priv(controller), 'postBotMessage')

    await priv(controller).postBillingTicks(15, false)

    expect(stopSpy).not.toHaveBeenCalled()
    expect(postBotSpy).not.toHaveBeenCalled()
    expect(priv(controller).insufficientStopFired).toBe(false)
  })

  it('a transcription-tick shortfall NEVER stops — only server_uptime is the signal', async () => {
    // Force the transcription surcharge to be live + delivered so the tick
    // actually fires, and make ONLY the transcription tick report 402.
    const core = makeCore({ transcription: true, server_uptime: false })
    const cfg: CfgHostedConfig = { ...HOSTED, transcriptionCtPerMinute: 7 }
    const controller = new SessionController(baseParams(core, cfg))
    priv(controller).threadId = 'thread-123'
    ;(controller as unknown as { transcriptionBilled: boolean }).transcriptionBilled = true
    ;(controller as unknown as { transcriptionDelivered: boolean }).transcriptionDelivered = true
    const stopSpy = jest.spyOn(controller, 'stop').mockResolvedValue(undefined)
    const postBotSpy = jest.spyOn(priv(controller), 'postBotMessage')

    await priv(controller).postBillingTicks(15, false)

    // The transcription tick was posted, but a transcription 402 is ignored —
    // the user keeps the recording they paid server-uptime for.
    expect(core.postBillingTick).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'transcription' }),
    )
    expect(stopSpy).not.toHaveBeenCalled()
    expect(postBotSpy).not.toHaveBeenCalled()
  })

  it('self-host (no cfg) never bills and never stops', async () => {
    const core = makeCore({ server_uptime: true })
    const controller = new SessionController(baseParams(core, undefined))
    const stopSpy = jest.spyOn(controller, 'stop').mockResolvedValue(undefined)

    await priv(controller).postBillingTicks(15, false)

    expect(core.postBillingTick).not.toHaveBeenCalled()
    expect(stopSpy).not.toHaveBeenCalled()
  })
})
