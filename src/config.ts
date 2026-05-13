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
  /** core-server base URL for callbacks (billing, transcript persistence). */
  coreServerUrl: string
  /** Shared secret for core-server ↔ resesh HTTP auth. */
  coreServerAuthSecret: string
  /** Docker socket path for spawning worker containers. */
  dockerSocketPath: string
  /** Worker image tag (built from the same repo). */
  workerImageTag: string
  /** Pino log level. */
  logLevel: string
}

export interface WorkerConfig {
  mode: 'worker'
  /** Voice handoff from gateway. */
  voiceToken: string
  voiceSessionId: string
  voiceEndpoint: string
  guildId: string
  channelId: string
  userId: string
  installationId: string
  /** Deepgram pricing route. */
  deepgramMode: 'platform' | 'byok' | 'disabled'
  /** Present only when deepgramMode='byok' (already decrypted by gateway). */
  deepgramKey?: string
  /** core-server URL for transcript persistence + final billing tick. */
  coreServerUrl: string
  coreServerAuthSecret: string
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
      coreServerAuthSecret: requireEnv('CORE_SERVER_AUTH_SECRET'),
      dockerSocketPath: optionalEnv('DOCKER_SOCKET_PATH', '/var/run/docker.sock'),
      workerImageTag: optionalEnv('RESESH_WORKER_IMAGE', 'cfg-resesh:latest'),
      logLevel: optionalEnv('LOG_LEVEL', 'info'),
    }
  }
  return {
    mode: 'worker',
    voiceToken: requireEnv('RESESH_VOICE_TOKEN'),
    voiceSessionId: requireEnv('RESESH_VOICE_SESSION_ID'),
    voiceEndpoint: requireEnv('RESESH_VOICE_ENDPOINT'),
    guildId: requireEnv('RESESH_GUILD_ID'),
    channelId: requireEnv('RESESH_CHANNEL_ID'),
    userId: requireEnv('RESESH_USER_ID'),
    installationId: requireEnv('RESESH_INSTALLATION_ID'),
    deepgramMode: requireEnv('RESESH_DEEPGRAM_MODE') as WorkerConfig['deepgramMode'],
    deepgramKey: process.env.RESESH_DEEPGRAM_KEY,
    coreServerUrl: requireEnv('CORE_SERVER_URL'),
    coreServerAuthSecret: requireEnv('CORE_SERVER_AUTH_SECRET'),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
  }
}
