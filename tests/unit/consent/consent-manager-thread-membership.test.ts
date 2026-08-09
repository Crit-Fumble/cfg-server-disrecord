/**
 * ConsentManager thread membership — a late joiner is added to the private
 * recording thread because they are IN THE ROOM, not because they happened to
 * need a consent prompt.
 *
 * The bug this pins: adding-to-thread used to happen only as a side effect of
 * `tryPostToThread`, i.e. only for users who got prompted. `noteSpeaker`
 * returns early for anyone already decided, and `ConsentSync.seedFromPolicy`
 * marks every holder of a persistent channel-level opt-in as consented at
 * session start. So the one population that is never prompted — the users who
 * opted in permanently — was also never added to the thread, and silently lost
 * access to the transcript and mp3 of a session they were recorded in.
 */

import { ConsentManager } from '../../../src/consent/consent-manager.js'

const TEXT = 'text-222'
const THREAD = 'thread-333'

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
  const threadAdd = jest.fn(async () => undefined)
  const threadSend = jest.fn(async () => ({ id: 'msg-thread' }))
  const textSend = jest.fn(async () => ({ id: 'msg-text' }))

  const channels: Record<string, unknown> = {
    [THREAD]: {
      isThread: () => true,
      isSendable: () => true,
      members: { add: threadAdd },
      send: threadSend,
    },
    [TEXT]: { isSendable: () => true, send: textSend },
  }

  const client = {
    on: jest.fn(),
    off: jest.fn(),
    channels: { fetch: jest.fn(async (id: string) => channels[id] ?? null) },
  } as never

  return { threadAdd, threadSend, textSend, client }
}

function flush() {
  return new Promise((r) => setTimeout(r, 0))
}

/** Ids the thread-add mock was called with, in order. */
function addedIds(threadAdd: jest.Mock): string[] {
  return threadAdd.mock.calls.map((c) => c[0] as string)
}

