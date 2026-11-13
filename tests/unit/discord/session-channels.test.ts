/**
 * A recording's text channel and reused thread are held to its own guild
 * (session-channels.ts): another guild's is refused before anything is posted,
 * one that is gone or hidden (Discord's 10003 or 50001) is never used, and any
 * other failure to read one fails the start instead.
 */

import { DiscordAPIError, HTTPError } from 'discord.js'
import { ChannelOutsideGuildError, resolveSessionChannels } from '../../../src/discord/session-channels.js'

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never

const GUILD = 'guild-a'

function discordApiError(code: number, status: number) {
  return new DiscordAPIError({ code, message: `error ${code}` }, code, status, 'GET', 'https://discord.com/api/v10/channels/x', {})
}

/**
 * Channels the fake client knows: id → its guild (null for a DM). Any other id
 * fails with `unknownError` (Discord's 10003 Unknown Channel unless given).
 */
function client(
  known: Record<string, string | null>,
  opts: { returnsNull?: string[]; unknownError?: Error } = {},
) {
  const fetch = jest.fn(async (id: string) => {
    if (opts.returnsNull?.includes(id)) return null
    if (!(id in known)) throw opts.unknownError ?? discordApiError(10003, 404)
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

  it('a text channel that is gone is not used: the voice channel stands in, as when none is named', async () => {
    const { client: c } = client({})
    await expect(resolveSessionChannels(c, req(), logger)).resolves.toEqual({ textChannelId: 'vc-1', threadId: null })
  })

  it('a text channel the bot cannot see (50001 Missing Access) is not used either', async () => {
    const { client: c } = client({}, { unknownError: discordApiError(50001, 403) })
    await expect(resolveSessionChannels(c, req(), logger)).resolves.toEqual({ textChannelId: 'vc-1', threadId: null })
  })

  it('a text channel the client resolves to null is not used either', async () => {
    const { client: c } = client({}, { returnsNull: ['tc-1'] })
    await expect(resolveSessionChannels(c, req(), logger)).resolves.toEqual({ textChannelId: 'vc-1', threadId: null })
  })

  it('a thread that is gone is dropped, so a new one is made', async () => {
    const { client: c } = client({ 'tc-1': GUILD })
    await expect(resolveSessionChannels(c, req({ threadId: 'th-gone' }), logger)).resolves.toEqual({
      textChannelId: 'tc-1',
      threadId: null,
    })
  })

  it('a thread the bot cannot see (50001 Missing Access) is dropped too', async () => {
    const { client: c } = client({ 'tc-1': GUILD }, { unknownError: discordApiError(50001, 403) })
    await expect(resolveSessionChannels(c, req({ threadId: 'th-hidden' }), logger)).resolves.toEqual({
      textChannelId: 'tc-1',
      threadId: null,
    })
  })

  describe('a transient failure fails the start instead of dropping the channel', () => {
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    const transient: [string, Error][] = [
      ['a 5xx HTTPError', new HTTPError(503, 'Service Unavailable', 'GET', 'https://discord.com/api/v10/channels/x', {})],
      ['an AbortError (a timeout)', abort],
      ['a network error', new Error('getaddrinfo EAI_AGAIN discord.com')],
      ['a DiscordAPIError that is not a missing channel', discordApiError(0, 500)],
    ]

    it.each(transient)('the text channel: %s rejects', async (_name, error) => {
      const { client: c } = client({}, { unknownError: error })
      await expect(resolveSessionChannels(c, req(), logger)).rejects.toBe(error)
    })

    it.each(transient)('the thread: %s rejects', async (_name, error) => {
      const { client: c } = client({ 'tc-1': GUILD }, { unknownError: error })
      await expect(resolveSessionChannels(c, req({ threadId: 'th-1' }), logger)).rejects.toBe(error)
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
