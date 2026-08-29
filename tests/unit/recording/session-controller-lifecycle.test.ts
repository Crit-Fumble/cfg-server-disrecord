/**
 * SessionController — the worker-owned end of a recording (cfg-server-disrecord#74).
 *
 * Contract under test:
 *   - EMPTY CHANNEL: no humans for `emptyPromptMs` → the one-button prompt is
 *     posted; for `emptyEndMs` → the recording stops with reason
 *     `channel-empty`. A rejoin cancels both and withdraws the prompt.
 *   - SCHEDULED END: `scheduledEndAt` → the prompt; unanswered for
 *     `promptTimeoutMs` it ends ONLY when the channel is empty by then. A
 *     table that is still there keeps recording (the prompt stays up).
 *   - BOT DISCONNECTED: VoiceCapture's onExplicitDisconnect ends with reason
 *     `bot-disconnected`.
 *   - THE BUTTON: a gateway click resolves the prompt and ends with
 *     `user-button`.
 *   - EVERY STOP reports home with its reason (hosted) — never in self-host —
 *     and fires `onStopped` exactly once, after the pipeline. The FIRST
 *     reason wins when stops overlap.
 *
 * Collaborators are mocked at the module boundary; VoiceCapture's constructor
 * params are captured so the test can drive the occupancy + disconnect
 * callbacks the way the gateway would. Clocks are jest fake timers.
 */

let voiceParams: {
  onOccupancyChanged?: (ids: string[]) => void
  onExplicitDisconnect?: (reason: string) => void
} | null = null

jest.mock('../../../src/gateway/voice-capture.js', () => {
  const actual = jest.requireActual('../../../src/gateway/voice-capture.js')
  return {
    ...actual,
    VoiceCapture: jest.fn().mockImplementation((params: typeof voiceParams) => {
      voiceParams = params
      return {
        join: jest.fn(async () => undefined),
        leave: jest.fn(),
        currentOccupancy: jest.fn(() => []),
      }
    }),
  }
})

