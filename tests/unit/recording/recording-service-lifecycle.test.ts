/**
 * RecordingService — how the lifecycle is wired through the façade.
 *
 *   - `scheduledEndAt` / `discordEventId` reach the controller (parsed);
 *     garbage parses to "none", never to an Invalid Date.
 *   - a stop the WORKER decided on (the controller's `onStopped`) releases the
 *     registry slot, so /healthz stops counting it and the guild is free to
 *     record again — the exact state that stranded the 2026-08-26 session.
 *   - `stop()` is a `control-stop`, `stopAll()` a `shutdown`, `promptEnd()`
 *     routes to the controller and 404s an unknown recording.
 */

type CapturedController = {
  params: Record<string, unknown>
  stop: jest.Mock
  promptEnd: jest.Mock
}
const controllers: CapturedController[] = []

jest.mock('../../../src/recording/session-controller.js', () => ({
  SessionController: jest.fn().mockImplementation((params: Record<string, unknown>) => {
    const c: CapturedController & Record<string, unknown> = {
      params,
      recordingId: params.recordingId,
      guildId: params.guildId,
      start: jest.fn(async () => undefined),
      stop: jest.fn(async () => undefined),
      promptEnd: jest.fn(async () => undefined),
      describe: jest.fn(() => ({ recordingId: params.recordingId })),
    }
    controllers.push(c)
    return c
  }),
}))

import {
  RecordingService,
  GuildConflictError,
  SessionNotFoundError,
  parseScheduledEndAt,
} from '../../../src/recording/recording-service.js'
import { testSettingsStore } from '../../_lib/settings.js'

const silentLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(),
} as never
;(silentLogger as { child: jest.Mock }).child.mockReturnValue(silentLogger)

function service() {
  const client = { isReady: () => true, user: { id: 'bot-self' } } as never
  const config = {
    deepgramMode: 'disabled',
    deepgramKey: null,
    deepgramModel: 'nova-3',
    deepgramLanguage: 'en',
    chunkMinutes: 0,
    keepPcm: false,
    outputDir: '/tmp',
    consentStorePath: '/tmp/consent.json',
    cfg: undefined,
  } as never
  return new RecordingService(client, {} as never, config, silentLogger, testSettingsStore())
}

beforeEach(() => {
  controllers.length = 0
  jest.clearAllMocks()
})

describe('parseScheduledEndAt', () => {
  it('parses an ISO instant', () => {
    expect(parseScheduledEndAt('2026-09-02T03:30:00.000Z')?.toISOString()).toBe('2026-09-02T03:30:00.000Z')
  })
  it.each([undefined, '', 'not a date', '2026-13-45'])('%p is "none"', (raw) => {
    expect(parseScheduledEndAt(raw as string | undefined)).toBeNull()
  })
})

describe('RecordingService lifecycle wiring', () => {
  it('hands the controller the parsed scheduled end + event id', async () => {
    const svc = service()
    await svc.start({ guildId: 'g1', voiceChannelId: 'vc1', scheduledEndAt: '2026-09-02T03:30:00Z', discordEventId: 'evt-1' })
    const p = controllers[0]!.params
    expect((p.scheduledEndAt as Date).toISOString()).toBe('2026-09-02T03:30:00.000Z')
    expect(p.discordEventId).toBe('evt-1')
  })

  it('an absent scheduled end is null, not an Invalid Date', async () => {
    const svc = service()
    await svc.start({ guildId: 'g1', voiceChannelId: 'vc1' })
    expect(controllers[0]!.params.scheduledEndAt).toBeNull()
    expect(controllers[0]!.params.discordEventId).toBeNull()
  })

  it('a worker-decided stop releases the registry slot: /healthz drops to 0 and the guild can record again', async () => {
    const svc = service()
    await svc.start({ guildId: 'g1', voiceChannelId: 'vc1' })
    expect(svc.activeCount).toBe(1)
    // Without the release this is exactly the stranded state: the same guild
    // is refused because the finished recording still holds the slot.
    await expect(svc.start({ guildId: 'g1', voiceChannelId: 'vc1' })).rejects.toBeInstanceOf(GuildConflictError)

    const onStopped = controllers[0]!.params.onStopped as (reason: string) => void
    onStopped('bot-disconnected')
    expect(svc.activeCount).toBe(0)

    await expect(svc.start({ guildId: 'g1', voiceChannelId: 'vc1' })).resolves.toBeDefined()
    expect(svc.activeCount).toBe(1)
  })

  it('stop() is a control-stop; stopAll() is a shutdown', async () => {
    const svc = service()
    const id = await svc.start({ guildId: 'g1', voiceChannelId: 'vc1' })
    await svc.stop(id)
    expect(controllers[0]!.stop).toHaveBeenCalledWith('control-stop')

    const id2 = await svc.start({ guildId: 'g2', voiceChannelId: 'vc2' })
    await svc.stopAll()
    expect(controllers[1]!.stop).toHaveBeenCalledWith('shutdown')
    expect(svc.describe(id2)).toBeNull()
  })

  it('promptEnd() routes to the controller as an event-ended prompt, and 404s an unknown recording', async () => {
    const svc = service()
    const id = await svc.start({ guildId: 'g1', voiceChannelId: 'vc1' })
    await svc.promptEnd(id)
    expect(controllers[0]!.promptEnd).toHaveBeenCalledWith('event-ended')
    await expect(svc.promptEnd('nope')).rejects.toBeInstanceOf(SessionNotFoundError)
  })
})
