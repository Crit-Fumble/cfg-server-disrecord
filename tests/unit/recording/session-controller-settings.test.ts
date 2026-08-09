/**
 * The container's own settings reach a recording.
 *
 * Steps 1-2 gave DisRecord a settings document and an API; nothing read it.
 * This is the wiring, and the two rules that make it correct:
 *
 *   1. The file WINS over the platform's session policy. The document is the
 *      source of truth for operational config; the policy is the older path
 *      that still supplies the consent set.
 *   2. An EMPTY array is a real value, not an absence. A channel that sets
 *      `keywords: []` wants no boosts, and must not silently inherit the
 *      platform's list.
 */

const mockVoiceJoin = jest.fn(async () => undefined)
jest.mock('../../../src/gateway/voice-capture.js', () => ({
  VoiceCapture: jest.fn().mockImplementation(() => ({ join: mockVoiceJoin, leave: jest.fn() })),
}))

jest.mock('../../../src/recording/pcm-capture.js', () => ({
  PcmCapture: jest.fn().mockImplementation(() => ({
    onSessionStop: jest.fn(async () => undefined),
    getResult: jest.fn(() => null),
    speakerCount: 0,
    setPaused: jest.fn(),
  })),
}))

/** Captured so the test can read the keywords the session was built with. */
const mockRecordingSession = jest.fn()
jest.mock('../../../src/recording/recording-session.js', () => ({
  RecordingSession: jest.fn().mockImplementation((args: unknown) => {
    mockRecordingSession(args)
    return { addConsentedUser: jest.fn(), addDeclinedUser: jest.fn(), stop: jest.fn(async () => undefined), setPaused: jest.fn() }
  }),
}))

jest.mock('../../../src/deepgram/index.js', () => ({ buildDeepgramTokenProvider: jest.fn(() => null) }))

jest.mock('../../../src/discord/speaker-webhook.js', () => ({
  SpeakerWebhookManager: jest.fn().mockImplementation(() => ({
    init: jest.fn(async () => undefined),
    cleanup: jest.fn(async () => undefined),
  })),
}))

const mockCreateThread = jest.fn(async (..._args: unknown[]) => 'thread-123')
jest.mock('../../../src/discord/thread-poster.js', () => ({
  createRecordingThread: (...args: unknown[]) => mockCreateThread(...args),
  postRecording: jest.fn(async () => undefined),
  tempDirOf: jest.fn(() => '/tmp'),
}))

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionController, type SessionControllerParams } from '../../../src/recording/session-controller.js'
import { FileSettingsStore } from '../../../src/settings/settings-store.js'
import type { CoreServerClient } from '../../../src/phone-home/core-client.js'

const GUILD = '100000000000000001'
const CHANNEL = '200000000000000002'

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never

function fakeClient() {
  return {
    on: jest.fn(),
    off: jest.fn(),
    user: { id: 'bot-self' },
    channels: {
      fetch: jest.fn(async (id: string) =>
        id === CHANNEL ? { isVoiceBased: () => true, name: 'Table 1', members: new Map() } : null,
      ),
    },
  } as never
}

/** A CFG-hosted core client whose policy carries keywords, so "file wins" is testable. */
function coreWithPolicyKeywords(): CoreServerClient {
  return {
    fetchSessionPolicy: jest.fn(async () => ({
      consentedUserIds: [],
      speakerNames: {},
      keywords: ['policy-kw'],
      keyterms: ['policy-kt'],
    })),
    postTranscript: jest.fn(),
    postBillingTick: jest.fn(),
    postRecordingThread: jest.fn(async () => {}),
    postParticipants: jest.fn(async () => {}),
  } as never
}

let dir: string
let store: FileSettingsStore

async function start(overrides: Partial<SessionControllerParams> = {}): Promise<SessionController> {
  const params: SessionControllerParams = {
    recordingId: 'rec-1',
    client: fakeClient(),
    guildId: GUILD,
    voiceChannelId: CHANNEL,
    textChannelId: 'tc-1',
    transcription: true,
    deepgramMode: 'disabled',
    deepgramKey: null,
    deepgramModel: 'nova-3',
    deepgramLanguage: 'en',
    chunkMinutes: 0,
    consentStorePath: join(dir, 'consent.json'),
    settingsStore: store,
    sink: {} as never,
    core: coreWithPolicyKeywords(),
    cfg: {
      coreServerUrl: 'http://core.invalid',
      coreServerToken: 'tok',
      installationId: 'inst-1',
      userId: 'user-1',
      size: 'small',
    },
    logger: silentLogger,
    ...overrides,
  }
  const controller = new SessionController(params)
  await controller.start()
  return controller
}

