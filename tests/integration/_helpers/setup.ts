/**
 * Shared setup for integration tests. Skip the suite when not explicitly
 * enabled — protects CI / dev machines from accidentally booting a real
 * Discord client.
 */

export const INTEGRATION_ENABLED = process.env.RESESH_INTEGRATION_TESTS_ENABLED === 'true'

/** Dev Den guild — the official testing playground per Hob 2026-05-13. */
export const DEV_DEN_GUILD_ID = '1153767296867770378'

export interface IntegrationEnv {
  discordToken: string
  deepgramApiKey: string
  coreServerUrl: string
  /** Shared bearer used by integration tests to call gateway directly. */
  gatewayBearer: string
  guildId: string
  channelId: string
}

export function getIntegrationEnv(): IntegrationEnv {
  const required = [
    'RESESH_DISCORD_TOKEN',
    'DEEPGRAM_API_KEY',
    'CORE_SERVER_URL',
    'RESESH_GATEWAY_BEARER',
    'RESESH_TEST_CHANNEL_ID',
  ] as const
  const missing = required.filter((k) => !process.env[k])
  if (missing.length > 0) {
    throw new Error(`integration env missing: ${missing.join(', ')}`)
  }
  return {
    discordToken: process.env.RESESH_DISCORD_TOKEN!,
    deepgramApiKey: process.env.DEEPGRAM_API_KEY!,
    coreServerUrl: process.env.CORE_SERVER_URL!,
    gatewayBearer: process.env.RESESH_GATEWAY_BEARER!,
    guildId: process.env.RESESH_TEST_GUILD_ID ?? DEV_DEN_GUILD_ID,
    channelId: process.env.RESESH_TEST_CHANNEL_ID!,
  }
}

/** describe-or-skip helper. Use as `describeIntegration('foo', () => {...})`. */
export const describeIntegration = INTEGRATION_ENABLED ? describe : describe.skip
