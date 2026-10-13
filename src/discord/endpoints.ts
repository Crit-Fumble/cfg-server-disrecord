/**
 * Where "Discord" is.
 *
 * The container reaches Discord in three places: the REST API, the gateway,
 * and the links it posts for people. Each defaults to Discord itself. An
 * operator can point them at a server that speaks the Discord API (a Spacebar
 * instance, say) with `DISRECORD_DISCORD_API_BASE`,
 * `DISRECORD_DISCORD_GATEWAY_URL` and `DISRECORD_DISCORD_WEB_BASE`.
 *
 * ⚠️ The bot token is sent to the API base and to the gateway. Both are as
 * sensitive as the token itself: set them only to a server you would hand the
 * token to.
 *
 * This moves where the calls go, nothing more. It does not make another
 * server's answers match Discord's.
 */

export const DEFAULT_DISCORD_API_BASE = 'https://discord.com/api'
export const DEFAULT_DISCORD_WEB_BASE = 'https://discord.com'

export interface DiscordEndpoints {
  /** REST base without the version segment: calls go to `<apiBase>/v10/...`. */
  apiBase: string
  /** Gateway address. Absent ⇒ the one `GET /gateway/bot` answers. */
  gatewayUrl?: string
  /** Base of the links to a channel or a message that the container posts. */
  webBase: string
}

/** A link to one message, the way a Discord client addresses it. */
export function messageLink(webBase: string, guildId: string, channelId: string, messageId: string): string {
  return `${webBase}/channels/${guildId}/${channelId}/${messageId}`
}
