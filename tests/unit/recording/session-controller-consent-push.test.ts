/**
 * Control-API consent push must actually flip the capture gate — in BOTH
 * hosting modes.
 *
 * Regression for #7: `pushConsent` delegated solely to `consentSync`, which is
 * only constructed when `cfg` is present. In self-host mode the optional chain
 * evaporated and `POST /v1/recordings/:id/consent` returned 204 having changed
 * nothing. Because `pcm-capture` gates every write on `isConsented`, the
 * recording then captured zero bytes with no error anywhere — the failure
 * surfaced only as `speakerCount: 0` and "nothing recorded".
 *
 * The contract under test is mode-independent: a pushed consent update flips
 * `ConsentManager`, whether or not the CFG-hosted bridge exists.
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
import type { CfgHostedConfig } from '../../../src/config.js'
import type { ConsentManager } from '../../../src/consent/consent-manager.js'

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

function fakeCore() {
  return {
    fetchSessionPolicy: jest.fn(async () => ({ consentedUserIds: [], speakerNames: {} })),
    postTranscript: jest.fn(),
    postBillingTick: jest.fn(async () => ({ insufficientCoins: false })),
    postRecordingThread: jest.fn(async () => undefined),
  } as never
}

function baseParams(cfg: CfgHostedConfig | undefined): SessionControllerParams {
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
    sink: {} as never,
    cfg,
    core: fakeCore(),
    logger: silentLogger,
  }
}

/**
 * The pipeline — including the ConsentManager gate and the CFG-hosted
 * consent-sync bridge — is built in `start()`, not the constructor, so the
 * controller must actually be started for this contract to be exercised.
 */
async function startController(cfg: CfgHostedConfig | undefined): Promise<SessionController> {
  const controller = new SessionController(baseParams(cfg))
  await controller.start()
  return controller
}

/** The capture gate lives on the controller's private ConsentManager. */
function gate(c: SessionController): ConsentManager {
  return (c as unknown as { consent: ConsentManager }).consent
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('SessionController.pushConsent', () => {
  describe('self-host mode (no cfg)', () => {
    it('a pushed consent flips the capture gate', async () => {
      const controller = await startController(undefined)
      expect(gate(controller).isConsented('u1')).toBe(false)

      controller.pushConsent('u1', true)

      expect(gate(controller).isConsented('u1')).toBe(true)
    })

    it('a pushed decline clears an existing consent', async () => {
      const controller = await startController(undefined)
      controller.pushConsent('u1', true)

      controller.pushConsent('u1', false)

      expect(gate(controller).isConsented('u1')).toBe(false)
    })

    it('is idempotent', async () => {
      const controller = await startController(undefined)

      controller.pushConsent('u1', true)
      controller.pushConsent('u1', true)

      expect(gate(controller).isConsented('u1')).toBe(true)
    })
  })

  describe('CFG-hosted mode', () => {
    it('a pushed consent flips the capture gate', async () => {
      const controller = await startController(HOSTED)

      controller.pushConsent('u1', true)

      expect(gate(controller).isConsented('u1')).toBe(true)
    })

    it('a pushed decline clears an existing consent', async () => {
      const controller = await startController(HOSTED)
      controller.pushConsent('u1', true)

      controller.pushConsent('u1', false)

      expect(gate(controller).isConsented('u1')).toBe(false)
    })

    it('still drives the consent-sync bridge for core-server bookkeeping', async () => {
      const controller = await startController(HOSTED)
      const sync = (controller as unknown as { consentSync: { applyPushedUpdate: unknown } })
        .consentSync
      const spy = jest.spyOn(sync as never, 'applyPushedUpdate')

      controller.pushConsent('u1', true)

      expect(spy).toHaveBeenCalledWith('u1', true)
    })
  })
})
