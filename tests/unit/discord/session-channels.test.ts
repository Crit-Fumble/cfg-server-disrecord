/**
 * A recording's text channel and reused thread are held to its own guild
 * (session-channels.ts): another guild's is refused before anything is posted,
 * one the bot cannot read is never used.
 */

import { ChannelOutsideGuildError, resolveSessionChannels } from '../../../src/discord/session-channels.js'

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never

const GUILD = 'guild-a'

/** Channels the fake client knows: id → its guild (null for a DM). Anything else fails to fetch. */
function client(known: Record<string, string | null>, opts: { returnsNull?: string[] } = {}) {
  const fetch = jest.fn(async (id: string) => {
    if (opts.returnsNull?.includes(id)) return null
    if (!(id in known)) throw new Error('Unknown Channel')
    const guildId = known[id]
    return guildId === null ? { id, type: 1 } : { id, type: 0, guildId }
  })
  return { client: { channels: { fetch } } as never, fetch }
}

function req(over: Partial<{ textChannelId: string; threadId: string | null }> = {}) {
  return { guildId: GUILD, voiceChannelId: 'vc-1', textChannelId: 'tc-1', threadId: null, ...over }
}

beforeEach(() => jest.clearAllMocks())

describe('resolveSessionChannels', () => {
  it('keeps a text channel and a thread of the same guild', async () => {
    const { client: c } = client({ 'tc-1': GUILD, 'th-1': GUILD })
    await expect(resolveSessionChannels(c, req({ threadId: 'th-1' }), logger)).resolves.toEqual({
      textChannelId: 'tc-1',
      threadId: 'th-1',
    })
  })

  it("refuses a text channel of another guild", async () => {
    const { client: c } = client({ 'tc-1': 'guild-b' })
    const err = await resolveSessionChannels(c, req(), logger).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ChannelOutsideGuildError)
    expect((err as ChannelOutsideGuildError).channel).toBe('text channel')
  })

  it("refuses a thread of another guild, even under the session's own text channel", async () => {
    const { client: c } = client({ 'tc-1': GUILD, 'th-1': 'guild-b' })
    const err = await resolveSessionChannels(c, req({ threadId: 'th-1' }), logger).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ChannelOutsideGuildError)
    expect((err as ChannelOutsideGuildError).channel).toBe('thread')
  })

  it('refuses a channel that is not a guild channel at all (a DM)', async () => {
    const { client: c } = client({ 'tc-1': null })
    await expect(resolveSessionChannels(c, req(), logger)).rejects.toBeInstanceOf(ChannelOutsideGuildError)
  })

  it('an unreadable text channel is not used: the voice channel stands in, as when none is named', async () => {
    const { client: c } = client({})
    await expect(resolveSessionChannels(c, req(), logger)).resolves.toEqual({ textChannelId: 'vc-1', threadId: null })
  })

  it('a text channel the client resolves to null is not used either', async () => {
    const { client: c } = client({}, { returnsNull: ['tc-1'] })
    await expect(resolveSessionChannels(c, req(), logger)).resolves.toEqual({ textChannelId: 'vc-1', threadId: null })
  })

  it('an unreadable thread is dropped, so a new one is made', async () => {
    const { client: c } = client({ 'tc-1': GUILD })
    await expect(resolveSessionChannels(c, req({ threadId: 'th-gone' }), logger)).resolves.toEqual({
      textChannelId: 'tc-1',
      threadId: null,
    })
  })

  it('does not fetch the voice channel standing in as the text channel (the join reads it through the guild)', async () => {
    const { client: c, fetch } = client({})
    await expect(resolveSessionChannels(c, req({ textChannelId: 'vc-1' }), logger)).resolves.toEqual({
      textChannelId: 'vc-1',
      threadId: null,
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
