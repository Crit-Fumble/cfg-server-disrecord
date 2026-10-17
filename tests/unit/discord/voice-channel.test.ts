/**
 * A voice channel is known by its type.
 *
 * discord.js's `isVoiceBased()` looks for a `bitrate` field, which a server
 * that speaks the Discord API need not send (a Spacebar instance does not).
 * Every voice-channel check in the container goes through this helper instead.
 */

import { ChannelType, Client, VoiceChannel } from 'discord.js'
import { isVoiceChannelType } from '../../../src/discord/voice-channel.js'

describe('isVoiceChannelType', () => {
  it('a voice channel with no bitrate is a voice channel', () => {
    expect(isVoiceChannelType({ type: ChannelType.GuildVoice })).toBe(true)
  })

  it('a stage channel is a voice channel', () => {
    expect(isVoiceChannelType({ type: ChannelType.GuildStageVoice })).toBe(true)
  })

  it('a text channel is not', () => {
    expect(isVoiceChannelType({ type: ChannelType.GuildText })).toBe(false)
  })

  it('a missing channel is not', () => {
    expect(isVoiceChannelType(null)).toBe(false)
    expect(isVoiceChannelType(undefined)).toBe(false)
  })

  it('agrees with the type where discord.js does not: a channel built from a payload with no bitrate', async () => {
    const client = new Client({ intents: [] })
    try {
      const guild = { id: '100000000000000001', client }
      const payload = { id: '200000000000000002', type: ChannelType.GuildVoice, name: 'Table 1', guild_id: guild.id }
      // The library passes its client as a third argument, which the typings leave out.
      const channel = Reflect.construct(VoiceChannel, [guild, payload, client]) as VoiceChannel
      // The reason this helper exists: the library's own check says no.
      expect(channel.isVoiceBased()).toBe(false)
      expect(isVoiceChannelType(channel)).toBe(true)
    } finally {
      await client.destroy()
    }
  })
})
