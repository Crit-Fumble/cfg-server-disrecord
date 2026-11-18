/**
 * Captions keep the speaker's name and avatar from the first words (cfg-server-disrecord, 2026-11-18). The speaker
 * webhook manager exists before the session can hear anyone; a caption that still went out as the bot (no webhook
 * yet, or none allowed) is edited as the bot, never through a webhook made since, which Discord refuses as
 * "Unknown Message" on every interim.
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

const getOrCreate = jest.fn()
jest.mock('../../../src/discord/speaker-webhook.js', () => ({
  SpeakerWebhookManager: jest.fn().mockImplementation(() => ({
    init: jest.fn(async () => undefined),
    cleanup: jest.fn(async () => undefined),
    getOrCreate: (...a: unknown[]) => getOrCreate(...a),
  })),
}))

jest.mock('../../../src/discord/thread-poster.js', () => ({
  createRecordingThread: jest.fn(async () => 'thread-123'),
  postRecording: jest.fn(async () => undefined),
  tempDirOf: jest.fn(() => '/tmp'),
}))

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testSettingsStore } from '../../_lib/settings.js'
import { RecordingSession } from '../../../src/recording/recording-session.js'
import { SpeakerWebhookManager } from '../../../src/discord/speaker-webhook.js'
import { SessionController, type SessionControllerParams } from '../../../src/recording/session-controller.js'

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never

function baseParams(): SessionControllerParams {
  return {
    recordingId: 'rec-1',
    client: {
      on: jest.fn(),
      off: jest.fn(),
      user: { id: 'bot-self' },
      users: { fetch: jest.fn(async () => { throw new Error('no avatar in tests') }) },
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
    consentStorePath: join(tmpdir(), 'disrecord-test-consent.json'),
    settingsStore: testSettingsStore(),
    sink: {} as never,
    cfg: undefined,
    core: {
      fetchSessionPolicy: jest.fn(async () => ({ consentedUserIds: [], speakerNames: {} })),
      postTranscript: jest.fn(),
      postBillingTick: jest.fn(async () => ({ insufficientCoins: false })),
      postRecordingThread: jest.fn(async () => undefined),
      postParticipants: jest.fn(async () => undefined),
    } as never,
    logger: silentLogger,
  }
}

interface Privates {
  postCaption(speakerId: string, speakerName: string, content: string): Promise<string | null>
  editCaption(speakerId: string, messageId: string, content: string): Promise<void>
  postBotMessage(content: string): Promise<string | null>
  editBotMessage(messageId: string, content: string): Promise<void>
  threadId: string | null
}
const priv = (c: SessionController) => c as unknown as Privates

function speakerWebhook(id: string) {
  return { send: jest.fn(async () => ({ id })), editMessage: jest.fn(async () => undefined) }
}

async function started(): Promise<SessionController> {
  const controller = new SessionController(baseParams())
  await controller.start()
  priv(controller).threadId = 'thread-123'
  return controller
}

beforeEach(() => jest.clearAllMocks())
afterEach(() => jest.restoreAllMocks())

it('makes the speaker webhook manager before the session that hears speech', async () => {
  await started()
  const managerAt = (SpeakerWebhookManager as unknown as jest.Mock).mock.invocationCallOrder[0]
  const sessionAt = (RecordingSession as unknown as jest.Mock).mock.invocationCallOrder[0]
  expect(managerAt).toBeLessThan(sessionAt)
})

it('edits a caption posted as the bot as the bot, even once the speaker has a webhook', async () => {
  const controller = await started()
  const webhook = speakerWebhook('wh-1')
  getOrCreate.mockResolvedValueOnce(null).mockResolvedValue(webhook)
  const postBot = jest.spyOn(priv(controller), 'postBotMessage').mockResolvedValue('bot-1')
  const editBot = jest.spyOn(priv(controller), 'editBotMessage').mockResolvedValue(undefined)

  expect(await priv(controller).postCaption('mumbley', 'Mumbley', 'Alright.')).toBe('bot-1')
  expect(postBot).toHaveBeenCalledWith('**Mumbley:** Alright.')
  await priv(controller).editCaption('mumbley', 'bot-1', 'Alright. We were')

  expect(editBot).toHaveBeenCalledWith('bot-1', 'Alright. We were')
  expect(webhook.editMessage).not.toHaveBeenCalled()
})

it('edits a caption posted through the speaker webhook through that webhook', async () => {
  const controller = await started()
  const webhook = speakerWebhook('wh-msg-1')
  getOrCreate.mockResolvedValue(webhook)
  const editBot = jest.spyOn(priv(controller), 'editBotMessage').mockResolvedValue(undefined)

  expect(await priv(controller).postCaption('mumbley', 'Mumbley', 'Alright.')).toBe('wh-msg-1')
  expect(webhook.send).toHaveBeenCalledWith(expect.objectContaining({ username: 'Mumbley', threadId: 'thread-123' }))
  await priv(controller).editCaption('mumbley', 'wh-msg-1', 'Alright. We were')

  expect(webhook.editMessage).toHaveBeenCalledWith('wh-msg-1', { content: 'Alright. We were', threadId: 'thread-123' })
  expect(editBot).not.toHaveBeenCalled()
})
