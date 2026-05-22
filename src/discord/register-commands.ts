/**
 * Global slash-command registration for the standalone container.
 *
 * Run via `disrecord register-commands` — a one-shot, out-of-band step
 * (Discord caches global commands, so this only needs re-running when the
 * command set in `slash-commands.ts` changes).
 */

import { REST, Routes } from 'discord.js'
import { RESESH_COMMANDS } from './slash-commands.js'
import type { Logger } from '../logger.js'

/** Register {@link RESESH_COMMANDS} globally against the bot's application. */
export async function registerCommands(
  token: string,
  clientId: string,
  logger: Logger,
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token)
  await rest.put(Routes.applicationCommands(clientId), { body: RESESH_COMMANDS })
  logger.info({ clientId, commandCount: RESESH_COMMANDS.length }, 'slash commands registered globally')
}