jest.mock('../../../src/recording/pcm-capture.js', () => ({
  PcmCapture: jest.fn().mockImplementation(() => ({
    onSessionStop: jest.fn(async () => undefined),
    getResult: jest.fn(() => ({ speakerFiles: new Map() })),
    snapshotSpeakerFiles: jest.fn(() => new Map()),
    timelineByteNow: jest.fn(() => 0),
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

// Nothing was captured, so there is nothing to mix — keeps the stop pipeline
// on the "no output" branch and out of ffmpeg.
jest.mock('../../../src/recording/post-process.js', () => ({
  processRecording: jest.fn(async () => null),
}))

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testSettingsStore } from '../../_lib/settings.js'
import { SessionController, type SessionControllerParams, type StopReason } from '../../../src/recording/session-controller.js'
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
  size: 'small',
}

/** Short clocks so the suite runs in fake-timer milliseconds. */
const TIMINGS = { emptyPromptMs: 5_000, emptyEndMs: 10_000, promptTimeoutMs: 3_000 }

type Listener = (...args: unknown[]) => void

/**
 * A Discord client stub: a voice channel with the given human members, and a
 * thread whose `send` returns a message id and whose `messages.fetch` returns
 * an editable message that still carries its button row.
 */
function fakeClient(voiceMemberIds: string[]) {
  const listeners = new Map<string, Listener[]>()
  const promptMessage = {
    id: 'msg-1',
    editable: true,
    components: [{ type: 1 }],
    edit: jest.fn(async (_payload: unknown) => undefined),
  }
  const thread = {
    isSendable: () => true,
    isTextBased: () => true,
    isThread: () => true,
    members: { add: jest.fn(async () => undefined) },
    send: jest.fn(async (_payload: unknown) => ({ id: 'msg-1' })),
    messages: { fetch: jest.fn(async () => promptMessage) },
  }
  const members = new Map<string, { user: { bot: boolean } }>()
  for (const id of voiceMemberIds) members.set(id, { user: { bot: false } })
  members.set('bot-self', { user: { bot: true } })
  const voice = { isVoiceBased: () => true, name: 'Table 1', members }
  const client = {
    on: jest.fn((evt: string, fn: Listener) => {
      listeners.set(evt, [...(listeners.get(evt) ?? []), fn])
    }),
    off: jest.fn((evt: string, fn: Listener) => {
      listeners.set(evt, (listeners.get(evt) ?? []).filter((f) => f !== fn))
    }),
    user: { id: 'bot-self', setPresence: jest.fn() },
    channels: {
      cache: new Map(),
      fetch: jest.fn(async (id: string) => (id === 'vc-1' ? voice : id === 'thread-123' ? thread : null)),
    },
  }
  return { client: client as never, listeners, thread, promptMessage }
}

function makeCore() {
  return {
    fetchSessionPolicy: jest.fn(async () => ({ consentedUserIds: [], speakerNames: {} })),
    postTranscript: jest.fn(),
    postBillingTick: jest.fn(async () => ({ insufficientCoins: false })),
    postRecordingThread: jest.fn(async () => undefined),
    postParticipants: jest.fn(async () => undefined),
    postChunk: jest.fn(async () => undefined),
    postRecordingEnded: jest.fn(async () => undefined),
  }
}
type FakeCore = ReturnType<typeof makeCore>

function params(
  core: FakeCore,
  client: never,
  overrides: Partial<SessionControllerParams> = {},
): SessionControllerParams {
  return {
    recordingId: 'inst-1',
    client,
    guildId: 'guild-1',
    voiceChannelId: 'vc-1',
    textChannelId: 'tc-1',
    transcription: false,
    deepgramMode: 'disabled',
    deepgramKey: null,
    deepgramModel: 'nova-3',
    deepgramLanguage: 'en',
    chunkMinutes: 0,
    consentStorePath: join(tmpdir(), 'disrecord-lifecycle-test-consent.json'),
    settingsStore: testSettingsStore(),
    sink: {} as never,
    cfg: HOSTED,
    core: core as never,
    logger: silentLogger,
    timings: TIMINGS,
    ...overrides,
  }
}

/** The text of every message sent to the thread, in order. */
function sentContents(thread: ReturnType<typeof fakeClient>['thread']): string[] {
  return thread.send.mock.calls.map((c) => (c[0] as { content: string }).content)
}

function promptSends(thread: ReturnType<typeof fakeClient>['thread']): string[] {
  return sentContents(thread).filter((c) => c.includes('Session over?'))
}

async function started(voiceMembers: string[], overrides: Partial<SessionControllerParams> = {}) {
  const core = makeCore()
  const fake = fakeClient(voiceMembers)
  // `stopped` resolves when the pipeline has fully completed — the only
  // honest way to wait for a timer-triggered stop, which the test never
  // holds a promise for.
  let resolveStopped: (reason: StopReason) => void = () => undefined
  const stopped = new Promise<StopReason>((resolve) => {
    resolveStopped = resolve
  })
  const onStopped = jest.fn((reason: StopReason) => resolveStopped(reason))
  const controller = new SessionController(params(core, fake.client, { onStopped, ...overrides }))
  await controller.start()
  return { core, fake, controller, onStopped, stopped }
}

/**
 * Let real I/O (the stop pipeline removes its temp dir) and promise chains
 * settle. setImmediate is deliberately NOT faked (see useFakeTimers below),
 * so each turn here is a real event-loop turn.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
  voiceParams = null
})
afterEach(() => {
  jest.useRealTimers()
})

describe('empty channel', () => {
  it('seeds occupancy from the channel at start and arms nothing while people are present', async () => {
    const { controller, fake } = await started(['u1', 'u2'])
    expect(controller.describe().humansPresent).toBe(2)
    await jest.advanceTimersByTimeAsync(TIMINGS.emptyEndMs * 2)
    expect(promptSends(fake.thread)).toHaveLength(0)
    expect(controller.describe().status).toBe('recording')
  })

  it('prompts at emptyPromptMs and ends with channel-empty at emptyEndMs, reporting home', async () => {
    const { controller, fake, core, onStopped, stopped } = await started([])
    expect(controller.describe().humansPresent).toBe(0)

    await jest.advanceTimersByTimeAsync(TIMINGS.emptyPromptMs)
    expect(promptSends(fake.thread)).toEqual(['Looks like everyone has left. Session over?'])
    expect(controller.describe().endPromptPosted).toBe(true)
    // The button rides the prompt, keyed like the consent buttons.
    const lastSend = fake.thread.send.mock.calls.at(-1)?.[0] as { components: Array<{ toJSON(): unknown }> }
    expect(JSON.stringify(lastSend.components.map((r) => r.toJSON()))).toContain('end_recording:inst-1')

    await jest.advanceTimersByTimeAsync(TIMINGS.emptyEndMs - TIMINGS.emptyPromptMs)
    await expect(stopped).resolves.toBe('channel-empty')
    expect(controller.describe().status).toBe('stopped')
    expect(controller.describe().stopReason).toBe('channel-empty')
    expect(core.postRecordingEnded).toHaveBeenCalledTimes(1)
    expect(core.postRecordingEnded).toHaveBeenCalledWith('channel-empty')
    expect(onStopped).toHaveBeenCalledTimes(1)
    expect(onStopped).toHaveBeenCalledWith('channel-empty')
    // The prompt says what happened, and its button is gone.
    expect(fake.promptMessage.edit).toHaveBeenCalledWith({ content: 'Recording ended — everyone left.', components: [] })
  })

  it('a rejoin cancels the clock and withdraws the prompt', async () => {
    const { controller, fake } = await started([])
    await jest.advanceTimersByTimeAsync(TIMINGS.emptyPromptMs)
    expect(promptSends(fake.thread)).toHaveLength(1)

    voiceParams!.onOccupancyChanged!(['u1'])
    await settle()
    expect(controller.describe().endPromptPosted).toBe(false)
    expect(fake.promptMessage.edit).toHaveBeenCalledWith({ content: "Someone's back — recording continues.", components: [] })

    await jest.advanceTimersByTimeAsync(TIMINGS.emptyEndMs * 2)
    expect(controller.describe().status).toBe('recording')
  })

  it('leave-then-rejoin-then-leave restarts the full window — the clock is "how long empty NOW"', async () => {
    const { controller, stopped } = await started(['u1'])
    voiceParams!.onOccupancyChanged!([])
    await jest.advanceTimersByTimeAsync(TIMINGS.emptyEndMs - 1_000)
    voiceParams!.onOccupancyChanged!(['u1'])
    voiceParams!.onOccupancyChanged!([])
    await jest.advanceTimersByTimeAsync(TIMINGS.emptyEndMs - 1_000)
    expect(controller.describe().status).toBe('recording')
    await jest.advanceTimersByTimeAsync(1_000)
    await expect(stopped).resolves.toBe('channel-empty')
  })

  it('repeated "still empty" reports do not push the deadline out', async () => {
    const { stopped } = await started([])
    await jest.advanceTimersByTimeAsync(TIMINGS.emptyEndMs - 1_000)
    voiceParams!.onOccupancyChanged!([]) // mute/deafen churn from nobody
    await jest.advanceTimersByTimeAsync(1_000)
    await expect(stopped).resolves.toBe('channel-empty')
  })
})

describe('scheduled end', () => {
  it('prompts at scheduledEndAt, and unanswered with people still here it keeps recording', async () => {
    const scheduledEndAt = new Date(Date.now() + 60_000)
    const { controller, fake } = await started(['u1'], { scheduledEndAt })
    await jest.advanceTimersByTimeAsync(60_000)
    expect(promptSends(fake.thread)).toEqual(['The scheduled end time has passed. Session over?'])

    await jest.advanceTimersByTimeAsync(TIMINGS.promptTimeoutMs)
    await settle()
    expect(controller.describe().status).toBe('recording')
    // The prompt stays up, reworded, button intact.
    const edit = fake.promptMessage.edit.mock.calls.at(-1)?.[0] as { content: string; components: unknown[] }
    expect(edit.content).toContain('Still recording')
    expect(edit.components).toHaveLength(1)
  })

  it('unanswered with the channel empty by then, it ends with scheduled-end', async () => {
    const scheduledEndAt = new Date(Date.now() + 60_000)
    const { controller, core, stopped } = await started(['u1'], { scheduledEndAt })
    await jest.advanceTimersByTimeAsync(60_000)
    voiceParams!.onOccupancyChanged!([]) // they left right after the prompt
    await jest.advanceTimersByTimeAsync(TIMINGS.promptTimeoutMs)
    await expect(stopped).resolves.toBe('scheduled-end')
    expect(controller.describe().status).toBe('stopped')
    expect(core.postRecordingEnded).toHaveBeenCalledWith('scheduled-end')
  })

  it('a scheduled end already in the past at start is ignored', async () => {
    const { fake } = await started(['u1'], { scheduledEndAt: new Date(Date.now() - 60_000) })
    await jest.advanceTimersByTimeAsync(TIMINGS.promptTimeoutMs * 5)
    expect(promptSends(fake.thread)).toHaveLength(0)
  })
})

describe('the platform relay + the button', () => {
  it('promptEnd() posts once; a second trigger while the prompt is up is a no-op', async () => {
    const { controller, fake } = await started(['u1'])
    await controller.promptEnd('event-ended')
    await controller.promptEnd('event-ended')
    await controller.promptEnd('scheduled-end')
    expect(promptSends(fake.thread)).toEqual(['The Discord event has ended. Session over?'])
  })

  it('a gateway click on End recording acks by rewriting the prompt and ends with user-button', async () => {
    const { controller, fake, core, stopped } = await started(['u1'])
    await controller.promptEnd('event-ended')
    const interaction = {
      isButton: () => true,
      customId: 'end_recording:inst-1',
      user: { id: 'u1', displayName: 'Alice', username: 'alice' },
      member: { displayName: 'Alice' },
      update: jest.fn(async () => undefined),
      reply: jest.fn(async () => undefined),
    }
    for (const fn of fake.listeners.get('interactionCreate') ?? []) fn(interaction)
    await expect(stopped).resolves.toBe('user-button')
    expect(interaction.update).toHaveBeenCalledWith({ content: 'Recording ended by Alice.', components: [] })
    expect(controller.describe().status).toBe('stopped')
    expect(core.postRecordingEnded).toHaveBeenCalledWith('user-button')
    // Already resolved by the click — the stop pipeline must not rewrite it.
    expect(fake.promptMessage.edit).not.toHaveBeenCalled()
  })

  it('ignores buttons that are not ours', async () => {
    const { controller, fake } = await started(['u1'])
    const interaction = {
      isButton: () => true,
      customId: 'consent:inst-1',
      user: { id: 'u1', displayName: 'Alice', username: 'alice' },
      member: null,
      update: jest.fn(async () => undefined),
      reply: jest.fn(async () => undefined),
      deferReply: jest.fn(async () => undefined),
      editReply: jest.fn(async () => undefined),
    }
    for (const fn of fake.listeners.get('interactionCreate') ?? []) fn(interaction)
    await settle()
    expect(interaction.update).not.toHaveBeenCalled()
    expect(controller.describe().status).toBe('recording')
  })

  it('leaves a prompt alone that the platform already resolved (no components left)', async () => {
    const { controller, fake } = await started(['u1'])
    await controller.promptEnd('event-ended')
    fake.promptMessage.components = []
    await controller.stop('control-stop')
    expect(fake.promptMessage.edit).not.toHaveBeenCalled()
  })
})

describe('stop reasons and reporting', () => {
  it('a human disconnecting the bot ends the recording with bot-disconnected', async () => {
    const { controller, core, onStopped, stopped } = await started(['u1'])
    voiceParams!.onExplicitDisconnect!('disconnected from voice by a user')
    await expect(stopped).resolves.toBe('bot-disconnected')
    expect(controller.describe().status).toBe('stopped')
    expect(core.postRecordingEnded).toHaveBeenCalledWith('bot-disconnected')
    expect(onStopped).toHaveBeenCalledWith('bot-disconnected')
  })

  it('the first reason wins when stops overlap, and the report is sent once', async () => {
    const { core, onStopped, controller } = await started(['u1'])
    const first = controller.stop('channel-empty')
    const second = controller.stop('control-stop')
    await Promise.all([first, second])
    expect(core.postRecordingEnded).toHaveBeenCalledTimes(1)
    expect(core.postRecordingEnded).toHaveBeenCalledWith('channel-empty')
    expect(onStopped).toHaveBeenCalledTimes(1)
  })

  it('a platform-issued stop reports control-stop', async () => {
    const { core, controller } = await started(['u1'])
    await controller.stop()
    expect(core.postRecordingEnded).toHaveBeenCalledWith('control-stop')
  })

  it('self-host never reports home, but still releases via onStopped', async () => {
    const { core, onStopped, controller } = await started(['u1'], { cfg: undefined })
    await controller.stop('channel-empty')
    expect(core.postRecordingEnded).not.toHaveBeenCalled()
    expect(onStopped).toHaveBeenCalledWith('channel-empty')
  })

  it('no lifecycle timer can fire a second stop once the pipeline has started', async () => {
    const { core, controller } = await started([])
    await jest.advanceTimersByTimeAsync(TIMINGS.emptyPromptMs) // prompt up, end timer armed
    await controller.stop('control-stop')
    await jest.advanceTimersByTimeAsync(TIMINGS.emptyEndMs * 2)
    await settle()
    expect(core.postRecordingEnded).toHaveBeenCalledTimes(1)
    expect(core.postRecordingEnded).toHaveBeenCalledWith('control-stop')
  })

  it('surfaces the lifecycle in describe() for ops', async () => {
    const scheduledEndAt = new Date(Date.now() + 60_000)
    const { controller } = await started(['u1'], { scheduledEndAt, discordEventId: 'evt-1' })
    expect(controller.describe()).toMatchObject({
      scheduledEndAt: scheduledEndAt.toISOString(),
      discordEventId: 'evt-1',
      humansPresent: 1,
      endPromptPosted: false,
      stopReason: null,
    })
  })
})
