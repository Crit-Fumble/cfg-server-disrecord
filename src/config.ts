/**
 * cfg-resesh configuration — env-driven.
 *
 * Mode-specific configs are validated only when running in that mode. The
 * gateway needs Discord credentials; the worker needs voice handoff tokens.
 */

export type Mode = 'gateway' | 'worker'

export interface GatewayConfig {
  mode: 'gateway'
  /** Discord bot token for client_id 1504164101553656028. */
  discordToken: string
  /** Public key for slash-command interaction signing. */
  discordPublicKey: string
  /** HTTP API port (core-server calls in on this). */
  port: number
  /** core-server base URL (purely informational here — gateway no longer talks to core-server directly; workers do). */
  coreServerUrl: string
  /**
   * Shared bearer that core-server presents when calling the gateway's
   * provisioning + stop + status endpoints. NOT given to worker containers;
   * worker → core-server auth is a per-session JWT minted by core-server.
   */
  gatewayBearer: string
  /** Docker socket path for spawning worker containers. */
  dockerSocketPath: string
  /** Worker image tag (built from the same repo). */
  workerImageTag: string
  /** Pino log level. */
  logLevel: string
}

export interface WorkerConfig {
  mode: 'worker'
  /** Gateway URL (SSE audio stream + control-plane callbacks). */
  gatewayUrl: string
  /** Per-session bearer issued by gateway at spawn time — auths the SSE subscription. */
  sessionToken: string
  /** Worker's ReSesh installation ID — keys transcripts + billing in core-server. */
  installationId: string
  /** Owning user — used for billing attribution. */
  userId: string
  /** Discord guild (for logging / metadata only — gateway owns the voice connection). */
  guildId: string
  /** Discord voice channel id (logging / metadata). */
  channelId: string
  /** Deepgram pricing route. */
  deepgramMode: 'platform' | 'byok' | 'disabled'
  /** Present only when deepgramMode='byok' (already decrypted by gateway). */
  deepgramKey?: string
  /** core-server URL for transcript persistence + billing tick. */
  coreServerUrl: string
  /**
   * Per-session JWT for worker → core-server callbacks. Minted by core-server
   * at provisioning time, scope='resesh-worker' + installationId claim, signed
   * with AUTH_SECRET. Worker can only act on its own installation until expiry.
   */
  coreServerToken: string
  /** Container instance size — drives the bot_container CT rate. */
  size: 'nano' | 'micro' | 'small'
  logLevel: string
}

export type ResolvedConfig = GatewayConfig | WorkerConfig

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

export function resolveConfig(mode: Mode): ResolvedConfig {
  if (mode === 'gateway') {
    return {
      mode: 'gateway',
      discordToken: requireEnv('RESESH_DISCORD_TOKEN'),
      discordPublicKey: requireEnv('RESESH_DISCORD_PUBLIC_KEY'),
      port: Number(optionalEnv('PORT', '4400')),
      coreServerUrl: requireEnv('CORE_SERVER_URL'),
      gatewayBearer: requireEnv('RESESH_GATEWAY_BEARER'),
      dockerSocketPath: optionalEnv('DOCKER_SOCKET_PATH', '/var/run/docker.sock'),
      workerImageTag: optionalEnv('RESESH_WORKER_IMAGE', 'cfg-resesh:latest'),
      logLevel: optionalEnv('LOG_LEVEL', 'info'),
    }
  }
  const size = optionalEnv('RESESH_SIZE', 'micro') as WorkerConfig['size']
  if (size !== 'nano' && size !== 'micro' && size !== 'small') {
    throw new Error(`Invalid RESESH_SIZE: ${size}`)
  }
  return {
    mode: 'worker',
    gatewayUrl: requireEnv('RESESH_GATEWAY_URL'),
    sessionToken: requireEnv('RESESH_SESSION_TOKEN'),
    installationId: requireEnv('RESESH_INSTALLATION_ID'),
    userId: requireEnv('RESESH_USER_ID'),
    guildId: requireEnv('RESESH_GUILD_ID'),
    channelId: requireEnv('RESESH_CHANNEL_ID'),
    deepgramMode: requireEnv('RESESH_DEEPGRAM_MODE') as WorkerConfig['deepgramMode'],
    deepgramKey: process.env.RESESH_DEEPGRAM_KEY,
    coreServerUrl: requireEnv('CORE_SERVER_URL'),
    coreServerToken: requireEnv('CORE_SERVER_TOKEN'),
    size,
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
  }
}
