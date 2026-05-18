/**
 * @jest-environment node
 */

/**
 * Unit tests for src/worker.ts — the per-session orchestrator.
 *
 * Coverage targets (none of which had direct tests before):
 *   - Session policy fetch → RecordingSession + VoiceReceiver wired with
 *     the consent set, speaker names, keywords/keyterms from policy.
 *   - Billing tick timer: fires every 15 min while NOT paused, skips
 *     while paused (and slides lastTickAt so the resume-side tick doesn't
 *     bill for the paused interval).
 *   - SIGTERM / SIGINT shutdown: receiver aborted, session.stop() called,
 *     final billing tick emitted for the accumulated minutes.
 *   - Receiver.run() throwing: stopReason set to 'receiver-error',
 *     teardown still fires, final tick still posted.
 *
 * Strategy: @swc/jest doesn't hoist `jest.mock()` for relative-path
 * targets (confirmed via probe — the factory never runs and the real
 * module loads via the relative import). So we use `jest.doMock` + a
 * fresh `require()` of src/worker per test, which bypasses hoisting
 * entirely and re-evaluates the module graph against the doMocks
 * registered in beforeEach.
 *
 * Process signals are captured via a process.on spy so we don't pollute
 * the live process listener table.
 */

import { jest } from '@jest/globals'

let mockCoreServerClient: {
  fetchSessionPolicy: jest.Mock<() => Promise<unknown>>
  postTranscript: jest.Mock<(...args: unknown[]) => Promise<void>>
  postBillingTick: jest.Mock<(...args: unknown[]) => Promise<void>>
}

let mockRecordingSessionInstances: any[]
let mockLastRecordingSessionParams: any
let mockVoiceReceiverInstances: any[]
let mockLastVoiceReceiverParams: any

function installMocks() {
  mockCoreServerClient = {
    fetchSessionPolicy: jest.fn<() => Promise<unknown>>(),
    postTranscript: jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
    postBillingTick: jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
  }
  mockRecordingSessionInstances = []
  mockLastRecordingSessionParams = null
  mockVoiceReceiverInstances = []
  mockLastVoiceReceiverParams = null

  jest.doMock('../../src/worker/core-server-client', () => ({
    CoreServerClient: jest.fn().mockImplementation(() => mockCoreServerClient),
  }))

  jest.doMock('../../src/worker/recording-session', () => ({
    RecordingSession: jest.fn().mockImplementation((params: any) => {
      mockLastRecordingSessionParams = params
      const inst: any = {
        paused: false,
        setPaused(p: boolean) {
          this.paused = p
        },
        stop: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      }
      mockRecordingSessionInstances.push(inst)
      return inst
    }),
  }))

  jest.doMock('../../src/worker/voice-receiver', () => ({
    VoiceReceiver: jest.fn().mockImplementation((params: any) => {
      mockLastVoiceReceiverParams = params
      let runResolver: ((v: void) => void) | null = null
      let runRejector: ((e: unknown) => void) | null = null
      const runPromise = new Promise<void>((resolve, reject) => {
        runResolver = resolve
        runRejector = reject
      })
      const inst: any = {
        run: jest.fn<() => Promise<void>>().mockReturnValue(runPromise),
        destroy: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        __resolveRun: () => runResolver?.(),
        __rejectRun: (err: unknown) => runRejector?.(err),
      }
      mockVoiceReceiverInstances.push(inst)
      return inst
    }),
  }))
}

/** Load src/worker fresh against the current doMock registry. */
function loadWorker(): typeof import('../../src/worker') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../src/worker')
}

const BASE_CONFIG = {
  installationId: 'inst-1',
  guildId: 'guild-1',
  channelId: 'channel-1',
  coreServerUrl: 'http://core:3001',
  coreServerToken: 'jwt-token',
  deepgramKey: 'dg-key',
  deepgramMode: 'enabled' as const,
  size: 'small' as const,
  ctPerMinute: 7,
} as any

const BASE_POLICY = {
  consentedUserIds: ['u1', 'u2'],
  speakerNames: { u1: 'Alice', u2: 'Bob' },
  keywords: ['Eldritch'],
  keyterms: ['Whispering Cabal'],
}

function spyOnProcessSignals() {
  const handlers: Record<string, Array<(...a: any[]) => void>> = {}
  const original = process.on.bind(process)
  jest.spyOn(process, 'on').mockImplementation(((event: string, handler: any) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      handlers[event] = handlers[event] ?? []
      handlers[event].push(handler)
      return process
    }
    return original(event as any, handler)
  }) as any)
  return {
    fire(event: 'SIGTERM' | 'SIGINT') {
      for (const h of handlers[event] ?? []) h(event)
    },
    handlerCount(event: 'SIGTERM' | 'SIGINT'): number {
      return handlers[event]?.length ?? 0
    },
  }
}

