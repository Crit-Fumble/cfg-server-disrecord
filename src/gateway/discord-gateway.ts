/**
 * Discord Gateway — a Discord voice connection that borrows a bot's token.
 *
 * This is NOT the container's own bot. The container is a skill server: it
 * borrows a bot token (the operator's, self-host; the ReSesh bot's,
 * CFG-hosted) purely so it can join voice and capture frames on that bot's
 * behalf. The login is required because `joinVoiceChannel` needs
 * `guild.voiceAdapterCreator`, which only a connected client exposes. The
 * client logs in at boot and stays connected for the container's lifetime.
 *
 * Intents — Guilds + GuildVoiceStates (join voice, receive frames) plus
 * GuildMembers (privileged, display-name resolution) and MessageContent /
 * GuildMessages. The latter two stay because `consent-manager.ts` still
 * handles in-Discord consent-button clicks — consent is intrinsic to the
 * recording skill, the one documented exception to "not a bot". Both
 * privileged intents must be toggled on in the bot's Developer Portal.
 */

import { Client, GatewayIntentBits } from 'discord.js'
import type { Logger } from '../logger.js'

const READY_TIMEOUT_MS = 30_000

/**
 * Boot the Discord client and wait for it to reach the ready state.
 *
 * Resolves once `guilds.cache` is populated so the first voice-join
 * attempt doesn't race the gateway handshake. Rejects if login fails or
 * ready never fires within {@link READY_TIMEOUT_MS}.
 */
export async function startGateway(token: string, logger: Logger): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  })

  client.on('error', (err) => {
    logger.error({ err: err.message }, 'discord client error')
  })

  // Shard lifecycle. discord.js reconnects and RESUMEs shards on its own, so
  // these are deliberately observability-only — nothing here tears the client
  // down. A momentary Discord lapse shows up as
  // shardDisconnect → shardReconnecting → shardResume, and the voice
  // connection recovers separately (see voice-reconnect.ts). Without these
  // lines a blip during a live recording leaves no trace in the logs at all,
  // which is what made the previous drops so hard to diagnose.
  client.on('shardDisconnect', (event, shardId) => {
    logger.warn({ shardId, code: event?.code }, 'discord shard disconnected — awaiting auto-reconnect')
  })
  client.on('shardReconnecting', (shardId) => {
    logger.warn({ shardId }, 'discord shard reconnecting')
  })
  client.on('shardResume', (shardId, replayedEvents) => {
    logger.info({ shardId, replayedEvents }, 'discord shard resumed')
  })
  client.on('shardError', (err, shardId) => {
    logger.error({ shardId, err: err.message }, 'discord shard error — auto-reconnect will follow')
  })

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Discord gateway ready timeout (${READY_TIMEOUT_MS}ms)`)),
      READY_TIMEOUT_MS,
    )
    client.once('clientReady', () => {
      clearTimeout(timeout)
      logger.info({ user: client.user?.tag, id: client.user?.id }, 'discord bot ready')
      resolve()
    })
    client.login(token).catch((err) => {
      clearTimeout(timeout)
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })

  return client
}

/** Tear down the gateway client. Idempotent. */
export async function stopGateway(client: Client, logger: Logger): Promise<void> {
  try {
    await client.destroy()
    logger.info('discord gateway destroyed')
  } catch (err) {
    logger.warn({ err }, 'discord gateway destroy failed')
  }
}
