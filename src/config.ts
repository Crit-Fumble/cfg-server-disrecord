/**
 * cfg-server-disrecord worker configuration — env-driven.
 *
 * The repo used to ship a gateway mode too; that work moved into core-server
 * (services/disrecord/) when the standalone-gateway architecture was retired.
 * Everything here is now the worker container's view: how to reach core-server
 * for SSE opus + transcripts/billing callbacks, and per-session metadata
 * injected by core-server's worker-spawner.
 *
 * No long-lived secrets — every credential the worker sees is per-session
 * and dies with the container.
 */

export interface WorkerConfig {
  /** Worker's installation ID — recordingSession.id; keys all worker callbacks. */
  installationId: string
  /** Owning user — for logging only; billing attribution lives in core-server. */
  userId: string
  /** Discord guild — logging / metadata. */
  guildId: string
  /** Discord voice channel id — logging / metadata. */
  channelId: string
  /** Deepgram pricing route. */
  deepgramMode: 'platform' | 'byok' | 'disabled'
  /** Present only when deepgramMode='byok' — already-decrypted user key. */
  deepgramKey?: string
  /** core-server base URL — used for both SSE opus subscription and callback POSTs. */
  coreServerUrl: string
  /**
   * Per-session JWT minted by core-server at provisioning time.
   * scope='disrecord-worker' + installationId claim + exp; signed with AUTH_SECRET.
   * Gates the SSE subscription AND every callback. The worker holds no other
   * credential.
   */
  coreServerToken: string
  /** Container instance size — drives the bot_container CT rate. */
  size: 'nano' | 'micro' | 'small'
  logLevel: string
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

export function resolveConfig(): WorkerConfig {
  const size = optionalEnv('DISRECORD_SIZE', 'micro') as WorkerConfig['size']
  if (size !== 'nano' && size !== 'micro' && size !== 'small') {
    throw new Error(`Invalid DISRECORD_SIZE: ${size}`)
  }
  return {
    installationId: requireEnv('DISRECORD_INSTALLATION_ID'),
    userId: requireEnv('DISRECORD_USER_ID'),
    guildId: requireEnv('DISRECORD_GUILD_ID'),
    channelId: requireEnv('DISRECORD_CHANNEL_ID'),
    deepgramMode: requireEnv('DISRECORD_DEEPGRAM_MODE') as WorkerConfig['deepgramMode'],
    deepgramKey: process.env.DISRECORD_DEEPGRAM_KEY,
    coreServerUrl: requireEnv('CORE_SERVER_URL'),
    coreServerToken: requireEnv('CORE_SERVER_TOKEN'),
    size,
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
  }
}