/** Keywords the RecordingSession was constructed with. */
function builtWith(): { keywords: string[]; keyterms: string[] } {
  const args = mockRecordingSession.mock.calls[0][0] as { keywords: string[]; keyterms: string[] }
  return { keywords: args.keywords, keyterms: args.keyterms }
}

beforeEach(async () => {
  jest.clearAllMocks()
  mockCreateThread.mockImplementation(async () => 'thread-123')
  dir = await mkdtemp(join(tmpdir(), 'disrecord-sc-settings-'))
  store = new FileSettingsStore({ path: join(dir, 'worlds.json'), logger: silentLogger })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('SessionController — the container’s own settings', () => {
  it('falls back to the session policy when nothing is configured', async () => {
    await start()
    expect(builtWith()).toEqual({ keywords: ['policy-kw'], keyterms: ['policy-kt'] })
  })

  it('the channel’s keywords WIN over the platform policy', async () => {
    await store.setScene(GUILD, CHANNEL, { keywords: ['Keawe', 'Mumbley'] })
    await start()
    expect(builtWith().keywords).toEqual(['Keawe', 'Mumbley'])
    // keyterms unset on the scene, so that axis still defers.
    expect(builtWith().keyterms).toEqual(['policy-kt'])
  })

  it('inherits world defaults for an unconfigured channel', async () => {
    await store.setWorldDefaults(GUILD, { keywords: ['world-kw'] })
    await start()
    expect(builtWith().keywords).toEqual(['world-kw'])
  })

  it('an EMPTY array means no boosts — it does not fall through to the policy', async () => {
    await store.setScene(GUILD, CHANNEL, { keywords: [] })
    await start()
    // `??` not `||`: [] is a value. With `||` this would silently inherit
    // ['policy-kw'] and the channel could never turn boosts off.
    expect(builtWith().keywords).toEqual([])
  })

  it('passes the operator’s threadNameTemplate to thread creation', async () => {
    await store.setScene(GUILD, CHANNEL, { threadNameTemplate: '{{voiceChannel}} log' })
    await start()
    expect(mockCreateThread.mock.calls[0][6]).toBe('{{voiceChannel}} log')
  })

  it('passes undefined when no template is configured', async () => {
    await start()
    expect(mockCreateThread.mock.calls[0][6]).toBeUndefined()
  })

  it('a settings failure never fails the recording', async () => {
    const broken = {
      effective: jest.fn(async () => {
        throw new Error('disk on fire')
      }),
    } as never
    await start({ settingsStore: broken })
    // Falls back to the policy — exactly the pre-settings behaviour.
    expect(builtWith().keywords).toEqual(['policy-kw'])
  })
})

describe('SessionController.pushConsent — the control-API path', () => {
  it('persists a remembered decision all the way to disk', async () => {
    // ⚠️ This drives the WIRING, not the manager. A direct
    // ConsentManager.applyExternalDecision test passes even with
    // pushConsent reverted to poking applyConsent/applyDecline — which is
    // exactly the bug, and exactly the kind of green-for-the-wrong-reason
    // this repo keeps catching.
    const controller = await start({ cfg: undefined }) // self-host wires the store
    controller.pushConsent('400000000000000005', true, true)
    await new Promise((r) => setTimeout(r, 50))

    const doc = JSON.parse(await readFile(join(dir, 'consent.json'), 'utf-8'))
    expect(doc.channels[`${GUILD}/${CHANNEL}`]).toEqual({ '400000000000000005': 'opted-in' })
  })

  it('persists a decline even without remember', async () => {
    const controller = await start({ cfg: undefined })
    controller.pushConsent('400000000000000006', false)
    await new Promise((r) => setTimeout(r, 50))

    // Core's rule, mirrored: someone who said no is not asked again next week.
    const doc = JSON.parse(await readFile(join(dir, 'consent.json'), 'utf-8'))
    expect(doc.channels[`${GUILD}/${CHANNEL}`]).toEqual({ '400000000000000006': 'opted-out' })
  })

  it('a this-time-only consent writes nothing durable', async () => {
    const controller = await start({ cfg: undefined })
    controller.pushConsent('400000000000000007', true, false)
    await new Promise((r) => setTimeout(r, 50))

    await expect(readFile(join(dir, 'consent.json'), 'utf-8')).rejects.toThrow()
  })
})
