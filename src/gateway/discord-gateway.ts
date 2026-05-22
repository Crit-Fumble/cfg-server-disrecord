/**
 * Discord Gateway — discord.js Client for the standalone (`serve` mode)
 * recording container.
 *
 * Ported from cfg-core-server's `services/disrecord/disrecord-gateway.ts`.
 * The crucial difference: in core-server the gateway was lazy (logged in
 * on first session, destroyed when idle). In the standalone container the
 * bot logs in at boot and stays connected for the container's lifetime —
 * a self-hosted recording container IS the bot, so there is nothing to be
 * lazy about.
 *
 * Intents — Guilds + GuildVoiceStates (join voice, receive frames) plus
 * GuildMembers (privileged, display-name resolution) and MessageContent /
 * GuildMessages (consent buttons + slash interactions). Both privileged
 * intents must be toggled on in the bot's Developer Portal Bot tab.
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
