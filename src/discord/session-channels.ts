/**
 * The channels a recording posts into, held to the recording's own guild.
 *
 * A start names a voice channel, a text channel (the thread's parent, and where
 * consent prompts go when there is no thread) and, sometimes, a thread to reuse.
 * The worker fetches the text channel and the thread by id alone, through the
 * client, so an id from another guild the bot is in would put the consent
 * prompts, the live transcript and the recording in that guild. They are
 * checked here, once, before the start: a channel never moves between guilds.
 *
 * The check is client.channels.fetch and the fetched channel's guildId, nothing
 * more: no permission is checked.
 *
 *   - Known to be outside the guild (another guild's, or not a guild channel):
 *     the start is refused (ChannelOutsideGuildError).
 *   - Cannot be fetched (the fetch throws or returns nothing): never used.
 *     - The text channel: the voice channel stands in, as when none is named. A
 *       voice channel cannot parent a thread, so unless a thread is reused,
 *       createRecordingThread makes none: consent prompts go to the voice
 *       channel's chat, and no transcript or recording is posted to Discord.
 *     - A thread to reuse: dropped, and a new one is made under the text
 *       channel (none when the voice channel stands in for it).
 *
 * The voice channel needs no check here: the join fetches it through the guild,
 * which refuses a channel of another guild.
 */

import type { Client } from 'discord.js'
import type { Logger } from '../logger.js'

export type SessionChannelKind = 'text channel' | 'thread'

/** A start that names a text channel or a thread outside the recording's guild. */
export class ChannelOutsideGuildError extends Error {
  constructor(public readonly channel: SessionChannelKind) {
    super(`The ${channel} is not in this recording's Discord server`)
    this.name = 'ChannelOutsideGuildError'
  }
}

type Placement = 'in-guild' | 'outside' | 'unreadable'

async function placement(client: Client, channelId: string, guildId: string): Promise<Placement> {
  const channel = await client.channels.fetch(channelId).catch(() => null)
  if (!channel) return 'unreadable'
  const channelGuildId = 'guildId' in channel ? channel.guildId : null
  return channelGuildId === guildId ? 'in-guild' : 'outside'
}

/**
 * The text channel and thread this start may use. Throws ChannelOutsideGuildError
 * when either is known to be another guild's.
 */
export async function resolveSessionChannels(
  client: Client,
  req: { guildId: string; voiceChannelId: string; textChannelId: string; threadId: string | null },
  logger: Logger,
): Promise<{ textChannelId: string; threadId: string | null }> {
  const { guildId, voiceChannelId } = req
  let textChannelId = req.textChannelId
  if (textChannelId !== voiceChannelId) {
    const where = await placement(client, textChannelId, guildId)
    if (where === 'outside') throw new ChannelOutsideGuildError('text channel')
    if (where === 'unreadable') {
      logger.warn({ guildId, textChannelId }, 'text channel could not be read — using the voice channel instead')
      textChannelId = voiceChannelId
    }
  }

  let threadId = req.threadId
  if (threadId) {
    const where = await placement(client, threadId, guildId)
    if (where === 'outside') throw new ChannelOutsideGuildError('thread')
    if (where === 'unreadable') {
      logger.warn({ guildId, threadId }, 'thread to reuse could not be read — a new thread is made instead')
      threadId = null
    }
  }
  return { textChannelId, threadId }
}
