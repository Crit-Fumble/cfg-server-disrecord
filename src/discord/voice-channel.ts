/**
 * Which channels are voice channels.
 *
 * discord.js's `channel.isVoiceBased()` answers `'bitrate' in channel`: it
 * knows a voice channel by a field Discord happens to send with one. A server
 * that speaks the Discord API without sending that field (a Spacebar instance)
 * gets every voice channel read as "not a voice channel", and a start fails
 * before it tries to join. The channel's `type` is what says it is a voice
 * channel. On Discord both checks pick the same channels.
 */

import { ChannelType, type VoiceBasedChannel } from 'discord.js'

/** True for a voice or a stage channel, known by its type. */
export function isVoiceChannelType(channel: { type: ChannelType } | null | undefined): channel is VoiceBasedChannel {
  return channel?.type === ChannelType.GuildVoice || channel?.type === ChannelType.GuildStageVoice
}
