/**
 * Which consent clicks are worth REMEMBERING.
 *
 * The prompt offers "🔁 Yes, and remember — voice is captured for this session
 * AND future sessions in this channel." The container used to collapse
 * `consent_remember` into a plain `consent` at the interaction handler, on the
 * grounds that core-server's webhook did the persistent write. True
 * CFG-hosted; false self-host, which has no webhook — so the button silently
 * did nothing there.
 *
 * The rule below is copied from core's `handleConsentButton` rather than
 * re-derived. A self-hoster and a CFG user reading the same label must get the
 * same behaviour, so these tests are the guard against the two drifting.
 */

import { ConsentManager } from '../../../src/consent/consent-manager.js'

const TEXT = 'text-222'
const THREAD = 'thread-333'
const KEY = 'rec-1'

function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(function (this: unknown) {
      return this
    }),
  } as never
}

function makeHarness() {
  /** The manager's `interactionCreate` handler, captured at construction. */
  let handler: ((interaction: unknown) => void) | null = null

  const channels: Record<string, unknown> = {
    [THREAD]: {
      isThread: () => true,
      isSendable: () => true,
      members: { add: jest.fn(async () => undefined) },
      send: jest.fn(async () => ({ id: 'msg-thread' })),
    },
    [TEXT]: { isSendable: () => true, send: jest.fn(async () => ({ id: 'msg-text' })) },
  }

  const client = {
    on: jest.fn((event: string, fn: (i: unknown) => void) => {
      if (event === 'interactionCreate') handler = fn
    }),
    off: jest.fn(),
    channels: { fetch: jest.fn(async (id: string) => channels[id] ?? null) },
  } as never

  const decisions: Array<{ userId: string; status: string }> = []

  const mgr = new ConsentManager({
    recordingId: 'rec-1',
    buttonKey: KEY,
    client,
    textChannelId: TEXT,
    threadId: THREAD,
    logger: makeLogger(),
  })
  mgr.onPersistentDecision((userId, status) => decisions.push({ userId, status }))

  /** Fire a consent button as `userId`, optionally against another session's key. */
  async function click(action: string, userId = 'user-1', key = KEY) {
    handler?.({
      isButton: () => true,
      customId: `${action}:${key}`,
      user: { id: userId },
      deferReply: jest.fn(async () => undefined),
      editReply: jest.fn(async () => undefined),
    })
    // Let the async handler settle.
    await new Promise((r) => setTimeout(r, 0))
  }

  return { mgr, decisions, click }
}

describe('ConsentManager — persistent decisions mirror core handleConsentButton', () => {
  it('"Yes, and remember" persists an opt-in', async () => {
    const h = makeHarness()
    await h.click('consent_remember')

    expect(h.decisions).toEqual([{ userId: 'user-1', status: 'opted-in' }])
    // ...and still grants audio for this session, exactly like plain consent.
    expect(h.mgr.isConsented('user-1')).toBe(true)
  })

  it('"Yes, this time only" persists NOTHING', async () => {
    const h = makeHarness()
    await h.click('consent')

    // They get re-prompted next session — that is what "this time only" means.
    expect(h.decisions).toEqual([])
    expect(h.mgr.isConsented('user-1')).toBe(true)
  })

  it('"Skip my voice" ALWAYS persists an opt-out, with no remember variant', async () => {
    const h = makeHarness()
    await h.click('decline')

    // Core writes the opt-out unconditionally on decline, so someone who has
    // said no is not asked again next session.
    expect(h.decisions).toEqual([{ userId: 'user-1', status: 'opted-out' }])
    expect(h.mgr.isConsented('user-1')).toBe(false)
  })

  it('records each user separately', async () => {
    const h = makeHarness()
    await h.click('consent_remember', 'user-1')
    await h.click('decline', 'user-2')
    await h.click('consent', 'user-3')

    expect(h.decisions).toEqual([
      { userId: 'user-1', status: 'opted-in' },
      { userId: 'user-2', status: 'opted-out' },
    ])
  })

  it('ignores a click carrying another session’s button key', async () => {
    const h = makeHarness()
    // Two recordings can be live in different guilds; each manager must only
    // answer its own buttons, or one session's click flips another's consent.
    await h.click('consent_remember', 'user-1', 'some-other-recording')

    expect(h.decisions).toEqual([])
    expect(h.mgr.isConsented('user-1')).toBe(false)
  })

  it('ignores an unrecognised action', async () => {
    const h = makeHarness()
    await h.click('definitely_not_a_consent_action')

    expect(h.decisions).toEqual([])
    expect(h.mgr.isConsented('user-1')).toBe(false)
  })
})
