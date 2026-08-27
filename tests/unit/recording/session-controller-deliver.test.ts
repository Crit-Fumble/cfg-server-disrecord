/**
 * SessionController.deliver() → attachment report-back orchestration (cs#352).
 *
 * Contract under test:
 *   - postRecording resolving TRUE (all parts landed in the thread) fires
 *     exactly one thread report carrying attachmentUploaded:true — and it
 *     resends the parent channel id (textChannelId), because core's route
 *     writes `recordingThreadParentId: body.parentChannelId ?? null` and an
 *     omitted parent would silently null the stored value.
 *   - postRecording resolving FALSE (any silent-failure exit) fires NO
 *     report — the flag is monotonic and only ever set on a delivered
 *     artifact.
 *   - self-host (no cfg) never reports, whatever postRecording returned.
 *   - a failed report-back never breaks delivery (warn-and-continue).
 *
 * Collaborators are mocked at the module boundary so the test exercises only
 * the controller's deliver→report orchestration.
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
  postRecording: jest.fn(async () => true),
  postChunk: jest.fn(async () => null),
  tempDirOf: jest.fn(() => '/tmp'),
}))

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testSettingsStore } from '../../_lib/settings.js'
import { postRecording } from '../../../src/discord/thread-poster.js'
import { SessionController, type SessionControllerParams } from '../../../src/recording/session-controller.js'
import type { CfgHostedConfig } from '../../../src/config.js'

const postRecordingMock = postRecording as jest.Mock

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

function makeCore() {
  return {
    fetchSessionPolicy: jest.fn(async () => ({ consentedUserIds: [], speakerNames: {} })),
    postTranscript: jest.fn(),
    postBillingTick: jest.fn(async () => ({ insufficientCoins: false })),
    postRecordingThread: jest.fn(async () => undefined),
  }
}
type FakeCore = ReturnType<typeof makeCore>

function baseParams(core: FakeCore, cfg: CfgHostedConfig | undefined): SessionControllerParams {
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
    chunkMinutes: 0,
    consentStorePath: join(tmpdir(), 'disrecord-test-consent.json'),
    settingsStore: testSettingsStore(),
    sink: {} as never,
    cfg,
    core: core as never,
    logger: silentLogger,
  }
}

/** A minimal finalized-recording result — postRecording itself is mocked. */
const RESULT = {
  mp3Path: '/tmp/rec-1.mp3',
  sizeBytes: 1234,
  durationMs: 60_000,
  captions: [],
  mp3Location: '/tmp/rec-1.mp3',
} as never

/** Reach into the controller's private surface for the unit-level drive. */
type Privates = {
  deliver(result: typeof RESULT): Promise<void>
  threadId: string | null
  consent: { consentedIds(): Set<string> }
}
function priv(c: SessionController): Privates {
  return c as unknown as Privates
}

/** Wire the deliver() prerequisites start() would normally have set. */
function armed(core: FakeCore, cfg: CfgHostedConfig | undefined): SessionController {
  const controller = new SessionController(baseParams(core, cfg))
  priv(controller).threadId = 'thread-123'
  priv(controller).consent = { consentedIds: () => new Set<string>() }
  return controller
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('SessionController deliver() — attachment report-back (cs#352)', () => {
  it('reports attachmentUploaded:true (with the parent channel id) after a full post', async () => {
    postRecordingMock.mockResolvedValue(true)
    const core = makeCore()
    const controller = armed(core, HOSTED)

    await priv(controller).deliver(RESULT)

    expect(core.postRecordingThread).toHaveBeenCalledTimes(1)
    expect(core.postRecordingThread).toHaveBeenCalledWith('thread-123', 'tc-1', true)
  })

  it('does NOT report when postRecording returns false', async () => {
    postRecordingMock.mockResolvedValue(false)
    const core = makeCore()
    const controller = armed(core, HOSTED)

    await priv(controller).deliver(RESULT)

    expect(postRecordingMock).toHaveBeenCalledTimes(1)
    expect(core.postRecordingThread).not.toHaveBeenCalled()
  })

  it('self-host (no cfg) never reports, even on a successful post', async () => {
    postRecordingMock.mockResolvedValue(true)
    const core = makeCore()
    const controller = armed(core, undefined)

    await priv(controller).deliver(RESULT)

    expect(core.postRecordingThread).not.toHaveBeenCalled()
  })

  it('a failed report-back never breaks delivery (warn-and-continue)', async () => {
    postRecordingMock.mockResolvedValue(true)
    const core = makeCore()
    core.postRecordingThread.mockRejectedValue(new Error('ECONNREFUSED'))
    const controller = armed(core, HOSTED)

    await expect(priv(controller).deliver(RESULT)).resolves.toBeUndefined()
  })
})