describe('ConsentManager — late joiners are added to the recording thread', () => {
  it('adds a PRE-CONSENTED late joiner, who is never prompted', async () => {
    const h = makeHarness()
    const mgr = new ConsentManager({
      recordingId: 'rec-1',
      buttonKey: 'rec-1',
      client: h.client,
      textChannelId: TEXT,
      threadId: THREAD,
      // What seedFromPolicy does for a persistent channel-level opt-in.
      initialConsented: ['opted-in-user'],
      logger: makeLogger(),
    })

    mgr.noteSpeaker('opted-in-user')
    await flush()

    expect(addedIds(h.threadAdd)).toContain('opted-in-user')
    // Still not prompted — they already decided. Only the thread add is new.
    expect(h.threadSend).not.toHaveBeenCalled()
    expect(h.textSend).not.toHaveBeenCalled()
  })

  it('adds a late joiner who already DECLINED', async () => {
    const h = makeHarness()
    const mgr = new ConsentManager({
      recordingId: 'rec-1',
      buttonKey: 'rec-1',
      client: h.client,
      textChannelId: TEXT,
      threadId: THREAD,
      logger: makeLogger(),
    })
    mgr.applyDecline('declined-user')

    mgr.noteSpeaker('declined-user')
    await flush()

    // Presence in the room is the key to the room's artifact — the same rule
    // `createRecordingThread` follows at session start, where every voice
    // member is invited regardless of their consent decision. Their audio is
    // still excluded from the recording; that is a separate axis.
    expect(addedIds(h.threadAdd)).toContain('declined-user')
    expect(h.threadSend).not.toHaveBeenCalled()
  })

  it('still prompts AND adds an undecided late joiner', async () => {
    const h = makeHarness()
    const mgr = new ConsentManager({
      recordingId: 'rec-1',
      buttonKey: 'rec-1',
      client: h.client,
      textChannelId: TEXT,
      threadId: THREAD,
      logger: makeLogger(),
    })

    mgr.noteSpeaker('new-user')
    await flush()

    expect(addedIds(h.threadAdd)).toContain('new-user')
    expect(h.threadSend).toHaveBeenCalledTimes(1)
  })

  it('adds each user once, however many speaking events they produce', async () => {
    const h = makeHarness()
    const mgr = new ConsentManager({
      recordingId: 'rec-1',
      buttonKey: 'rec-1',
      client: h.client,
      textChannelId: TEXT,
      threadId: THREAD,
      initialConsented: ['opted-in-user'],
      logger: makeLogger(),
    })

    // noteSpeaker fires on every speaking event, not just the first.
    mgr.noteSpeaker('opted-in-user')
    await flush()
    mgr.noteSpeaker('opted-in-user')
    mgr.noteSpeaker('opted-in-user')
    await flush()

    expect(addedIds(h.threadAdd).filter((id) => id === 'opted-in-user')).toHaveLength(1)
  })

  it('does not re-add members the thread was created with', async () => {
    const h = makeHarness()
    const mgr = new ConsentManager({
      recordingId: 'rec-1',
      buttonKey: 'rec-1',
      client: h.client,
      textChannelId: TEXT,
      threadId: THREAD,
      initialConsented: ['member-at-start'],
      logger: makeLogger(),
    })
    // createRecordingThread already invited them.
    mgr.markThreadMembers(['member-at-start'])

    mgr.noteSpeaker('member-at-start')
    await flush()

    expect(h.threadAdd).not.toHaveBeenCalled()
  })

  it('queues a join that lands during the thread-creation window, then adds on flush', async () => {
    const h = makeHarness()
    const mgr = new ConsentManager({
      recordingId: 'rec-1',
      buttonKey: 'rec-1',
      client: h.client,
      textChannelId: TEXT,
      threadId: null,
      initialConsented: ['early-user'],
      logger: makeLogger(),
    })
    mgr.expectThread()

    mgr.noteSpeaker('early-user')
    await flush()
    // Thread doesn't exist yet — nothing to join.
    expect(h.threadAdd).not.toHaveBeenCalled()

    mgr.setThreadId(THREAD)
    await flush()

    expect(addedIds(h.threadAdd)).toContain('early-user')
  })

  it('drops the queue when thread creation failed, without throwing', async () => {
    const h = makeHarness()
    const mgr = new ConsentManager({
      recordingId: 'rec-1',
      buttonKey: 'rec-1',
      client: h.client,
      textChannelId: TEXT,
      threadId: null,
      initialConsented: ['early-user'],
      logger: makeLogger(),
    })
    mgr.expectThread()
    mgr.noteSpeaker('early-user')
    await flush()

    mgr.setThreadId(null)
    await flush()

    // No thread to join. The session falls back to the parent channel, which
    // is the path a no-thread session always took.
    expect(h.threadAdd).not.toHaveBeenCalled()
  })

  it('addThreadMembers adds everyone handed to it — the thread-REUSE path', async () => {
    const h = makeHarness()
    const mgr = new ConsentManager({
      recordingId: 'rec-1',
      buttonKey: 'rec-1',
      client: h.client,
      textChannelId: TEXT,
      threadId: THREAD,
      logger: makeLogger(),
    })

    // Stop/restart within a session reuses the thread, so nothing invited
    // anyone this start — including whoever joined during the gap.
    mgr.addThreadMembers(['was-here-before', 'joined-during-the-gap'])
    await flush()

    expect(addedIds(h.threadAdd).sort()).toEqual(['joined-during-the-gap', 'was-here-before'])
  })

  it('a member-add failure never blocks the consent prompt', async () => {
    const h = makeHarness()
    h.threadAdd.mockRejectedValue(new Error('user left the guild'))
    const mgr = new ConsentManager({
      recordingId: 'rec-1',
      buttonKey: 'rec-1',
      client: h.client,
      textChannelId: TEXT,
      threadId: THREAD,
      logger: makeLogger(),
    })

    mgr.noteSpeaker('gone-user')
    await flush()

    // The add failed; the prompt still went out.
    expect(h.threadSend).toHaveBeenCalledTimes(1)
    expect(mgr.isConsented('gone-user')).toBe(false)
  })
})
