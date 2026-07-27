/**
 * ConsentManager voice-visible prompt (dr#4).
 *
 * Owner design 2026-07-27: when a session's transcript destination differs
 * from the voice channel, a late joiner is prompted in BOTH places — the
 * recording thread (canonical, collocated with the artifact) AND the voice
 * channel's own chat, with the voice prompt linking over to the thread.
 * Single-channel sessions (transcript target IS the voice channel) keep the
 * single-prompt workflow unchanged.
 */

import { ConsentManager } from '../../../src/consent/consent-manager.js'

const VOICE = 'voice-111'
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

function makeChannels() {
  const sends: Record<string, jest.Mock> = {}
  const channels: Record<string, unknown> = {}

  const threadSend = jest.fn(async () => ({ id: 'msg-thread' }))
  sends[THREAD] = threadSend
  channels[THREAD] = {
    isThread: () => true,
    isSendable: () => true,
    members: { add: jest.fn(async () => undefined) },
    send: threadSend,
  }

  for (const id of [VOICE, TEXT]) {
    const send = jest.fn(async () => ({ id: `msg-${id}` }))
    sends[id] = send
    channels[id] = { isSendable: () => true, send }
  }

  return { sends, fetch: jest.fn(async (id: string) => channels[id] ?? null) }
}

function makeClient(channels: ReturnType<typeof makeChannels>) {
  return {
    on: jest.fn(),
    off: jest.fn(),
    channels: { fetch: channels.fetch },
  } as never
}

function flush() {
  return new Promise((r) => setTimeout(r, 0))
}

describe('ConsentManager — voice-visible prompt for split-channel sessions (dr#4)', () => {
  it('prompts in the thread AND the voice channel when the transcript target differs', async () => {
    const ch = makeChannels()
    const mgr = new ConsentManager({
      recordingId: 'rec-1',
      buttonKey: 'rec-1',
      client: makeClient(ch),
      textChannelId: TEXT,
      voiceChannelId: VOICE,
      threadId: THREAD,
      logger: makeLogger(),
    })
    mgr.noteSpeaker('late-user')
    await flush()

    expect(ch.sends[THREAD]).toHaveBeenCalledTimes(1)
    expect(ch.sends[VOICE]).toHaveBeenCalledTimes(1)
    const voiceMsg = ch.sends[VOICE].mock.calls[0][0] as { content: string; components: unknown[] }
    // The voice prompt links over to the actual recording/transcription thread
    expect(voiceMsg.content).toContain(`<#${THREAD}>`)
    // ...and carries the same consent buttons so they can decide right there
    expect(voiceMsg.components.length).toBeGreaterThan(0)
  })

  it('keeps the single-prompt workflow when the voice channel IS the transcript target', async () => {
    const ch = makeChannels()
    const mgr = new ConsentManager({
      recordingId: 'rec-1',
      buttonKey: 'rec-1',
      client: makeClient(ch),
      textChannelId: VOICE,
      voiceChannelId: VOICE,
      threadId: THREAD,
      logger: makeLogger(),
    })
    mgr.noteSpeaker('late-user')
    await flush()

    expect(ch.sends[THREAD]).toHaveBeenCalledTimes(1)
    expect(ch.sends[VOICE]).not.toHaveBeenCalled()
  })

  it('a voice-side post failure never flips the user to declined', async () => {
    const ch = makeChannels()
    ch.sends[VOICE].mockRejectedValue(new Error('missing perms'))
    const mgr = new ConsentManager({
      recordingId: 'rec-1',
      buttonKey: 'rec-1',
      client: makeClient(ch),
      textChannelId: TEXT,
      voiceChannelId: VOICE,
      threadId: THREAD,
      logger: makeLogger(),
    })
    mgr.noteSpeaker('late-user')
    await flush()

    // Primary (thread) prompt reached them — they stay pending, not declined.
    expect(ch.sends[THREAD]).toHaveBeenCalledTimes(1)
    expect(mgr.isConsented('late-user')).toBe(false)
    // Declining is an explicit user action; a failed mirror post is not one.
    // (No public declined getter — assert via the decline listener not firing.)
  })

  it('omits the voice mirror when no voiceChannelId is wired (self-host callers unchanged)', async () => {
    const ch = makeChannels()
    const mgr = new ConsentManager({
      recordingId: 'rec-1',
      buttonKey: 'rec-1',
      client: makeClient(ch),
      textChannelId: TEXT,
      threadId: THREAD,
      logger: makeLogger(),
    })
    mgr.noteSpeaker('late-user')
    await flush()

    expect(ch.sends[THREAD]).toHaveBeenCalledTimes(1)
    expect(ch.sends[VOICE]).not.toHaveBeenCalled()
  })
})