/** Microtask drain so chained promises in startWorker can advance. */
async function tickMicrotasks(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe('startWorker', () => {
  beforeEach(() => {
    jest.resetModules()
    installMocks()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
    jest.dontMock('../../src/worker/core-server-client')
    jest.dontMock('../../src/worker/recording-session')
    jest.dontMock('../../src/worker/voice-receiver')
  })

  // ── 1. policy fetch + collaborator wiring ────────────────────────────

  it('fetches session policy and wires RecordingSession with consent + names + keywords + keyterms', async () => {
    mockCoreServerClient.fetchSessionPolicy.mockResolvedValueOnce(BASE_POLICY)
    const signals = spyOnProcessSignals()
    const { startWorker } = loadWorker()

    const done = startWorker(BASE_CONFIG)
    await tickMicrotasks()

    expect(mockCoreServerClient.fetchSessionPolicy).toHaveBeenCalledTimes(1)
    expect(mockRecordingSessionInstances).toHaveLength(1)
    expect(mockVoiceReceiverInstances).toHaveLength(1)

    // RecordingSession got the right policy values.
    expect(mockLastRecordingSessionParams.deepgramApiKey).toBe('dg-key')
    expect(Array.from(mockLastRecordingSessionParams.consentedUserIds)).toEqual(['u1', 'u2'])
    expect(mockLastRecordingSessionParams.keywords).toEqual(['Eldritch'])
    expect(mockLastRecordingSessionParams.keyterms).toEqual(['Whispering Cabal'])

    // resolveSpeakerName returns the policy's display name when present,
    // falls back to the user-id when not — matches the legacy behavior.
    await expect(mockLastRecordingSessionParams.resolveSpeakerName('u1')).resolves.toBe('Alice')
    await expect(mockLastRecordingSessionParams.resolveSpeakerName('u-unknown')).resolves.toBe('u-unknown')

    // VoiceReceiver got the same session instance + the URL config.
    expect(mockLastVoiceReceiverParams.session).toBe(mockRecordingSessionInstances[0])
    expect(mockLastVoiceReceiverParams.coreServerUrl).toBe('http://core:3001')
    expect(mockLastVoiceReceiverParams.installationId).toBe('inst-1')

    expect(signals.handlerCount('SIGTERM')).toBe(1)
    expect(signals.handlerCount('SIGINT')).toBe(1)

    mockVoiceReceiverInstances[0].__resolveRun()
    await done
  })

  it('passes deepgramApiKey=null when deepgramMode is "disabled"', async () => {
    mockCoreServerClient.fetchSessionPolicy.mockResolvedValueOnce(BASE_POLICY)
    spyOnProcessSignals()
    const { startWorker } = loadWorker()

    const done = startWorker({ ...BASE_CONFIG, deepgramMode: 'disabled' })
    await tickMicrotasks()

    expect(mockLastRecordingSessionParams.deepgramApiKey).toBeNull()

    mockVoiceReceiverInstances[0].__resolveRun()
    await done
  })

  // ── 2. billing tick cadence ──────────────────────────────────────────

  it('fires billing tick every 15 minutes while NOT paused', async () => {
    jest.useFakeTimers()
    mockCoreServerClient.fetchSessionPolicy.mockResolvedValueOnce(BASE_POLICY)
    spyOnProcessSignals()
    const { startWorker } = loadWorker()

    const done = startWorker(BASE_CONFIG)
    await tickMicrotasks()

    expect(mockCoreServerClient.postBillingTick).not.toHaveBeenCalled()

    await jest.advanceTimersByTimeAsync(15 * 60_000)
    expect(mockCoreServerClient.postBillingTick).toHaveBeenCalledTimes(1)
    const firstCall = mockCoreServerClient.postBillingTick.mock.calls[0][0] as any
    expect(firstCall.resourceType).toBe('bot_container')
    expect(firstCall.ctPerMinute).toBe(7)
    expect(firstCall.minutes).toBeCloseTo(15, 0)

    await jest.advanceTimersByTimeAsync(15 * 60_000)
    expect(mockCoreServerClient.postBillingTick).toHaveBeenCalledTimes(2)

    mockVoiceReceiverInstances[0].__resolveRun()
    jest.useRealTimers()
    await done
  })

  it('skips billing ticks while session is paused and does not over-bill on resume', async () => {
    jest.useFakeTimers()
    mockCoreServerClient.fetchSessionPolicy.mockResolvedValueOnce(BASE_POLICY)
    spyOnProcessSignals()
    const { startWorker } = loadWorker()

    const done = startWorker(BASE_CONFIG)
    await tickMicrotasks()

    const session = mockRecordingSessionInstances[0]

    // 15 min active → 1 tick
    await jest.advanceTimersByTimeAsync(15 * 60_000)
    expect(mockCoreServerClient.postBillingTick).toHaveBeenCalledTimes(1)

    // Pause and pass 30 min → no new tick
    session.paused = true
    await jest.advanceTimersByTimeAsync(30 * 60_000)
    expect(mockCoreServerClient.postBillingTick).toHaveBeenCalledTimes(1)

    // Resume + 15 min → one more tick, billed for ~15 min (not 45) —
    // lastTickAt slid forward during pause.
    session.paused = false
    await jest.advanceTimersByTimeAsync(15 * 60_000)
    expect(mockCoreServerClient.postBillingTick).toHaveBeenCalledTimes(2)
    const resumeCall = mockCoreServerClient.postBillingTick.mock.calls[1][0] as any
    expect(resumeCall.minutes).toBeLessThan(20)

    mockVoiceReceiverInstances[0].__resolveRun()
    jest.useRealTimers()
    await done
  })

  // ── 3. shutdown paths ────────────────────────────────────────────────

  it('on SIGTERM: aborts receiver, stops session, posts a final billing tick', async () => {
    jest.useFakeTimers()
    mockCoreServerClient.fetchSessionPolicy.mockResolvedValueOnce(BASE_POLICY)
    const signals = spyOnProcessSignals()
    const { startWorker } = loadWorker()

    const done = startWorker(BASE_CONFIG)
    await tickMicrotasks()

    // 7 min in — not enough for a periodic tick, so the final tick is
    // the only one and bills for ~7 min.
    await jest.advanceTimersByTimeAsync(7 * 60_000)
    expect(mockCoreServerClient.postBillingTick).not.toHaveBeenCalled()

    signals.fire('SIGTERM')
    jest.useRealTimers()
    await done

    expect(mockVoiceReceiverInstances[0].destroy).toHaveBeenCalledTimes(1)
    expect(mockRecordingSessionInstances[0].stop).toHaveBeenCalledTimes(1)
    expect(mockCoreServerClient.postBillingTick).toHaveBeenCalledTimes(1)
    const finalCall = mockCoreServerClient.postBillingTick.mock.calls[0][0] as any
    expect(finalCall.label).toMatch(/final/)
    expect(finalCall.minutes).toBeGreaterThan(0)
    expect(finalCall.minutes).toBeLessThan(15)
  })

  it('on SIGINT: same teardown path as SIGTERM', async () => {
    mockCoreServerClient.fetchSessionPolicy.mockResolvedValueOnce(BASE_POLICY)
    const signals = spyOnProcessSignals()
    const { startWorker } = loadWorker()

    const done = startWorker(BASE_CONFIG)
    await tickMicrotasks()

    signals.fire('SIGINT')
    await done

    expect(mockVoiceReceiverInstances[0].destroy).toHaveBeenCalledTimes(1)
    expect(mockRecordingSessionInstances[0].stop).toHaveBeenCalledTimes(1)
  })

  it('when receiver.run() rejects: still posts final tick + tears down cleanly', async () => {
    mockCoreServerClient.fetchSessionPolicy.mockResolvedValueOnce(BASE_POLICY)
    spyOnProcessSignals()
    const { startWorker } = loadWorker()

    const done = startWorker(BASE_CONFIG)
    await tickMicrotasks()

    mockVoiceReceiverInstances[0].__rejectRun(new Error('SSE stream died'))
    await done

    expect(mockVoiceReceiverInstances[0].destroy).toHaveBeenCalledTimes(1)
    expect(mockRecordingSessionInstances[0].stop).toHaveBeenCalledTimes(1)
    expect(mockCoreServerClient.postBillingTick).toHaveBeenCalledTimes(1)
    const finalCall = mockCoreServerClient.postBillingTick.mock.calls[0][0] as any
    expect(finalCall.label).toMatch(/final/)
  })

  it('when receiver completes normally (SSE session-end): teardown + final tick fire', async () => {
    jest.useFakeTimers()
    mockCoreServerClient.fetchSessionPolicy.mockResolvedValueOnce(BASE_POLICY)
    spyOnProcessSignals()
    const { startWorker } = loadWorker()

    const done = startWorker(BASE_CONFIG)
    await tickMicrotasks()

    // Let some time pass so the final-tick `finalMinutes > 0` guard
    // actually fires. Without this, the test races microtask completion
    // before Date.now() advances and the final tick is silently skipped
    // — which is real worker behavior, just not what we want to assert
    // on this code path.
    await jest.advanceTimersByTimeAsync(2 * 60_000)

    mockVoiceReceiverInstances[0].__resolveRun()
    jest.useRealTimers()
    await done

    expect(mockVoiceReceiverInstances[0].destroy).toHaveBeenCalledTimes(1)
    expect(mockRecordingSessionInstances[0].stop).toHaveBeenCalledTimes(1)
    expect(mockCoreServerClient.postBillingTick).toHaveBeenCalledTimes(1)
  })
})
